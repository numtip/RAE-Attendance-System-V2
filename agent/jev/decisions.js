const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { JEV_OPENROUTER_MODEL_LATEST_ALIAS } = require('./constants');
const { createOpenRouterClient } = require('./client');
const { normalizeDecision, buildDecisionSystemPrompt } = require('./decisionSchema');
const { assertAllowedDecisionRequest, applyApprovalGate } = require('./policy');
const { JevError } = require('./errors');

function loadReleaseModelPin() {
  const pinPath = join(__dirname, 'release.config.json');
  if (!existsSync(pinPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(pinPath, 'utf8'));
    return parsed.model && String(parsed.model).trim() ? String(parsed.model).trim() : null;
  } catch {
    return null;
  }
}

function resolveModel() {
  return loadReleaseModelPin() || JEV_OPENROUTER_MODEL_LATEST_ALIAS;
}

function extractAssistantContent(completion) {
  const content = completion?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new JevError('JEV_MALFORMED_RESPONSE', 'Provider returned empty assistant content');
  }
  return content.trim();
}

function parseDecisionContent(content) {
  const jsonStart = content.indexOf('{');
  const jsonEnd = content.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    throw new JevError('JEV_MALFORMED_RESPONSE', 'Assistant content is not JSON');
  }
  let parsed;
  try {
    parsed = JSON.parse(content.slice(jsonStart, jsonEnd + 1));
  } catch (cause) {
    throw new JevError('JEV_MALFORMED_RESPONSE', 'Failed to parse decision JSON', { cause });
  }
  return normalizeDecision(parsed);
}

function createFallbackDecision(reason) {
  return {
    decision: 'Defer to human operator',
    reasoning_summary: reason,
    risk: 'medium',
    recommended_action: 'Complete the step manually in GitHub/CI or request approved VPS access.',
    requires_human_approval: true,
    meta: { fallback: true },
  };
}

function createDecisionsApi({
  client,
  model = resolveModel(),
  temperature = 0.2,
} = {}) {
  if (!client) {
    throw new JevError('JEV_NOT_CONFIGURED', 'Decisions API requires a client or mock provider');
  }

  async function decide({
    useCase,
    intent,
    context = {},
    question,
    providerOptions = {},
  }) {
    assertAllowedDecisionRequest({ intent, context });

    const userContent = JSON.stringify({
      use_case: useCase,
      intent: intent || null,
      question: question || null,
      context,
    });

    try {
      const completion = await client.chatCompletion({
        model: providerOptions.model || model,
        temperature: providerOptions.temperature ?? temperature,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: buildDecisionSystemPrompt() },
          { role: 'user', content: userContent },
        ],
      });
      const raw = extractAssistantContent(completion);
      const normalized = applyApprovalGate(parseDecisionContent(raw), { intent: intent || useCase });
      return {
        ...normalized,
        meta: {
          use_case: useCase,
          model: providerOptions.model || model,
          provider: client.kind,
        },
      };
    } catch (err) {
      if (err instanceof JevError && err.code === 'JEV_MALFORMED_RESPONSE') {
        throw err;
      }
      if (context.allowFallback === true) {
        return createFallbackDecision(err.message || 'Jev provider unavailable');
      }
      throw err;
    }
  }

  return { decide, model };
}

function createJevDecisionsFromEnv(options = {}) {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY ?? '';
  if (options.provider) {
    return createDecisionsApi({ client: createOpenRouterClient({ provider: options.provider }), ...options });
  }
  if (!apiKey) {
    return null;
  }
  return createDecisionsApi({
    client: createOpenRouterClient({ apiKey, fetchImpl: options.fetchImpl }),
    ...options,
  });
}

module.exports = {
  createDecisionsApi,
  createJevDecisionsFromEnv,
  resolveModel,
  createFallbackDecision,
  parseDecisionContent,
};
