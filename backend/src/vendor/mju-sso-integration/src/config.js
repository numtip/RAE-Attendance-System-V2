import { SsoError, SSO_ERROR_CODES } from './errors.js';
import { CONTRACT_OVERALL_STATUS, CONTRACT_STATUS, DEFAULT_ENDPOINTS, PROVIDER_ALLOWED_HOSTS } from './contract.js';
import { loadOwnerRiskAcceptance } from './riskAcceptance.js';

/**
 * Environment → adapter configuration.
 *
 * One place decides what a deployment is allowed to say about itself, so every
 * consumer configures the same knobs with the same names.
 *
 * Two rules are enforced here and cannot be relaxed by a flag:
 *   - `allowUnverifiedContract` is refused in production unless a named owner acceptance record
 *     covers every contract item that still lacks provider evidence (see `riskAcceptance.js`);
 *     the acceptance is a recorded decision, never a certification;
 *   - the client id and endpoints are validated structurally before use.
 */

export const ENV_KEYS = Object.freeze({
  enabled: 'MJU_SSO_ENABLED',
  clientId: 'MJU_CLIENT_ID',
  signinUrl: 'MJU_SSO_SIGNIN_URL',
  signoutUrl: 'MJU_SSO_SIGNOUT_URL',
  tokenUrl: 'MJU_SSO_TOKEN_URL',
  allowedHosts: 'MJU_SSO_ALLOWED_HOSTS',
  requireHttps: 'MJU_SSO_REQUIRE_HTTPS',
  postLoginRedirect: 'MJU_SSO_POST_LOGIN_REDIRECT',
  allowUnverifiedContract: 'MJU_SSO_ALLOW_UNVERIFIED_CONTRACT',
  ownerRiskAcceptance: 'MJU_SSO_OWNER_RISK_ACCEPTANCE',
  timeoutMs: 'MJU_SSO_TIMEOUT_MS',
  caBundle: 'MJU_SSO_CA_BUNDLE',
  subjectClaim: 'MJU_SSO_SUBJECT_CLAIM',
  appId: 'MJU_SSO_APP_ID',
  hmacKey: 'MJU_SSO_HMAC_KEY',
  lawfulBasisApproved: 'MJU_SSO_LAWFUL_BASIS_APPROVED',
});

function bool(value, fallback, key) {
  if (value === undefined || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
    status: 503,
    message: `${key} must be "true" or "false"`,
  });
}

function integer(value, fallback, key) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 120_000) {
    throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
      status: 503,
      message: `${key} must be a positive integer (ms)`,
    });
  }
  return parsed;
}

/**
 * @param {Record<string, string|undefined>} env
 * @param {{nodeEnv?: string}} [context]
 */
export function loadConfig(env = {}, { nodeEnv = env.NODE_ENV ?? 'development' } = {}) {
  const allowUnverifiedContract = bool(
    env[ENV_KEYS.allowUnverifiedContract],
    false,
    ENV_KEYS.allowUnverifiedContract,
  );

  // Production keeps the failing default. The one way through is a written owner acceptance that
  // names every item still lacking evidence; anything less is refused before the service starts.
  const riskAcceptance =
    allowUnverifiedContract && nodeEnv === 'production'
      ? loadOwnerRiskAcceptance(env[ENV_KEYS.ownerRiskAcceptance])
      : undefined;

  const hosts = (env[ENV_KEYS.allowedHosts] ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);

  return {
    riskAcceptance,
    adapter: {
      enabled: bool(env[ENV_KEYS.enabled], false, ENV_KEYS.enabled),
      allowUnverifiedContract,
      clientId: env[ENV_KEYS.clientId] ?? '',
      signinUrl: env[ENV_KEYS.signinUrl] || DEFAULT_ENDPOINTS.signinUrl,
      signoutUrl: env[ENV_KEYS.signoutUrl] || DEFAULT_ENDPOINTS.signoutUrl,
      tokenUrl: env[ENV_KEYS.tokenUrl] || DEFAULT_ENDPOINTS.tokenUrl,
      allowedHosts: hosts.length > 0 ? hosts : PROVIDER_ALLOWED_HOSTS,
      requireHttps: bool(env[ENV_KEYS.requireHttps], true, ENV_KEYS.requireHttps),
      postLoginRedirect: env[ENV_KEYS.postLoginRedirect] || '/',
      timeoutMs: integer(env[ENV_KEYS.timeoutMs], 15_000, ENV_KEYS.timeoutMs),
      // Empty means "require the candidate claims to agree" (fail closed). Set it only after
      // MJU names the authoritative subject (contract C-08).
      subjectClaim: (env[ENV_KEYS.subjectClaim] ?? '').trim() || undefined,
      // A confidential claim needs both of these; the adapter refuses rather than falling back.
      appId: (env[ENV_KEYS.appId] ?? '').trim() || undefined,
      hmacKey: (env[ENV_KEYS.hmacKey] ?? '').trim(),
      lawfulBasisApproved: bool(env[ENV_KEYS.lawfulBasisApproved], false, ENV_KEYS.lawfulBasisApproved),
    },
    // Documented for operators. The standard does not read a CA bundle itself; the
    // runtime's TLS trust store must be configured by the deployment.
    transport: {
      caBundle: env[ENV_KEYS.caBundle] || '',
    },
  };
}

/** Redacted, loggable description. Never returns the client id or a secret. */
export function describeConfig(config) {
  const adapter = config?.adapter ?? {};
  return {
    enabled: adapter.enabled === true,
    // Derived from the contract, never from configuration: a deployment cannot describe itself as
    // certified, and a risk acceptance cannot make it so.
    providerCertified: CONTRACT_OVERALL_STATUS === CONTRACT_STATUS.VERIFIED,
    contractStatus: CONTRACT_OVERALL_STATUS,
    clientIdConfigured: typeof adapter.clientId === 'string' && adapter.clientId !== '',
    allowUnverifiedContract: adapter.allowUnverifiedContract === true,
    requireHttps: adapter.requireHttps !== false,
    allowedHosts: adapter.allowedHosts ?? PROVIDER_ALLOWED_HOSTS,
    endpoints: {
      signin: Boolean(adapter.signinUrl),
      signout: Boolean(adapter.signoutUrl),
      token: Boolean(adapter.tokenUrl),
    },
    postLoginRedirect: adapter.postLoginRedirect,
    timeoutMs: adapter.timeoutMs,
    subjectClaim: adapter.subjectClaim ?? null,
    // Presence only, never the value: the key is the highest-value secret in the deployment.
    hmacKeyConfigured: (adapter.hmacKey ?? '') !== '',
    lawfulBasisApproved: adapter.lawfulBasisApproved === true,
  };
}
