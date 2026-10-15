const assert = require('node:assert/strict');
const test = require('node:test');

const { describeAgentCoreConfig, resolveAgentCoreConfig } = require('../config');
const { FORBIDDEN_PAYLOAD_KEYS, assertNoSensitiveContent, sanitizeContext } = require('../sanitize');
const {
  SUPPORTED_DECISION_TYPES,
  UNAVAILABLE_ENDPOINTS,
  VERIFIED_SCOPES,
  assertSupportedDecisionType,
  assertSupportedPath,
} = require('../capabilities');
const { runCli } = require('../cli');

const FAKE_BASE_URL = 'http://127.0.0.1:8787';
const FAKE_TOKEN = 'test-token-not-real';

function capture() {
  let out = '';
  return {
    write: (chunk) => { out += chunk; },
    get: () => out,
  };
}

/* ---------------------------------- config --------------------------------- */

test('resolveAgentCoreConfig: AGENT_CORE_URL wins over AGENT_PLATFORM_URL', () => {
  const config = resolveAgentCoreConfig({
    AGENT_CORE_URL: FAKE_BASE_URL,
    AGENT_PLATFORM_URL: 'https://platform.example.com',
  });
  assert.equal(config.baseUrl, FAKE_BASE_URL);
  assert.equal(config.source, 'AGENT_CORE_*');
  assert.equal(config.configured, true);
});

test('resolveAgentCoreConfig: AGENT_CORE_PROJECT wins over AGENT_PROJECT', () => {
  const config = resolveAgentCoreConfig({
    AGENT_CORE_PROJECT: 'legacy-project',
    AGENT_PROJECT: 'platform-project',
  });
  assert.equal(config.projectId, 'legacy-project');
  assert.equal(config.projectIdSource, 'AGENT_CORE_*');
});

test('resolveAgentCoreConfig: falls back to the platform project and default', () => {
  const platform = resolveAgentCoreConfig({ AGENT_PROJECT: 'platform-project' });
  assert.equal(platform.projectId, 'platform-project');
  assert.equal(platform.projectIdSource, 'AGENT_PLATFORM_*');

  const fallback = resolveAgentCoreConfig({});
  assert.equal(fallback.projectId, 'rae-attendance-v2');
  assert.equal(fallback.projectIdSource, 'default');
});

test('resolveAgentCoreConfig: configured is false when both URLs are blank', () => {
  const config = resolveAgentCoreConfig({ AGENT_CORE_URL: '   ', AGENT_PLATFORM_URL: '' });
  assert.equal(config.configured, false);
  assert.equal(config.source, 'none');
  assert.equal(config.baseUrl, '');
});

test('resolveAgentCoreConfig: tokenPresent true/false without exposing the token', () => {
  const withToken = resolveAgentCoreConfig({ AGENT_PLATFORM_URL: FAKE_BASE_URL, AGENT_PROJECT_TOKEN: FAKE_TOKEN });
  assert.equal(withToken.tokenPresent, true);
  assert.equal(withToken.projectToken, FAKE_TOKEN);

  const withoutToken = resolveAgentCoreConfig({ AGENT_CORE_URL: FAKE_BASE_URL });
  assert.equal(withoutToken.tokenPresent, false);
  assert.equal(withoutToken.projectToken, '');
});

/* --------------------------- describeAgentCoreConfig ------------------------ */

test('describeAgentCoreConfig strips credentials, path, query and token', () => {
  const config = resolveAgentCoreConfig({
    AGENT_CORE_URL: 'http://user:secretpw@agent-core.example.com:8787/v1/decision?key=abc',
    AGENT_CORE_PROJECT: 'rae-attendance-v2',
    AGENT_CORE_PROJECT_TOKEN: FAKE_TOKEN,
  });
  const safe = describeAgentCoreConfig(config);
  const serialized = JSON.stringify(safe);

  assert.equal(safe.baseUrlHost, 'agent-core.example.com');
  assert.equal(safe.baseUrlIsHttps, false);
  assert.equal(safe.projectId, 'rae-attendance-v2');
  assert.equal(safe.tokenPresent, true);

  assert.ok(!serialized.includes('secretpw'));
  assert.ok(!serialized.includes('/v1/decision'));
  assert.ok(!serialized.includes('key=abc'));
  assert.ok(!serialized.includes(FAKE_TOKEN));
});

test('describeAgentCoreConfig reports https and unparseable hosts', () => {
  const config = resolveAgentCoreConfig({ AGENT_CORE_URL: 'https://agent-core.example.com' });
  const safe = describeAgentCoreConfig(config);
  assert.equal(safe.baseUrlIsHttps, true);
  assert.equal(safe.baseUrlHost, 'agent-core.example.com');

  const broken = describeAgentCoreConfig({ baseUrl: 'not a url', projectId: 'x', source: 'AGENT_CORE_*' });
  assert.equal(broken.baseUrlHost, '<unparseable>');
  assert.equal(broken.baseUrlIsHttps, false);
});

/* -------------------------------- sanitizeContext -------------------------- */

test('sanitizeContext redacts forbidden keys at top level and nested', () => {
  const { value, redactions } = sanitizeContext({
    email: 'top@example.com',
    profile: { nationalId: '1234567890123', label: 'ok' },
  });
  assert.equal(value.email, '<redacted>');
  assert.equal(value.profile.nationalId, '<redacted>');
  assert.equal(value.profile.label, 'ok');
  assert.deepEqual(redactions, ['email', 'profile.nationalId']);
  assert.ok(!JSON.stringify(redactions).includes('top@example.com'));
  assert.ok(!JSON.stringify(redactions).includes('1234567890123'));
});

test('sanitizeContext matches forbidden keys case-insensitively and across separators', () => {
  const { value } = sanitizeContext({ EMPLOYEE_UID: 'x', employeeId: 'y', 'Employee-Id': 'z' });
  assert.equal(value.EMPLOYEE_UID, '<redacted>');
  assert.equal(value.employeeId, '<redacted>');
  assert.equal(value['Employee-Id'], '<redacted>');
});

test('sanitizeContext truncates deep arrays with a dropped-count marker', () => {
  const { value } = sanitizeContext({ items: Array.from({ length: 30 }, (_unused, index) => index) });
  assert.equal(value.items.length, 26);
  assert.equal(value.items[25], '<truncated:5>');
});

test('sanitizeContext truncates long strings to maxStringLength', () => {
  const { value } = sanitizeContext({ note: 'a'.repeat(600) });
  assert.equal(value.note.length, 500);
});

test('sanitizeContext handles cycles without throwing', () => {
  const cyclic = { label: 'x' };
  cyclic.self = cyclic;
  const { value } = sanitizeContext(cyclic);
  assert.equal(value.label, 'x');
  assert.equal(value.self, '<circular>');
});

test('sanitizeContext converts Dates and drops functions', () => {
  const { value } = sanitizeContext({
    when: new Date('2020-01-01T00:00:00.000Z'),
    fn: () => 42,
    keep: true,
  });
  assert.equal(value.when, '2020-01-01T00:00:00.000Z');
  assert.equal(value.keep, true);
  assert.ok(!Object.prototype.hasOwnProperty.call(value, 'fn'));
});

test('sanitizeContext respects maxDepth', () => {
  const { value } = sanitizeContext({ a: { b: { c: { d: 1 } } } }, { maxDepth: 1 });
  assert.equal(value.a.b, '<max-depth>');
});

/* ---------------------------- assertNoSensitiveContent --------------------- */

function expectUnsafe(payload, offendingValue) {
  assert.throws(
    () => assertNoSensitiveContent(payload),
    (err) => {
      assert.equal(err.code, 'AGENT_CORE_PAYLOAD_UNSAFE');
      if (offendingValue != null) {
        assert.ok(!err.message.includes(offendingValue), 'message must not contain the value');
      }
      return true;
    },
  );
}

test('assertNoSensitiveContent passes a clean payload', () => {
  assert.equal(assertNoSensitiveContent({ summary: 'Release 1 schema', count: 3 }), true);
});

test('assertNoSensitiveContent throws for a forbidden key nested inside an array', () => {
  expectUnsafe({ items: [{ email: 'nested@example.com' }] }, 'nested@example.com');
});

test('assertNoSensitiveContent throws for a JWT-looking string', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  expectUnsafe({ note: jwt }, jwt);
});

test('assertNoSensitiveContent throws for an email address', () => {
  expectUnsafe({ contact: 'someone@example.com' }, 'someone@example.com');
});

test('assertNoSensitiveContent throws for a 13-digit run', () => {
  expectUnsafe({ ref: '1234567890123' }, '1234567890123');
});

test('FORBIDDEN_PAYLOAD_KEYS is a frozen list covering the required names', () => {
  assert.ok(Array.isArray(FORBIDDEN_PAYLOAD_KEYS));
  assert.ok(Object.isFrozen(FORBIDDEN_PAYLOAD_KEYS));
  for (const key of ['email', 'nationalId', 'employee_uid', 'token', 'rows', 'csv', 'stack']) {
    assert.ok(FORBIDDEN_PAYLOAD_KEYS.includes(key), `missing ${key}`);
  }
});

/* --------------------------------- capabilities ---------------------------- */

const OUT_OF_SCOPE_PATHS = [
  '/v1/route',
  '/v1/qa',
  '/v2/route',
  '/v2/execute',
  '/v2/capabilities',
  '/v2/rea/route',
  '/v1/subagent',
];

test('capabilities: project scope is decision only', () => {
  assert.equal(VERIFIED_SCOPES.PROJECT, 'rae-attendance-v2');
  assert.deepEqual([...VERIFIED_SCOPES.SCOPES], ['decision']);
  assert.ok(Object.isFrozen(VERIFIED_SCOPES));
});

test('assertSupportedPath allows the decision and health paths', () => {
  assert.equal(assertSupportedPath('/v1/decision'), true);
  assert.equal(assertSupportedPath('/v1/health'), true);
});

test('assertSupportedPath throws AGENT_CORE_UNSUPPORTED_ENDPOINT for every out-of-scope route', () => {
  for (const path of OUT_OF_SCOPE_PATHS) {
    assert.throws(
      () => assertSupportedPath(path),
      (err) => err.code === 'AGENT_CORE_UNSUPPORTED_ENDPOINT',
      `expected throw for ${path}`,
    );
  }
});

test('UNAVAILABLE_ENDPOINTS is data covering every out-of-scope route', () => {
  for (const path of OUT_OF_SCOPE_PATHS) {
    const entry = UNAVAILABLE_ENDPOINTS.find((candidate) => candidate.path === path);
    assert.ok(entry, `missing unavailable endpoint ${path}`);
    assert.equal(typeof entry.requiredScope, 'string');
  }
  assert.ok(Object.isFrozen(UNAVAILABLE_ENDPOINTS));
});

test('assertSupportedDecisionType accepts decision_type values rejected only by route scope', () => {
  assert.equal(assertSupportedDecisionType('QA_DISPOSITION'), true);
  assert.equal(assertSupportedDecisionType('NEXT_ACTION'), true);
  assert.ok(SUPPORTED_DECISION_TYPES.includes('HUMAN_ESCALATION'));
  assert.throws(
    () => assertSupportedDecisionType('BOGUS_TYPE'),
    (err) => err.code === 'AGENT_CORE_UNSUPPORTED_DECISION_TYPE',
  );
});

/* -------------------------------------- cli -------------------------------- */

test('cli: doctor exits 0 with a config summary and no token', async () => {
  const sink = capture();
  const code = await runCli(['doctor'], {
    env: { AGENT_CORE_URL: FAKE_BASE_URL, AGENT_CORE_PROJECT_TOKEN: FAKE_TOKEN },
    write: sink.write,
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(sink.get());
  assert.equal(parsed.config.baseUrlHost, '127.0.0.1');
  assert.equal(parsed.config.tokenPresent, true);
  assert.deepEqual(parsed.verifiedScopes.SCOPES, ['decision']);
  assert.ok(parsed.unavailableEndpoints.some((entry) => entry.path === '/v1/route'));
  assert.ok(!sink.get().includes(FAKE_TOKEN));
});

test('cli: probe reports supported:false with the boundary code and exits 0', async () => {
  const sink = capture();
  const code = await runCli(['probe', '--path', '/v1/route'], { env: {}, write: sink.write });
  assert.equal(code, 0);
  const parsed = JSON.parse(sink.get());
  assert.equal(parsed.supported, false);
  assert.equal(parsed.path, '/v1/route');
  assert.equal(parsed.code, 'AGENT_CORE_UNSUPPORTED_ENDPOINT');
});

test('cli: probe reports supported:true for the decision path', async () => {
  const sink = capture();
  const code = await runCli(['probe', '--path', '/v1/decision'], { env: {}, write: sink.write });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(sink.get()), { supported: true, path: '/v1/decision' });
});

test('cli: decide without a configured base URL returns a deterministic fallback and exits 0', async () => {
  const sink = capture();
  const code = await runCli(['decide', '--use-case', 'architecture_review'], { env: {}, write: sink.write });
  assert.equal(code, 0);
  const parsed = JSON.parse(sink.get());
  assert.equal(parsed.disposition, 'FALLBACK');
  assert.equal(parsed.requires_human_approval, true);
  assert.equal(parsed.meta.fallback, true);
});

test('cli: an unknown command exits 2', async () => {
  const sink = capture();
  const code = await runCli(['bogus'], { env: {}, write: sink.write });
  assert.equal(code, 2);
});

/* ------------------------------ boundary guarantee ------------------------- */

test('the decision path never touches an unsupported endpoint', async () => {
  const recorded = [];
  const fetchImpl = async (url) => {
    recorded.push(String(url));
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          decision_type: 'NEXT_ACTION',
          result: 'Proceed with GitHub-first plan',
          confidence: 0.9,
          reason_code: 'ok',
          fallback: false,
          disposition: 'EXECUTE',
        });
      },
    };
  };

  const sink = capture();
  const code = await runCli(['decide', '--use-case', 'architecture_review', '--summary', 'Release 1 schema'], {
    env: {
      AGENT_CORE_URL: FAKE_BASE_URL,
      AGENT_CORE_PROJECT: 'rae-attendance-v2',
      AGENT_CORE_PROJECT_TOKEN: FAKE_TOKEN,
    },
    write: sink.write,
    fetchImpl,
  });

  assert.equal(code, 0);
  assert.ok(recorded.length >= 1);
  for (const url of recorded) {
    assert.ok(url.endsWith('/v1/decision'), `unexpected endpoint: ${url}`);
  }
  assert.equal(JSON.parse(sink.get()).disposition, 'EXECUTE');
});
