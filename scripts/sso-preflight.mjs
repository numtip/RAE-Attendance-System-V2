/**
 * SSO readiness check (read-only, no network, no secret or identity is printed).
 * Usage: node --env-file=.env scripts/sso-preflight.mjs        (exit 0 = ready for a controlled login test)
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const config = require('../backend/src/config');
const { isProduction } = require('../backend/src/services/sso/ssoConfig');

const sso = config.sso;
const set = (value) => Boolean(String(value || '').trim());
const host = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};
const https = (url) => !set(url) || /^https:\/\//i.test(url);

const portal = set(sso.signinUrl);
const oauth = set(sso.authorizationUrl) && set(sso.tokenUrl) && set(sso.userInfoUrl);

const checks = [
  ['SSO_ENABLED=true', sso.enabled === true],
  ['callback URL registered with MJU (SSO_CALLBACK_CONFIRMED, SSO_CALLBACK_URL)', sso.callbackConfirmed === true && set(sso.callbackUrl)],
  ['SSO_CLIENT_ID set', set(sso.clientId)],
  ['OAuth endpoints set (authorize, token, userinfo) - MJU must provide them', oauth],
  ['SSO_CLIENT_SECRET set (only if MJU requires one)', set(sso.clientSecret)],
  ['SSO_PROTOCOL_CONTRACT_CONFIRMED=true (MJU wrote the protocol down)', sso.protocolContractConfirmed === true],
  ['SSO_NATIONAL_ID_CLAIMS names the confirmed citizen-ID claim', set(sso.nationalIdClaims)],
  ['JWT_SECRET set', set(config.jwt.secret)],
  ['EMPLOYEE_IDENTIFIER_HMAC_KEY set (National ID lookups)', set(process.env.EMPLOYEE_IDENTIFIER_HMAC_KEY)],
  ['all SSO endpoints use https when NODE_ENV=production', !isProduction(config) || ['authorizationUrl', 'tokenUrl', 'userInfoUrl', 'callbackUrl'].every((field) => https(sso[field]))],
  ['SSO_PROVIDER is not mock', sso.provider !== 'mock'],
];

const mode = sso.callbackDiagnostic ? 'callback-diagnostic (names/lengths only, no session)' : sso.userinfoProbe ? 'userinfo-probe (masked field manifest, no session)' : portal && !oauth ? 'portal redirect (callback exchange unconfirmed: login disabled)' : 'oauth session';

console.log(JSON.stringify({
  mode,
  hosts: { signin: host(sso.signinUrl), authorize: host(sso.authorizationUrl), token: host(sso.tokenUrl), userinfo: host(sso.userInfoUrl), callback: host(sso.callbackUrl) },
  checks: checks.map(([name, ok]) => ({ name, ok: Boolean(ok) })),
}, null, 2));

const probing = sso.callbackDiagnostic || sso.userinfoProbe;
const required = probing
  ? checks.filter(([name]) => /SSO_ENABLED|callback URL|CLIENT_ID|https|not mock/.test(name))
  : checks.filter(([name]) => !/CLIENT_SECRET/.test(name));
process.exit(required.every(([, ok]) => ok) ? 0 : 1);
