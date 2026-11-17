#!/usr/bin/env node
/**
 * Read-only MJU SSO configuration preflight for RAE Attendance System V2.
 *
 * Inspects environment variables against the shared `@mju/sso-integration` (`v1.0.0-rc.6`) contract
 * and RAE V2's production gates without contacting MJU and without printing any secret or key.
 *
 * Exit codes:
 *   0 — SSO portal mode is structurally ready for the target NODE_ENV
 *   1 — SSO is disabled or one or more readiness gates failed
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const { assertNotSampleClientId } = require(join(
  root,
  'backend',
  'src',
  'services',
  'sso',
  'ssoSignout.js',
));
const { isPrivateOrLoopbackHost } = require(join(
  root,
  'backend',
  'src',
  'services',
  'sso',
  'mjuPortalAdapterBridge.js',
));

const standardUrl = pathToFileURL(
  join(root, 'backend', 'src', 'vendor', 'mju-sso-integration', 'src', 'index.js'),
).href;
const riskAcceptanceUrl = pathToFileURL(
  join(root, 'backend', 'src', 'vendor', 'mju-sso-integration', 'src', 'riskAcceptance.js'),
).href;
const [standardIndex, riskAcceptanceMod] = await Promise.all([
  import(standardUrl),
  import(riskAcceptanceUrl),
]);
const standard = {
  ...standardIndex,
  loadOwnerRiskAcceptance: riskAcceptanceMod.loadOwnerRiskAcceptance,
};

export function evaluateSsoPreflight(env = process.env) {
  const blockers = [];
  const residualRisks = [];

  const nodeEnv = String(env.NODE_ENV || 'development').trim();
  const isProd = nodeEnv.toLowerCase() === 'production';
  const enabled = env.SSO_ENABLED === 'true';
  const callbackConfirmed = env.SSO_CALLBACK_CONFIRMED === 'true';
  const provider = String(env.SSO_PROVIDER || 'http').trim().toLowerCase();
  const clientId = String(env.SSO_CLIENT_ID || env.MJU_CLIENT_ID || '').trim();
  const signinUrl = String(env.SSO_SIGNIN_URL || env.MJU_SSO_SIGNIN_URL || '').trim();
  const signoutUrl = String(env.SSO_SIGNOUT_URL || env.MJU_SSO_SIGNOUT_URL || '').trim();
  const tokenUrl = String(env.SSO_TOKEN_URL || env.MJU_SSO_TOKEN_URL || '').trim();
  const requireHttps =
    String(env.SSO_REQUIRE_HTTPS ?? env.MJU_SSO_REQUIRE_HTTPS ?? 'true')
      .trim()
      .toLowerCase() !== 'false';
  const allowUnverifiedContract =
    env.SSO_ALLOW_UNVERIFIED_CONTRACT === 'true' ||
    env.MJU_SSO_ALLOW_UNVERIFIED_CONTRACT === 'true';
  const ownerRiskAcceptance = String(
    env.SSO_OWNER_RISK_ACCEPTANCE || env.MJU_SSO_OWNER_RISK_ACCEPTANCE || '',
  ).trim();
  const subjectClaim = String(
    env.SSO_SUBJECT_CLAIM || env.MJU_SSO_SUBJECT_CLAIM || 'citizenID',
  ).trim();
  const appId = String(
    env.SSO_APP_ID || env.MJU_SSO_APP_ID || 'rae-attendance-v2',
  ).trim();
  const hmacKey = String(env.SSO_HMAC_KEY || env.MJU_SSO_HMAC_KEY || '').trim();
  const lawfulBasisApproved =
    env.SSO_LAWFUL_BASIS_APPROVED === 'true' ||
    env.MJU_SSO_LAWFUL_BASIS_APPROVED === 'true';
  const allowedHostsRaw = String(
    env.SSO_ALLOWED_HOSTS || env.MJU_SSO_ALLOWED_HOSTS || '',
  ).trim();
  const allowedHosts = allowedHostsRaw
    ? allowedHostsRaw.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
    : [...standard.PROVIDER_ALLOWED_HOSTS];
  const attemptStore = String(env.SSO_LOGIN_ATTEMPT_STORE || '').trim().toLowerCase();

  if (!enabled) blockers.push('SSO_DISABLED: SSO_ENABLED is not "true"');
  if (!callbackConfirmed) blockers.push('SSO_NOT_READY: SSO_CALLBACK_CONFIRMED is not "true"');
  if (provider !== 'portal' && provider !== 'mju') {
    blockers.push(`SSO_PROVIDER_MISMATCH: expected SSO_PROVIDER=portal (got "${provider}")`);
  }

  try {
    assertNotSampleClientId(clientId);
  } catch (err) {
    blockers.push(`${err.code || 'SSO_CLIENT_ID_INVALID'}: ${err.message}`);
  }

  if (!signinUrl || !signoutUrl || !tokenUrl) {
    blockers.push('SSO_ENDPOINTS_MISSING: SSO_SIGNIN_URL, SSO_SIGNOUT_URL, and SSO_TOKEN_URL are required');
  } else {
    try {
      standard.assertProviderConfig({
        clientId: /^[0-9a-f]{32}$/i.test(clientId) ? clientId : 'a'.repeat(32),
        signinUrl,
        signoutUrl,
        tokenUrl,
        allowedHosts,
        requireHttps: isProd ? true : requireHttps,
      });
    } catch (err) {
      blockers.push(`${err.code || 'SSO_CONFIG_INVALID'}: ${err.message}`);
    }
  }

  if (isProd) {
    if (!requireHttps) {
      blockers.push('SSO_CONFIG_INVALID: SSO_REQUIRE_HTTPS cannot be false in production');
    }
    if (attemptStore === 'memory') {
      blockers.push('CONFIG_ERROR: SSO_LOGIN_ATTEMPT_STORE=memory is refused in production; use mariadb');
    }
    for (const host of allowedHosts) {
      if (isPrivateOrLoopbackHost(host)) {
        blockers.push('SSO_UNTRUSTED_ENDPOINT: private/loopback allowed host is refused in production');
        break;
      }
    }
  }

  const contract = standard.contractSummary();
  if (!contract.providerCertified) {
    if (!allowUnverifiedContract) {
      blockers.push(
        'SSO_NOT_READY: contract overall status is UNKNOWN (C-13 BLOCKED); set SSO_ALLOW_UNVERIFIED_CONTRACT=true for staging',
      );
    } else if (isProd) {
      try {
        standard.loadOwnerRiskAcceptance(ownerRiskAcceptance);
        residualRisks.push(
          'production is operating under a recorded owner risk acceptance (providerCertified=false)',
        );
      } catch (err) {
        blockers.push(`${err.code || 'SSO_CONFIG_INVALID'}: ${err.message}`);
      }
    } else {
      residualRisks.push(
        'staging runs with SSO_ALLOW_UNVERIFIED_CONTRACT=true while C-13 remains BLOCKED',
      );
    }
  }

  if (standard.isConfidentialClaim(subjectClaim)) {
    if (!lawfulBasisApproved) {
      blockers.push(
        `SSO_CONFIG_INVALID: subjectClaim=${subjectClaim} requires SSO_LAWFUL_BASIS_APPROVED=true (C-14)`,
      );
    }
    const keyBytes = Buffer.byteLength(hmacKey, 'utf8');
    if (keyBytes < standard.SUBJECT_KEY_MIN_BYTES) {
      blockers.push(
        `SSO_CONFIG_INVALID: SSO_HMAC_KEY must be at least ${standard.SUBJECT_KEY_MIN_BYTES} bytes`,
      );
    }
    if (!appId) {
      blockers.push('SSO_CONFIG_INVALID: SSO_APP_ID must be non-empty');
    }
  }

  residualRisks.push(
    'C-10: MJU does not echo OAuth state; login CSRF is bounded by single-use browser binding cookie, not closed',
  );

  return {
    ready: blockers.length === 0,
    mode: provider,
    environment: nodeEnv,
    adapterVersion: standard.ADAPTER_VERSION,
    contractVersion: standard.CONTRACT_VERSION,
    providerCertified: contract.providerCertified,
    subjectClaim,
    hmacKeyConfigured: Buffer.byteLength(hmacKey, 'utf8') >= standard.SUBJECT_KEY_MIN_BYTES,
    lawfulBasisApproved,
    blockers,
    residualRisks,
  };
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  const report = evaluateSsoPreflight(process.env);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ready ? 0 : 1;
}
