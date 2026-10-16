/**
 * The Agent Core WIRE CONTRACT: what actually gets sent to the gateway.
 *
 * This file exists because 46 passing tests did not catch three defects that made the adapter unable to
 * reach the live service at all (verified against the real gateway on 2026-10-16):
 *
 *   1. a `choice` question was sent WITHOUT `criteria`. The gateway's choiceQuestionSchema requires
 *      criteria with at least two non-empty entries, so every call was rejected with HTTP 400;
 *   2. the Cloudflare Access service-token headers were never sent, so the public edge refused the request
 *      with an HTML 403 before the origin saw it;
 *   3. SUPPORTED_DECISION_TYPES listed `TASK_ROUTE_PROPOSAL`, which is NOT in the gateway enum, so local
 *      validation passed and the gateway answered 400.
 *
 * The existing tests all passed because they asserted the adapter's own shape, never the gateway's schema.
 * These tests assert the gateway's schema. They are offline: `fetch` is injected, no network.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildAgentCoreRequest,
  buildQuestion,
  createDecisionsApi,
  createDecisionsFromEnv,
  DEFAULT_CHOICE_CRITERIA,
  GATEWAY_DECISION_TYPES,
} = require('../decisions');
const { SUPPORTED_DECISION_TYPES, assertSupportedDecisionType } = require('../capabilities');
const { createAgentCoreClient } = require('../agentCoreClient');
const { resolveAgentCoreConfig, describeAgentCoreConfig } = require('../config');
const { USE_CASES } = require('../useCases');

const PROJECT = 'rae-attendance-v2';

function okResponse(body) {
  return {
    ok: true,
    status: 200,
    async text() { return JSON.stringify(body); },
  };
}

// --- 1. the question schema --------------------------------------------------

test('a choice question ALWAYS carries at least two criteria (the 400 defect)', () => {
  const request = buildAgentCoreRequest({ projectId: PROJECT, useCase: USE_CASES.PR_RISK_REVIEW });
  assert.equal(request.question.type, 'choice');
  const keys = Object.keys(request.question.criteria);
  assert.ok(keys.length >= 2, `criteria needs >= 2 entries, got ${keys.length}`);
  for (const key of keys) {
    assert.equal(typeof request.question.criteria[key], 'string');
    assert.ok(request.question.criteria[key].trim().length > 0, `criteria.${key} must be non-empty`);
  }
});

test('every use case produces a schema-valid question', () => {
  for (const useCase of Object.values(USE_CASES)) {
    const request = buildAgentCoreRequest({ projectId: PROJECT, useCase });
    assert.equal(request.question.type, 'choice', `${useCase} must build a choice question`);
    assert.ok(
      Object.keys(request.question.criteria).length >= 2,
      `${useCase} produced too few criteria; the gateway would answer 400`,
    );
    assert.ok(request.question.instructions.trim().length > 0, `${useCase} needs instructions`);
    assert.ok(GATEWAY_DECISION_TYPES.includes(request.decision_type), `${useCase} -> unknown decision_type`);
  }
});

test('a string question still gets default criteria instead of a bare choice', () => {
  const question = buildQuestion('QA_DISPOSITION', 'Is this safe to keep?');
  assert.equal(question.instructions, 'Is this safe to keep?');
  assert.deepEqual(question.criteria, DEFAULT_CHOICE_CRITERIA.QA_DISPOSITION);
  assert.ok(Object.keys(question.criteria).length >= 2);
});

test('a caller-supplied choice with fewer than two criteria is refused LOCALLY, not by the gateway', () => {
  // Failing here costs nothing; failing at the gateway costs a round trip and returns an opaque 400.
  assert.throws(
    () => buildQuestion('QA_DISPOSITION', { type: 'choice', instructions: 'x', criteria: { ONLY: 'one' } }),
    (error) => error.code === 'AGENT_CORE_INVALID_QUESTION',
  );
  assert.throws(
    () => buildQuestion('QA_DISPOSITION', { type: 'choice', instructions: 'x', criteria: {} }),
    (error) => error.code === 'AGENT_CORE_INVALID_QUESTION',
  );
  assert.throws(
    () => buildQuestion('QA_DISPOSITION', { type: 'choice', instructions: 'x' }),
    (error) => error.code === 'AGENT_CORE_INVALID_QUESTION',
  );
  // A blank value does not count as an option.
  assert.throws(
    () => buildQuestion('QA_DISPOSITION', { type: 'choice', instructions: 'x', criteria: { A: 'a', B: '  ' } }),
    (error) => error.code === 'AGENT_CORE_INVALID_QUESTION',
  );
});

test('a valid caller-supplied choice is passed through unchanged', () => {
  const criteria = { YES: 'do it', NO: 'do not' };
  const question = buildQuestion('NEXT_ACTION', { type: 'choice', instructions: 'Proceed?', criteria });
  assert.deepEqual(question, { type: 'choice', instructions: 'Proceed?', criteria });
});

test('noul and score questions are translated to the gateway field names', () => {
  assert.deepEqual(
    buildQuestion('NEXT_ACTION', {
      type: 'noul', instructions: 'Is it ready?', trueWhen: 'yes', falseWhen: 'no',
    }),
    {
      type: 'noul', instructions: 'Is it ready?', true_when: 'yes', false_when: 'no',
    },
  );
  assert.deepEqual(
    buildQuestion('NEXT_ACTION', { type: 'score', instructions: 'Rate it', levels: ['low', 'mid', 'high'] }),
    { type: 'score', instructions: 'Rate it', levels: ['low', 'mid', 'high'] },
  );
  // score allows 2..6 levels only.
  assert.throws(
    () => buildQuestion('NEXT_ACTION', { type: 'score', instructions: 'x', levels: ['only'] }),
    (error) => error.code === 'AGENT_CORE_INVALID_QUESTION',
  );
  assert.throws(
    () => buildQuestion('NEXT_ACTION', {
      type: 'score', instructions: 'x', levels: ['1', '2', '3', '4', '5', '6', '7'],
    }),
    (error) => error.code === 'AGENT_CORE_INVALID_QUESTION',
  );
  assert.throws(
    () => buildQuestion('NEXT_ACTION', { type: 'noul', instructions: 'x' }),
    (error) => error.code === 'AGENT_CORE_INVALID_QUESTION',
  );
  assert.throws(
    () => buildQuestion('NEXT_ACTION', { type: 'bogus' }),
    (error) => error.code === 'AGENT_CORE_INVALID_QUESTION',
  );
});

// --- 2. the decision_type enum ----------------------------------------------

test('the supported decision types match the gateway enum exactly', () => {
  // Mirrors agent-core src/schemas.ts decisionTypeSchema.
  assert.deepEqual([...SUPPORTED_DECISION_TYPES].sort(), [...GATEWAY_DECISION_TYPES].sort());
  assert.equal(SUPPORTED_DECISION_TYPES.length, 8);
  // The value that used to be here does not exist in the gateway enum.
  assert.equal(SUPPORTED_DECISION_TYPES.includes('TASK_ROUTE_PROPOSAL'), false);
});

test('assertSupportedDecisionType accepts every gateway type and refuses anything else', () => {
  for (const type of GATEWAY_DECISION_TYPES) {
    assert.equal(assertSupportedDecisionType(type), true, type);
  }
  for (const bogus of ['TASK_ROUTE_PROPOSAL', 'NONSENSE', '', null, undefined]) {
    assert.throws(
      () => assertSupportedDecisionType(bogus),
      (error) => error.code === 'AGENT_CORE_UNSUPPORTED_DECISION_TYPE',
    );
  }
});

// --- 3. the Cloudflare Access headers (the 403 defect) ----------------------

test('the Access service-token headers ARE sent when configured', async () => {
  const seen = [];
  const client = createAgentCoreClient({
    baseUrl: 'https://gateway.invalid',
    projectId: PROJECT,
    projectToken: 'project-token-value',
    cfAccessClientId: 'cf-client-id-value',
    cfAccessClientSecret: 'cf-client-secret-value',
    fetchImpl: async (url, init) => {
      seen.push(init.headers);
      return okResponse({ ok: true });
    },
  });
  await client.postDecision({ project: PROJECT });

  assert.equal(seen.length, 1);
  const headers = seen[0];
  assert.equal(headers['CF-Access-Client-Id'], 'cf-client-id-value');
  assert.equal(headers['CF-Access-Client-Secret'], 'cf-client-secret-value');
  assert.equal(headers['x-agent-project-token'], 'project-token-value');
  assert.equal(headers['x-agent-project'], PROJECT);
});

test('no Access headers are sent when they are not configured', async () => {
  const seen = [];
  const client = createAgentCoreClient({
    baseUrl: 'https://gateway.invalid',
    projectId: PROJECT,
    projectToken: 'project-token-value',
    fetchImpl: async (url, init) => {
      seen.push(init.headers);
      return okResponse({ ok: true });
    },
  });
  await client.postDecision({ project: PROJECT });
  const headers = seen[0];
  assert.equal('CF-Access-Client-Id' in headers, false, 'must not invent an empty Access header');
  assert.equal('CF-Access-Client-Secret' in headers, false);
});

test('a non-JSON 403 is reported as an EDGE refusal, not a malformed response', async () => {
  const client = createAgentCoreClient({
    baseUrl: 'https://gateway.invalid',
    projectId: PROJECT,
    projectToken: 't',
    maxRetries: 0,
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      async text() { return '<html>Cloudflare: forbidden</html>'; },
    }),
  });
  await assert.rejects(
    () => client.postDecision({ project: PROJECT }),
    (error) => error.code === 'AGENT_CORE_EDGE_FORBIDDEN' && error.status === 403,
  );
});

test('an HTML failure that is not 403 stays a malformed response', async () => {
  const client = createAgentCoreClient({
    baseUrl: 'https://gateway.invalid',
    projectId: PROJECT,
    projectToken: 't',
    maxRetries: 0,
    fetchImpl: async () => ({
      ok: false,
      status: 502,
      async text() { return '<html>bad gateway</html>'; },
    }),
  });
  await assert.rejects(
    () => client.postDecision({ project: PROJECT }),
    (error) => error.code === 'AGENT_CORE_MALFORMED_RESPONSE' && error.status === 502,
  );
});

// --- config plumbing ---------------------------------------------------------

test('the Access pair resolves from env and only as a boolean in diagnostics', () => {
  const config = resolveAgentCoreConfig({
    AGENT_CORE_URL: 'https://gateway.invalid',
    AGENT_CORE_CF_CLIENT_ID: 'cf-id',
    AGENT_CORE_CF_CLIENT_SECRET: 'cf-secret',
  });
  assert.equal(config.cfAccessPresent, true);
  const described = describeAgentCoreConfig(config);
  assert.equal(described.cfAccessPresent, true);
  const serialized = JSON.stringify(described);
  assert.equal(serialized.includes('cf-secret'), false, 'the Access secret must never appear in diagnostics');
  assert.equal(serialized.includes('cf-id'), false);

  const absent = resolveAgentCoreConfig({ AGENT_CORE_URL: 'https://gateway.invalid' });
  assert.equal(absent.cfAccessPresent, false);
  assert.equal(describeAgentCoreConfig(absent).cfAccessPresent, false);
});

test('an incomplete Access pair counts as absent, so no half-configured header is sent', () => {
  const onlyId = resolveAgentCoreConfig({
    AGENT_CORE_URL: 'https://x.invalid',
    AGENT_CORE_CF_CLIENT_ID: 'cf-id',
  });
  assert.equal(onlyId.cfAccessPresent, false);
  const onlySecret = resolveAgentCoreConfig({
    AGENT_CORE_URL: 'https://x.invalid',
    AGENT_CORE_CF_CLIENT_SECRET: 'cf-secret',
  });
  assert.equal(onlySecret.cfAccessPresent, false);
});

// --- end to end, injected fetch ---------------------------------------------

test('a full decide sends a gateway-valid body and only touches /v1/decision', async () => {
  const calls = [];
  const client = {
    kind: 'recording',
    async postDecision(body) {
      calls.push(body);
      return {
        decision_type: body.decision_type,
        result: 'REVIEW',
        confidence: 0.9,
        reason_code: null,
        fallback: false,
        disposition: 'EXECUTE',
        provider_request_id: 'req-1',
      };
    },
  };
  const decisions = createDecisionsApi({ client, projectId: PROJECT });
  const result = await decisions.decide({ useCase: USE_CASES.PR_RISK_REVIEW, context: { summary: 'synthetic' } });

  assert.equal(calls.length, 1);
  const body = calls[0];
  assert.equal(body.project, PROJECT);
  assert.equal(body.decision_type, 'QA_DISPOSITION');
  assert.equal(body.question.type, 'choice');
  assert.ok(Object.keys(body.question.criteria).length >= 2, 'the recorded body must be gateway-valid');
  assert.equal(typeof body.state, 'object');
  assert.equal(result.disposition, 'EXECUTE');
  assert.equal(result.confidence, 0.9);
});

test('createDecisionsFromEnv wires the Access pair through to the client', async () => {
  const seen = [];
  const decisions = createDecisionsFromEnv({
    env: {
      AGENT_CORE_URL: 'https://gateway.invalid',
      AGENT_CORE_PROJECT: PROJECT,
      AGENT_CORE_PROJECT_TOKEN: 'project-token-value',
      AGENT_CORE_CF_CLIENT_ID: 'cf-id',
      AGENT_CORE_CF_CLIENT_SECRET: 'cf-secret',
    },
    fetchImpl: async (url, init) => {
      seen.push(init.headers);
      return okResponse({
        decision_type: 'QA_DISPOSITION',
        result: 'ok',
        confidence: 0.8,
        reason_code: null,
        fallback: false,
        disposition: 'REVIEW',
        provider_request_id: null,
      });
    },
  });
  await decisions.decide({ useCase: USE_CASES.PR_RISK_REVIEW });
  assert.equal(seen[0]['CF-Access-Client-Id'], 'cf-id');
  assert.equal(seen[0]['CF-Access-Client-Secret'], 'cf-secret');
});
