const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Same resolution the other suite-level tests use (no __dirname in this eslint config).
const backendRoot = path.resolve(path.dirname(require.resolve('../src/app.js')), '..');

// `auth_logs.event_type` is an ENUM. An event type outside it fails the INSERT under strict SQL mode,
// and the SSO bridge swallows audit failures — so a bad literal means silently un-audited logins.
test('every auth_logs event type the SSO bridge writes is in the migration-009 enum', () => {
  const migration = fs.readFileSync(path.join(backendRoot, '..', 'database', 'migrations', '009_auth_logs.sql'), 'utf8');
  const enumBody = migration.match(/event_type\s+ENUM\(([^)]*)\)/)[1];
  const allowed = new Set([...enumBody.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]));
  assert.ok(allowed.has('login') && allowed.has('failed_login'));

  const bridge = fs.readFileSync(path.join(backendRoot, 'src', 'services', 'sso', 'mjuPortalAdapterBridge.js'), 'utf8');
  const used = [...bridge.matchAll(/eventType:\s*'([a-z_]+)'/g)].map((match) => match[1]);
  assert.ok(used.length >= 2, 'the bridge writes at least a success and a failure event');
  for (const type of used) assert.ok(allowed.has(type), `${type} is not in auth_logs.event_type`);
});
