const assert = require('node:assert/strict');
const test = require('node:test');

const { createOpenRouterClient } = require('../client');
const {
  createDecisionsApi,
  createJevDecisionsFromEnv,
  createFallbackDecision,
  parseDecisionContent,
} = require('../decisions');
const {
  createMockOpenRouterProvider,
  malformedJsonResponse,
  missingFieldsResponse,
} = require('../mockProvider');
const { assertAllowedDecisionRequest } = require('../policy');
const { JEV_OPENROUTER_MODEL_LATEST_ALIAS } = require('../constants');
const { resolveModel } = require('../decisions');
const { createUseCaseHelpers, USE_CASES } = require('../useCases');
const { createAgentCoreAdapter } = require('../adapter');
const { JevError } = require('../errors');

test('default model is OpenRouter Jev Latest alias in code', () => {
  assert.equal(JEV_OPENROUTER_MODEL_LATEST_ALIAS, 'openrouter/jev:latest');
  assert.equal(process.env.OPENROUTER_MODEL_JEV, undefined);
});

test('createJevDecisionsFromEnv returns null without API key', () => {
  const prev = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    assert.equal(createJevDecisionsFromEnv(), null);
  } finally {
    if (prev) process.env.OPENROUTER_API_KEY = prev;
  }
});

test('mock provider returns normalized decision contract', async () => {
  const mock = createMockOpenRouterProvider();
  const api = createDecisionsApi({ client: createOpenRouterClient({ provider: mock }) });
  const result = await api.decide({
    useCase: USE_CASES.ARCHITECTURE_REVIEW,
    context: { summary: 'fixture-only API' },
  });
  assert.ok(result.decision);
  assert.ok(result.reasoning_summary);
  assert.match(result.risk, /^(low|medium|high)$/);
  assert.ok(result.recommended_action);
  assert.equal(typeof result.requires_human_approval, 'boolean');
  assert.equal(result.meta.provider, 'mock');
});

test('policy forbids production write intents', () => {
  assert.throws(
    () => assertAllowedDecisionRequest({ intent: 'production_db_write' }),
    (err) => err.code === 'JEV_FORBIDDEN',
  );
});

test('high risk and recovery intents require human approval', async () => {
  const mock = createMockOpenRouterProvider({
    responses: {
      default: JSON.stringify({
        decision: 'Run recovery on copy',
        reasoning_summary: 'Evidence copy exists.',
        risk: 'high',
        recommended_action: 'Follow runbook',
        requires_human_approval: false,
      }),
    },
  });
  const api = createDecisionsApi({ client: createOpenRouterClient({ provider: mock }) });
  const result = await api.decide({
    useCase: USE_CASES.DB_RECOVERY_DECISION,
    intent: 'db_recovery_execute',
    context: { summary: 'orphan ibd' },
  });
  assert.equal(result.requires_human_approval, true);
});

test('malformed JSON response throws JEV_MALFORMED_RESPONSE', async () => {
  const api = createDecisionsApi({
    client: createOpenRouterClient({ provider: malformedJsonResponse() }),
  });
  await assert.rejects(
    () => api.decide({ useCase: 'test', context: {} }),
    (err) => err.code === 'JEV_MALFORMED_RESPONSE',
  );
});

test('missing decision fields throws JEV_MALFORMED_RESPONSE', async () => {
  const api = createDecisionsApi({
    client: createOpenRouterClient({ provider: missingFieldsResponse() }),
  });
  await assert.rejects(
    () => api.decide({ useCase: 'test', context: {} }),
    (err) => err.code === 'JEV_MALFORMED_RESPONSE',
  );
});

test('timeout from provider surfaces JEV_TIMEOUT', async () => {
  const mock = createMockOpenRouterProvider({ delayMs: 50 });
  const api = createDecisionsApi({
    client: createOpenRouterClient({ provider: mock, timeoutMs: 5, maxRetries: 0 }),
  });
  await assert.rejects(
    () => api.decide({ useCase: 'test', context: {} }),
    (err) => err.code === 'JEV_TIMEOUT',
  );
});

test('allowFallback returns structured fallback decision', async () => {
  const mock = createMockOpenRouterProvider({
    failWith: new JevError('JEV_PROVIDER_ERROR', 'down'),
  });
  const api = createDecisionsApi({ client: createOpenRouterClient({ provider: mock }) });
  const result = await api.decide({
    useCase: 'test',
    context: { allowFallback: true },
  });
  assert.equal(result.requires_human_approval, true);
  assert.equal(result.meta.fallback, true);
});

test('parseDecisionContent normalizes camelCase', () => {
  const parsed = parseDecisionContent(JSON.stringify({
    decision: 'ok',
    reasoningSummary: 'short',
    risk: 'low',
    recommendedAction: 'ship',
    requiresHumanApproval: true,
  }));
  assert.equal(parsed.reasoning_summary, 'short');
  assert.equal(parsed.recommended_action, 'ship');
});

test('use case helpers invoke decide with expected use case', async () => {
  const calls = [];
  const api = {
    async decide(req) {
      calls.push(req.useCase);
      return createFallbackDecision('ok');
    },
  };
  const helpers = createUseCaseHelpers(api);
  await helpers.ssoReadinessReview({ summary: 'mock only' });
  assert.equal(calls[0], USE_CASES.SSO_READINESS_REVIEW);
});

test('agent core adapter unavailable without decisions api', async () => {
  const adapter = createAgentCoreAdapter(null);
  assert.equal(adapter.available, false);
  const result = await adapter.evaluate({ task: 'x', context: {} });
  assert.equal(result.requires_human_approval, true);
});

test('resolveModel uses code default when no release pin', () => {
  assert.equal(resolveModel(), JEV_OPENROUTER_MODEL_LATEST_ALIAS);
});
