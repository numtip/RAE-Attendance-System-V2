const { USE_CASE_DECISION_TYPES } = require('./constants');
const { resolveAgentCoreConfig } = require('./config');
const { createAgentCoreClient } = require('./agentCoreClient');
const { normalizeAgentCoreResponse } = require('./decisionSchema');
const { assertAllowedDecisionRequest, applyApprovalGate } = require('./policy');
const { sanitizeContext, assertNoSensitiveContent } = require('./sanitize');
const { AgentCoreError } = require('./errors');

function resolveProjectId(options = {}) {
  const env = options.env || process.env;
  return resolveAgentCoreConfig(env, options).projectId;
}

function mapUseCaseToDecisionType(useCase) {
  return USE_CASE_DECISION_TYPES[useCase] || 'NEXT_ACTION';
}

/**
 * Default `criteria` per decision type.
 *
 * WHY THIS EXISTS: Agent Core's `choiceQuestionSchema` requires
 *   criteria: z.record(z.string(), z.string().min(1)).refine(v => Object.keys(v).length >= 2)
 * so a `choice` question WITHOUT criteria — or with fewer than two options — is rejected with HTTP 400
 * before any provider call. This adapter previously sent `{ type: 'choice', instructions }` only, so it
 * could never have worked against the real gateway. Verified against the live service on 2026-10-16.
 *
 * The keys are the option labels the model chooses between; the values are what each option means.
 */
const DEFAULT_CHOICE_CRITERIA = Object.freeze({
  NEXT_ACTION: Object.freeze({
    PROCEED: 'the next documented step is safe to take within the existing policy gates',
    STOP: 'stop and obtain explicit human approval before taking any further step',
  }),
  QA_DISPOSITION: Object.freeze({
    EXECUTE: 'the change is safe as-is and needs no further human review',
    REVIEW: 'a human must review this before it can be trusted',
  }),
  HUMAN_ESCALATION: Object.freeze({
    ESCALATE: 'a human owner must decide; the agent must not proceed',
    PROCEED: 'no escalation is needed and the documented step may continue',
  }),
  DEFAULT: Object.freeze({
    PROCEED: 'proceed within the documented policy gates',
    STOP: 'stop and defer to a human owner',
  }),
});

/** Every decision_type the gateway accepts. Mirrors agent-core `decisionTypeSchema` (8 values). */
const GATEWAY_DECISION_TYPES = Object.freeze([
  'TASK_ROUTE',
  'CONTEXT_ROUTE',
  'TOOL_ROUTE',
  'MODEL_ROUTE',
  'SUBAGENT_ROUTE',
  'NEXT_ACTION',
  'QA_DISPOSITION',
  'HUMAN_ESCALATION',
]);

function criteriaForDecisionType(decisionType) {
  return DEFAULT_CHOICE_CRITERIA[decisionType] || DEFAULT_CHOICE_CRITERIA.DEFAULT;
}

/**
 * Build a `question` that satisfies the gateway schema, or throw locally.
 *
 * Failing here rather than shipping a payload the gateway rejects with an opaque 400 is the whole point:
 * a 400 costs a round trip and tells the caller nothing about which field was wrong.
 *
 * Accepts either a string (used as `instructions`, with default criteria) or an explicit object:
 *   { type: 'choice', instructions, criteria }            criteria: >= 2 non-empty entries
 *   { type: 'noul',   instructions, trueWhen, falseWhen }
 *   { type: 'score',  instructions, levels }              levels: 2..6 non-empty entries
 */
function buildQuestion(decisionType, question) {
  if (question && typeof question === 'object') {
    const type = String(question.type || '').trim();
    if (type === 'choice') {
      const instructions = String(question.instructions || '').trim();
      if (!instructions) {
        throw new AgentCoreError('AGENT_CORE_INVALID_QUESTION', 'choice.instructions is required');
      }
      const criteria = question.criteria && typeof question.criteria === 'object' ? question.criteria : {};
      const keys = Object.keys(criteria).filter((key) => String(criteria[key] ?? '').trim() !== '');
      if (keys.length < 2) {
        throw new AgentCoreError(
          'AGENT_CORE_INVALID_QUESTION',
          'choice.criteria must contain at least two non-empty options (the gateway rejects fewer with 400)',
        );
      }
      return { type: 'choice', instructions, criteria: { ...criteria } };
    }
    if (type === 'noul') {
      const instructions = String(question.instructions || '').trim();
      const trueWhen = String(question.trueWhen || question.true_when || '').trim();
      const falseWhen = String(question.falseWhen || question.false_when || '').trim();
      if (!instructions || !trueWhen || !falseWhen) {
        throw new AgentCoreError(
          'AGENT_CORE_INVALID_QUESTION',
          'noul requires instructions, trueWhen and falseWhen',
        );
      }
      return {
        type: 'noul', instructions, true_when: trueWhen, false_when: falseWhen,
      };
    }
    if (type === 'score') {
      const instructions = String(question.instructions || '').trim();
      const levels = Array.isArray(question.levels)
        ? question.levels.map((level) => String(level ?? '').trim()).filter(Boolean)
        : [];
      if (!instructions || levels.length < 2 || levels.length > 6) {
        throw new AgentCoreError(
          'AGENT_CORE_INVALID_QUESTION',
          'score requires instructions and 2..6 levels',
        );
      }
      return { type: 'score', instructions, levels };
    }
    throw new AgentCoreError(
      'AGENT_CORE_INVALID_QUESTION',
      'question.type must be one of choice, noul, score',
    );
  }

  const instructions = String(question || '').trim() || `Evaluate ${decisionType} for RAE Attendance V2.`;
  return {
    type: 'choice',
    instructions,
    criteria: { ...criteriaForDecisionType(decisionType) },
  };
}

function buildAgentCoreRequest({
  projectId,
  useCase,
  intent,
  context = {},
  question,
}) {
  const decisionType = mapUseCaseToDecisionType(useCase);
  return {
    project: projectId,
    task_id: context.taskId || undefined,
    decision_type: decisionType,
    state: {
      use_case: useCase,
      intent: intent || null,
      project_context: 'rae-attendance-v2',
      ...context,
    },
    question: buildQuestion(decisionType, question),
    fallback_result: 'defer_to_human',
  };
}

function createFallbackDecision(reason) {
  return {
    decision: 'Defer to human operator',
    reasoning_summary: reason,
    risk: 'medium',
    recommended_action: 'Complete the step manually in GitHub/CI or request approved VPS access.',
    requires_human_approval: true,
    disposition: 'FALLBACK',
    confidence: 0,
    fallback: true,
    meta: { fallback: true, provider: 'deterministic' },
  };
}

function createDecisionsApi({ client, projectId = resolveProjectId() } = {}) {
  if (!client) {
    throw new AgentCoreError('AGENT_CORE_NOT_CONFIGURED', 'Decisions API requires an Agent Core client or mock');
  }

  async function decide({
    useCase,
    intent,
    context = {},
    question,
  }) {
    assertAllowedDecisionRequest({ intent, context });

    // ENFORCEMENT POINT. Everything sent to Agent Core is sanitized and then verified free of names,
    // identifiers, secrets and raw logs. This lives here, in the single decision path, so no caller (the
    // CLI, a script or a future API hook) can bypass it by passing a context straight through.
    const { value: safeContext } = sanitizeContext(context);
    assertNoSensitiveContent(safeContext);

    const requestBody = buildAgentCoreRequest({
      projectId,
      useCase,
      intent,
      context: safeContext,
      question,
    });

    try {
      const raw = await client.postDecision(requestBody);
      const normalized = applyApprovalGate(
        normalizeAgentCoreResponse(raw),
        { intent: intent || useCase },
      );
      return {
        ...normalized,
        meta: {
          use_case: useCase,
          provider: client.kind,
          project: projectId,
        },
      };
    } catch (err) {
      if (err instanceof AgentCoreError && err.code === 'AGENT_CORE_MALFORMED_RESPONSE') {
        throw err;
      }
      if (context.allowFallback === true) {
        return createFallbackDecision(err.message || 'Agent Core unavailable');
      }
      throw err;
    }
  }

  return { decide, projectId };
}

function createDecisionsFromEnv(options = {}) {
  if (options.client) {
    return createDecisionsApi({ client: options.client, projectId: resolveProjectId(options) });
  }
  const env = options.env || process.env;
  const config = resolveAgentCoreConfig(env, options);
  if (!config.configured) {
    return null;
  }
  return createDecisionsApi({
    client: createAgentCoreClient({
      baseUrl: config.baseUrl,
      projectId: config.projectId,
      projectToken: config.projectToken,
      // Both are empty strings when unset, and the client then sends no Access headers at all.
      cfAccessClientId: config.cfAccessClientId,
      cfAccessClientSecret: config.cfAccessClientSecret,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
    }),
    projectId: config.projectId,
  });
}

module.exports = {
  buildAgentCoreRequest,
  buildQuestion,
  createDecisionsApi,
  createDecisionsFromEnv,
  createFallbackDecision,
  criteriaForDecisionType,
  mapUseCaseToDecisionType,
  DEFAULT_CHOICE_CRITERIA,
  GATEWAY_DECISION_TYPES,
};
