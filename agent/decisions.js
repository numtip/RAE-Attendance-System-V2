const { DEFAULT_AGENT_CORE_PROJECT, USE_CASE_DECISION_TYPES } = require('./constants');
const { createAgentCoreClient } = require('./agentCoreClient');
const { normalizeAgentCoreResponse } = require('./decisionSchema');
const { assertAllowedDecisionRequest, applyApprovalGate } = require('./policy');
const { AgentCoreError } = require('./errors');

function resolveProjectId(options = {}) {
  return options.projectId
    || process.env.AGENT_CORE_PROJECT
    || DEFAULT_AGENT_CORE_PROJECT;
}

function mapUseCaseToDecisionType(useCase) {
  return USE_CASE_DECISION_TYPES[useCase] || 'NEXT_ACTION';
}

function buildAgentCoreRequest({
  projectId,
  useCase,
  intent,
  context = {},
  question,
}) {
  return {
    project: projectId,
    task_id: context.taskId || undefined,
    decision_type: mapUseCaseToDecisionType(useCase),
    state: {
      use_case: useCase,
      intent: intent || null,
      project_context: 'rae-attendance-v2',
      ...context,
    },
    question: {
      type: 'choice',
      instructions: question || `Evaluate ${useCase} for RAE Attendance V2.`,
    },
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

    const requestBody = buildAgentCoreRequest({
      projectId,
      useCase,
      intent,
      context,
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
  const baseUrl = options.baseUrl ?? process.env.AGENT_CORE_URL ?? '';
  if (options.client) {
    return createDecisionsApi({ client: options.client, projectId: options.projectId });
  }
  if (!String(baseUrl).trim()) {
    return null;
  }
  const projectId = resolveProjectId(options);
  const projectToken = options.projectToken ?? process.env.AGENT_CORE_PROJECT_TOKEN ?? '';
  return createDecisionsApi({
    client: createAgentCoreClient({
      baseUrl,
      projectId,
      projectToken,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
    }),
    projectId,
  });
}

module.exports = {
  buildAgentCoreRequest,
  createDecisionsApi,
  createDecisionsFromEnv,
  createFallbackDecision,
  mapUseCaseToDecisionType,
};
