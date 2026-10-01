const assert = require('node:assert/strict');
const test = require('node:test');

const { createAgentCoreClient } = require('../agentCoreClient');
const {
  createDecisionsApi,
  createDecisionsFromEnv,
  createFallbackDecision,
  buildAgentCoreRequest,
} = require('../decisions');
const { createAttendanceAgentCoreAdapter } = require('../adapter');
const {
  createMockAgentCoreProvider,
  approvalRequiredResponse,
  unavailableError,
  AgentCoreError,
} = require('../mockAgentCore');
const { createUseCaseHelpers, USE_CASES } = require('../useCases');
const { DEFAULT_AGENT_CORE_PROJECT } = require('../constants');
const { normalizeLegacyDecision } = require('../decisionSchema');

test('createDecisionsFromEnv returns null without AGENT_CORE_URL', () => {
  const prevUrl = process.env.AGENT_CORE_URL;
  delete process.env.AGENT_CORE_URL;
  try {
    assert.equal(createDecisionsFromEnv(), null);
  } finally {
    if (prevUrl) process.env.AGENT_CORE_URL = prevUrl;
  }
});

test('buildAgentCoreRequest uses project id and decision type mapping', () => {
  const body = buildAgentCoreRequest({
    projectId: 'rae-attendance-v2',
    useCase: USE_CASES.PR_RISK_REVIEW,
    context: { summary: 'PR scope' },
    question: 'Review PR risk',
  });
  assert.equal(body.project, 'rae-attendance-v2');
  assert.equal(body.decision_type, 'QA_DISPOSITION');
  assert.equal(body.state.use_case, USE_CASES.PR_RISK_REVIEW);
});

test('mock provider returns normalized project decision contract', async () => {
  const mock = createMockAgentCoreProvider();
  const api = createDecisionsApi({ client: mock });
  const result = await api.decide({ useCase: 'architecture_review', context: {} });
  assert.match(result.decision, /Proceed/);
  assert.equal(typeof result.requires_human_approval, 'boolean');
  assert.equal(result.meta.provider, 'mock-agent-core');
});

test('policy forbids production write intents', async () => {
  const mock = createMockAgentCoreProvider();
  const api = createDecisionsApi({ client: mock });
  await assert.rejects(
    () => api.decide({ useCase: 'release_readiness', intent: 'production_db_write' }),
    (err) => err.code === 'AGENT_CORE_FORBIDDEN',
  );
});

test('approval-required Agent Core disposition maps to human approval', async () => {
  const mock = createMockAgentCoreProvider({ response: approvalRequiredResponse() });
  const api = createDecisionsApi({ client: mock });
  const result = await api.decide({ useCase: 'pr_risk_review', context: {} });
  assert.equal(result.disposition, 'REVIEW');
  assert.equal(result.requires_human_approval, true);
});

test('malformed Agent Core response throws AGENT_CORE_MALFORMED_RESPONSE', async () => {
  const mock = createMockAgentCoreProvider({ malformed: true });
  const api = createDecisionsApi({ client: mock });
  await assert.rejects(
    () => api.decide({ useCase: 'architecture_review' }),
    (err) => err.code === 'AGENT_CORE_MALFORMED_RESPONSE',
  );
});

test('timeout from provider surfaces AGENT_CORE_TIMEOUT', async () => {
  const client = createAgentCoreClient({
    baseUrl: 'http://agent-core.test',
    projectId: DEFAULT_AGENT_CORE_PROJECT,
    timeoutMs: 5,
    maxRetries: 0,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }),
  });
  const api = createDecisionsApi({ client });
  await assert.rejects(
    () => api.decide({ useCase: 'architecture_review' }),
    (err) => err.code === 'AGENT_CORE_TIMEOUT',
  );
});

test('unavailable with allowFallback returns deterministic fallback decision', async () => {
  const mock = createMockAgentCoreProvider({ failWith: unavailableError() });
  const api = createDecisionsApi({ client: mock });
  const result = await api.decide({
    useCase: 'migration_planning',
    context: { allowFallback: true },
  });
  assert.equal(result.meta.fallback, true);
  assert.equal(result.requires_human_approval, true);
});

test('adapter unavailable without env config', async () => {
  const prev = process.env.AGENT_CORE_URL;
  delete process.env.AGENT_CORE_URL;
  try {
    const adapter = createAttendanceAgentCoreAdapter();
    assert.equal(adapter.available, false);
    const result = await adapter.evaluate({ task: 'architecture_review' });
    assert.equal(result.requires_human_approval, true);
  } finally {
    if (prev) process.env.AGENT_CORE_URL = prev;
  }
});

test('use case helpers invoke decide with expected use case', async () => {
  const calls = [];
  const mock = createMockAgentCoreProvider({
    response: (body) => {
      calls.push(body.state.use_case);
      return approvalRequiredResponse();
    },
  });
  const api = createDecisionsApi({ client: mock });
  const helpers = createUseCaseHelpers(api);
  await helpers.releaseReadiness({ summary: 'R1' });
  assert.deepEqual(calls, [USE_CASES.RELEASE_READINESS]);
});

test('legacy normalize helper still validates project decision shape', () => {
  const normalized = normalizeLegacyDecision({
    decision: 'ok',
    reasoning_summary: 'because',
    risk: 'low',
    recommended_action: 'continue',
    requires_human_approval: false,
  });
  assert.equal(normalized.decision, 'ok');
});

test('createFallbackDecision never auto-approves risky work', () => {
  const fb = createFallbackDecision('down');
  assert.equal(fb.requires_human_approval, true);
  assert.equal(fb.meta.fallback, true);
});
