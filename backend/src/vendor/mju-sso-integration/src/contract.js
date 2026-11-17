import { SsoError, SSO_ERROR_CODES } from './errors.js';

/**
 * MJU SSO protocol contract — single source of truth for what this repository
 * *believes* about the provider, and how strongly.
 *
 * Read docs/PROVIDER_CONTRACT.md before changing any constant here. A status
 * change is a contract release event (semver), never a code tidy-up.
 */

/** @typedef {'VERIFIED'|'REFERENCE_ONLY'|'UNKNOWN'|'BLOCKED'} ContractStatus */

export const CONTRACT_STATUS = Object.freeze({
  /** Confirmed by the provider in writing, or reproduced against the live provider. */
  VERIFIED: 'VERIFIED',
  /** Derived from a vendor sample or a prior internal record; NOT provider certification. */
  REFERENCE_ONLY: 'REFERENCE_ONLY',
  /** No evidence. Must not be relied on for authorization. */
  UNKNOWN: 'UNKNOWN',
  /** Evidence required but unobtainable without an approval or an external party. */
  BLOCKED: 'BLOCKED',
});

export const CONTRACT_ID = 'mju-sso';
/** Candidate until MJU certifies the protocol in writing. */
export const CONTRACT_VERSION = '1.0.0-rc.6';
export const CONTRACT_OVERALL_STATUS = CONTRACT_STATUS.UNKNOWN;

/**
 * Every requirement the standard depends on, with its evidence status.
 * `docs/PROVIDER_CONTRACT.md` must document each `id`; `tests/docs.test.js` enforces it.
 *
 * @type {ReadonlyArray<{id: string, requirement: string, status: ContractStatus, evidence: string}>}
 */
/** Status of one contract item, or `undefined` when the id is unknown. Used to gate a claim on the
 * item that actually governs it (C-08) instead of on the contract-wide status, which gags every
 * capability until all fourteen items verify. */
export function contractItemStatus(id) {
  return CONTRACT_ITEMS.find((item) => item.id === id)?.status;
}

export const CONTRACT_ITEMS = Object.freeze([
  {
    id: 'C-01',
    requirement: 'Login redirect is GET {signinUrl}?cid=<url-encoded client id>',
    status: CONTRACT_STATUS.REFERENCE_ONLY,
    evidence: 'Vendor prompt + recorded public page (2026-10-01). Not re-verified in this repo.',
  },
  {
    id: 'C-02',
    requirement: 'Callback is GET to the registered URL with a single query field `ac`',
    status: CONTRACT_STATUS.REFERENCE_ONLY,
    evidence: 'Recorded shape; no completed sign-in was ever observed by the standard owner.',
  },
  {
    id: 'C-03',
    requirement: '`ac` is 32 characters, alphanumeric',
    status: CONTRACT_STATUS.UNKNOWN,
    evidence: 'Sources disagree: docs say 32 chars; the reference adapter accepted any printable token.',
  },
  {
    id: 'C-04',
    requirement: '`ac` is single-use and has a bounded lifetime',
    status: CONTRACT_STATUS.UNKNOWN,
    evidence: 'No provider statement. The standard must not depend on it.',
  },
  {
    id: 'C-05',
    requirement: 'Token exchange is POST {tokenUrl} JSON {clientID, code} over TLS',
    status: CONTRACT_STATUS.REFERENCE_ONLY,
    evidence: 'MJU vendor sample (2025-04-08). Sample, not a signed contract.',
  },
  {
    id: 'C-06',
    requirement: 'No client secret is required for the exchange',
    status: CONTRACT_STATUS.UNKNOWN,
    evidence: 'Absent from the sample; absence is not proof.',
  },
  {
    id: 'C-07',
    requirement: 'Exchange response is a JSON object carrying citizenID and profile fields',
    status: CONTRACT_STATUS.REFERENCE_ONLY,
    evidence:
      'Vendor sample property list. The 2026-11-04 administrator answer (S13) states citizenID is the value the university returns; it says nothing about the other profile fields, so this stays REFERENCE_ONLY.',
  },
  {
    id: 'C-08',
    requirement: 'The response names an authoritative, immutable, never-reused subject',
    status: CONTRACT_STATUS.VERIFIED,
    evidence:
      'Written answer dated 2026-11-04 from the MJU SSO administrator (register S13): the subject is `citizenID`, unchanged for the life of the employment relationship, not reusable for another person, present for all three employment types, ranked above the local `HIP USERID`. Promoted under the owner decision recorded in ADR-005 (owner-approved exception replacing the two-reviewer rule), not by two signatures. Residual risk accepted by the owner: no live response has yet been observed to carry `citizenID`, so presence in a real response remains an observation gap (see docs/LIVE_E2E_PLAN.md).',
  },
  {
    id: 'C-09',
    requirement: 'The response is integrity protected beyond TLS',
    status: CONTRACT_STATUS.UNKNOWN,
    evidence: 'No signature field documented.',
  },
  {
    id: 'C-10',
    requirement: 'The provider echoes a `state`/nonce that binds the callback to the request',
    status: CONTRACT_STATUS.REFERENCE_ONLY,
    evidence: 'Negative evidence only: the vendor sample has no state and no echo was observed.',
  },
  {
    id: 'C-11',
    requirement: 'Logout is GET {signoutUrl}?cid=<client id> and ends the provider session',
    status: CONTRACT_STATUS.REFERENCE_ONLY,
    evidence: 'Recorded 302 to the registered after-signout URL. Global logout semantics UNKNOWN.',
  },
  {
    id: 'C-12',
    requirement: 'Documented provider error format and status codes',
    status: CONTRACT_STATUS.UNKNOWN,
    evidence: 'None published.',
  },
  {
    id: 'C-13',
    requirement: 'Written provider confirmation of the whole contract',
    status: CONTRACT_STATUS.BLOCKED,
    evidence: 'Requires the MJU SSO administrator. Owner approval gate MJU_CONTRACT_VERIFIED.',
  },
  {
    id: 'C-14',
    requirement: 'Lawful basis for receiving the Thai citizen ID',
    // Promoted under the owner decision recorded in ADR-005, on the S16 countersignature. Not by two
    // signatures: a second name would be theatre, and ADR-005 says so. The condition is part of the basis,
    // not a footnote to it — the authorisation covers identity verification and the stated testing only.
    status: CONTRACT_STATUS.VERIFIED,
    evidence:
      'Controller-side record dated 2026-11-06 (register S16): a countersigned PDPA confirmation form from the research office\'s system administrator, holding delegated data-controller authority attested by the system owner, citing พระราชบัญญัติคุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562 มาตรา 24(4) with มาตรา 22 and มาตรา 37. The signed original is held outside git (evidence/local/vps190/C14_COUNTERSIGN_2026-11-06.txt, mode 0600, sha256 327af2ee…2d915) and the signer\'s name is withheld by AGENTS.md rule 4. Promoted under the owner decision recorded in ADR-005 and docs/C14_PROMOTION_DECISION.md §7, which accepts five named residual risks — one of them being that this is a single accountable authority relayed through an agent session, not two independent reviews. BINDING CONDITION, recorded in docs/C14_DECISION_RECORD.md §5.2: the data may be used only for identity verification and the testing as specified; students and retirees are outside the scope (ADR-006). This item authorises receiving the value, not performing a live sign-in — that is D-5, a separate record.',
  },
]);

/** Endpoints may only be these origins unless an operator explicitly allowlists more. */
export const PROVIDER_ALLOWED_HOSTS = Object.freeze(['sso.mju.ac.th']);

/**
 * Candidate callback token shape. Deliberately strict: it is the documented
 * shape, and a strict default fails closed if MJU ever sends something else.
 * A deployment whose provider sends a different length must change this with a
 * contract release, not with a lenient regex.
 */
export const AC_PATTERN = /^[A-Za-z0-9]{32}$/;

export const DEFAULT_ENDPOINTS = Object.freeze({
  signinUrl: 'https://sso.mju.ac.th/signin.aspx',
  signoutUrl: 'https://sso.mju.ac.th/signout.aspx',
  tokenUrl: 'https://sso.mju.ac.th/token.aspx',
});

/**
 * Validate an endpoint before it is used for a redirect or a server-to-server call.
 * Rejects credentials in the URL, non-https when required, and hosts outside the allowlist.
 *
 * @param {string} value
 * @param {{requireHttps?: boolean, allowedHosts?: readonly string[]}} [options]
 * @returns {URL}
 */
export function assertTrustedEndpoint(value, { requireHttps = true, allowedHosts = PROVIDER_ALLOWED_HOSTS } = {}) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, { status: 503, message: 'SSO endpoint is not a valid URL' });
  }
  if (url.username || url.password) {
    throw new SsoError(SSO_ERROR_CODES.UNTRUSTED_ENDPOINT, {
      status: 503,
      message: 'SSO endpoint must not contain credentials',
    });
  }
  if (requireHttps && url.protocol !== 'https:') {
    throw new SsoError(SSO_ERROR_CODES.UNTRUSTED_ENDPOINT, {
      status: 503,
      message: 'SSO endpoint must use https',
    });
  }
  if (!allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new SsoError(SSO_ERROR_CODES.UNTRUSTED_ENDPOINT, {
      status: 503,
      message: 'SSO endpoint host is not allowlisted',
    });
  }
  if (url.search || url.hash) {
    throw new SsoError(SSO_ERROR_CODES.UNTRUSTED_ENDPOINT, {
      status: 503,
      message: 'SSO endpoint must not carry a query or fragment',
    });
  }
  return url;
}

/**
 * Build `{signinUrl}?cid=<encoded>`.
 * Only the client id is ever appended; no user-supplied destination is accepted.
 */
export function buildSigninUrl({ signinUrl = DEFAULT_ENDPOINTS.signinUrl, clientId, allowedHosts, requireHttps = true } = {}) {
  assertClientId(clientId);
  const url = assertTrustedEndpoint(signinUrl, { requireHttps, allowedHosts });
  url.searchParams.set('cid', clientId);
  return url.toString();
}

/** Build `{signoutUrl}?cid=<encoded>` (logout). */
export function buildSignoutUrl({ signoutUrl = DEFAULT_ENDPOINTS.signoutUrl, clientId, allowedHosts, requireHttps = true } = {}) {
  assertClientId(clientId);
  const url = assertTrustedEndpoint(signoutUrl, { requireHttps, allowedHosts });
  url.searchParams.set('cid', clientId);
  return url.toString();
}

/** A client id is an opaque registration handle, never a secret. */
export function assertClientId(clientId) {
  if (typeof clientId !== 'string' || clientId.trim() === '') {
    throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, { status: 503, message: 'MJU client id is not configured' });
  }
  if (clientId.length > 128 || !/^[A-Za-z0-9._-]+$/.test(clientId)) {
    throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, { status: 503, message: 'MJU client id is malformed' });
  }
  return clientId;
}

/** Structural readiness check. Does not consult the network. */
export function assertProviderConfig(config = {}) {
  assertClientId(config.clientId);
  assertTrustedEndpoint(config.signinUrl ?? DEFAULT_ENDPOINTS.signinUrl, {
    requireHttps: config.requireHttps !== false,
    allowedHosts: config.allowedHosts ?? PROVIDER_ALLOWED_HOSTS,
  });
  assertTrustedEndpoint(config.signoutUrl ?? DEFAULT_ENDPOINTS.signoutUrl, {
    requireHttps: config.requireHttps !== false,
    allowedHosts: config.allowedHosts ?? PROVIDER_ALLOWED_HOSTS,
  });
  assertTrustedEndpoint(config.tokenUrl ?? DEFAULT_ENDPOINTS.tokenUrl, {
    requireHttps: config.requireHttps !== false,
    allowedHosts: config.allowedHosts ?? PROVIDER_ALLOWED_HOSTS,
  });
  return true;
}

/** Machine-readable contract summary for manifests and onboarding. */
export function contractSummary() {
  const counts = Object.values(CONTRACT_STATUS).reduce((acc, status) => {
    acc[status] = CONTRACT_ITEMS.filter((item) => item.status === status).length;
    return acc;
  }, /** @type {Record<string, number>} */ ({}));
  return {
    id: CONTRACT_ID,
    version: CONTRACT_VERSION,
    status: CONTRACT_OVERALL_STATUS,
    items: CONTRACT_ITEMS.map(({ id, requirement, status }) => ({ id, requirement, status })),
    counts,
    providerCertified: CONTRACT_OVERALL_STATUS === CONTRACT_STATUS.VERIFIED,
  };
}
