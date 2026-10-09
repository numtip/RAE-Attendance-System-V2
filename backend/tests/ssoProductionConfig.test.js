const assert = require('node:assert/strict');
const test = require('node:test');
const { createSsoService } = require('../src/services/ssoService');
const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');

function build(configOverrides = {}) {
  const config = {
    env: 'production',
    jwt: { secret: 'test-only-secret', expiresIn: '15m', refreshTokenDays: 14 },
    sso: {
      enabled: true,
      callbackConfirmed: true,
      provider: 'http',
      authorizationUrl: 'https://sso.example.test/authorize',
      tokenUrl: 'https://sso.example.test/token',
      userInfoUrl: 'https://sso.example.test/userinfo',
      clientId: 'synthetic-client',
      clientSecret: 'synthetic-secret',
      callbackUrl: 'https://app.example.test/api/v1/auth/sso/callback',
      scopes: 'openid',
      ...(configOverrides.sso || {}),
    },
    ...(configOverrides.root || {}),
  };
  return createSsoService({ config, repositories: createFixtureRepositories(), oauthProvider: { buildAuthorizationUrl: () => 'https://x.example.test/?state=s' } });
}

test('production refuses the mock SSO provider', async () => {
  await assert.rejects(() => build({ sso: { provider: 'mock' } }).beginLogin(), (e) => e.status === 503 && e.code === 'CONFIG_ERROR' && /mock/.test(e.message));
  await assert.rejects(() => build({ sso: { provider: 'mock' } }).handleCallback({ code: 'x', state: 'y' }), (e) => e.code === 'CONFIG_ERROR');
});

test('production refuses non-https SSO endpoints and names only the field, never the value', async () => {
  const sso = build({ sso: { tokenUrl: 'http://sso.example.test/token', callbackUrl: 'http://app.example.test/cb' } });
  await assert.rejects(() => sso.beginLogin(), (e) => e.code === 'CONFIG_ERROR' && e.message.includes('tokenUrl') && e.message.includes('callbackUrl') && !e.message.includes('example.test'));
});

test('production with https endpoints and a real provider passes the config gate; non-production is unchanged', async () => {
  assert.match(await build().beginLogin(), /^https:/);
  const dev = build({ root: { env: 'development' }, sso: { callbackUrl: 'http://127.0.0.1:3210/cb' } });
  assert.match(await dev.beginLogin(), /^https:/);
});
