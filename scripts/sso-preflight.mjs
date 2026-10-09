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
const mjuToken = sso.mjuTokenFlow === true; // vendor-sample portal flow: signin.aspx?cid= -> ?ac= -> POST token.aspx {clientID, code}

const checks = [
  ['SSO_ENABLED=true', sso.enabled === true],
  ['callback URL registered with MJU (SSO_CALLBACK_CONFIRMED, SSO_CALLBACK_URL)', sso.callbackConfirmed === true && set(sso.callbackUrl)],
  ['SSO_CLIENT_ID set', set(sso.clientId)],
  ['OAuth endpoints set (authorize, token, userinfo) - MJU must provide them', oauth],
  ['SSO_CLIENT_SECRET set (only if MJU requires one)', set(sso.clientSecret)],
  ['SSO_MJU_TOKEN_FLOW=true with SSO_SIGNIN_URL and SSO_TOKEN_URL (token.aspx) set', mjuToken && portal && set(sso.tokenUrl)],
  ['SSO_SUBJECT_CONTRACT_CONFIRMED=true (OAuth only: MJU confirmed the subject claim)', sso.subjectContractConfirmed === true],
  ['SSO_SUBJECT_CLAIM is humanID or personID (candidate; not an MJU IT certification)', ['humanID', 'personID'].includes(sso.subjectClaim)],
  ['SSO_PROTOCOL_CONTRACT_CONFIRMED=true (OAuth only: MJU wrote the protocol down)', sso.protocolContractConfirmed === true],
  ['SSO_NATIONAL_ID_CLAIMS names the confirmed citizen-ID claim', set(sso.nationalIdClaims)],
  ['JWT_SECRET set', set(config.jwt.secret)],
  ['EMPLOYEE_IDENTIFIER_HMAC_KEY set (National ID lookups)', set(process.env.EMPLOYEE_IDENTIFIER_HMAC_KEY)],
  ['all SSO endpoints use https when NODE_ENV=production', !isProduction(config) || ['authorizationUrl', 'tokenUrl', 'userInfoUrl', 'callbackUrl'].every((field) => https(sso[field]))],
  ['SSO_PROVIDER is not mock', sso.provider !== 'mock'],
];

const mode = mjuToken ? 'mju token flow (signin.aspx?cid= -> ?ac= -> POST token.aspx)' : sso.callbackDiagnostic ? 'callback-diagnostic (names/lengths only, no session)' : sso.userinfoProbe ? 'userinfo-probe (masked field manifest, no session)' : portal && !oauth ? 'portal redirect (callback exchange unconfirmed: login disabled)' : 'oauth session';

const residualRisks = mjuToken ? [
  'subject is a candidate from SSO_SUBJECT_CLAIM (default humanID); MJU IT has not certified it',
  'protocol is vendor-sample evidence; SSO_PROTOCOL_CONTRACT_CONFIRMED is not required and must stay false',
  'MJU does not echo state; browser binding does not bind ac to the exact login',
  'ac replay guard is in-memory and per process',
] : [];

console.log(JSON.stringify({
  mode,
  hosts: { signin: host(sso.signinUrl), authorize: host(sso.authorizationUrl), token: host(sso.tokenUrl), userinfo: host(sso.userInfoUrl), callback: host(sso.callbackUrl) },
  checks: checks.map(([name, ok]) => ({ name, ok: Boolean(ok) })),
  residualRisks,
}, null, 2));

const probing = sso.callbackDiagnostic || sso.userinfoProbe;
const required = probing
  ? checks.filter(([name]) => /SSO_ENABLED|callback URL|CLIENT_ID|https|not mock/.test(name))
  : mjuToken
    ? checks.filter(([name]) => !/CLIENT_SECRET|OAuth endpoints|NATIONAL_ID_CLAIMS|SUBJECT_CONTRACT_CONFIRMED|PROTOCOL_CONTRACT_CONFIRMED/.test(name))
    : checks.filter(([name]) => !/CLIENT_SECRET|MJU_TOKEN_FLOW|SUBJECT_CLAIM/.test(name));
process.exit(required.every(([, ok]) => ok) ? 0 : 1);
