/**
 * @mju/sso-integration — public surface.
 *
 * Framework-independent. Import the pieces a stack needs; there is no framework
 * dependency and no runtime dependency outside Node's standard library.
 */

export {
  CONTRACT_ID,
  CONTRACT_VERSION,
  CONTRACT_STATUS,
  CONTRACT_OVERALL_STATUS,
  CONTRACT_ITEMS,
  AC_PATTERN,
  PROVIDER_ALLOWED_HOSTS,
  DEFAULT_ENDPOINTS,
  assertTrustedEndpoint,
  assertClientId,
  assertProviderConfig,
  buildSigninUrl,
  buildSignoutUrl,
  contractSummary,
  contractItemStatus,
} from './contract.js';

export { SsoError, SSO_ERROR_CODES, toPublicError } from './errors.js';
export { createTokenClient, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_RESPONSE_BYTES } from './tokenClient.js';
export {
  normalizeIdentityAssertion,
  pickProfile,
  CANDIDATE_SUBJECT_CLAIMS,
  PROFILE_ALLOWLIST,
} from './identity.js';
export {
  createMemoryAttemptStore,
  DEFAULT_ATTEMPT_TTL_MS,
  DEFAULT_CODE_TTL_MS,
  DEFAULT_MAX_ENTRIES,
} from './attemptStore.js';
export { createSharedAttemptStore, createReferenceDriver } from './sharedAttemptStore.js';
export { createMemorySessionStore, DEFAULT_SESSION_TTL_MS } from './sessionStore.js';
export { createDurableSessionStore } from './durableSessionStore.js';
export { createFileDriver } from './fileDriver.js';
export { createRedisDriver } from './redisDriver.js';
export { resolveStoreConfig, createStoresFromConfig, STORE_DRIVER, STORE_ENV_KEYS } from './storeConfig.js';
export {
  createCsrfToken,
  verifyCsrf,
  assertCallbackMethod,
  assertLogoutMethod,
} from './csrf.js';
export { parseCallbackQuery } from './callbackQuery.js';
export {
  createRateLimiter,
  assertWithinLimit,
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_RATE_LIMIT_MAX_KEYS,
} from './rateLimit.js';
export {
  SESSION_COOKIE_POLICY,
  ATTEMPT_COOKIE_POLICY,
  assertSessionRotated,
  establishSession,
} from './session.js';
export {
  redact,
  safeEvent,
  stripQuery,
  maskCitizenId,
  isSensitiveKey,
  sanitizeLogValue,
  REDACTED,
} from './redact.js';
export {
  createMjuSsoAdapter,
  assertRelativeRedirect,
  ADAPTER_NAME,
  ADAPTER_VERSION,
  ATTEMPT_COOKIE,
  SESSION_COOKIE,
} from './adapter.js';
export {
  deriveSubjectKey,
  evaluateIdentityLink,
  identityLinkId,
  isConfidentialClaim,
  normalizeEmployeeKey,
  canAutoLink,
  validateLinkRecord,
  validateEmployeeReference,
  CONFIDENTIAL_SUBJECT_CLAIMS,
  SUBJECT_KEY_MIN_BYTES,
  LINK_STATUSES,
  EMPLOYEE_STATUSES,
} from './identityMapping.js';
export { loadConfig, describeConfig, ENV_KEYS } from './config.js';
