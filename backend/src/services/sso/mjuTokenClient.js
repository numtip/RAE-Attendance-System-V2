const { HttpError } = require('../../utils/httpError');

/**
 * MJU portal code exchange, modelled on MJU's vendor sample (docs/SSO_PROTOCOL_EVIDENCE.md, section "Vendor sample"):
 *   browser -> https://sso.mju.ac.th/signin.aspx?cid=<clientID>
 *   browser -> our callback ?ac=<code>
 *   backend -> POST https://sso.mju.ac.th/token.aspx   Content-Type: application/json   {"clientID": ..., "code": <ac>}
 *   MJU     -> 200 + JSON identity document (citizenID, humanID, personID, ...)
 *
 * This is NOT OAuth/OIDC: no client secret, no grant_type, no redirect_uri, no userinfo call, no `state` echo.
 * The response shape is vendor-sample evidence only; MJU has not confirmed it in writing, so the whole path stays behind
 * SSO_PROTOCOL_CONTRACT_CONFIRMED and SSO_SUBJECT_CONTRACT_CONFIRMED.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

/** Subject claims an operator may select. citizenID is deliberately absent: a National ID is never a stored subject. */
const ALLOWED_SUBJECT_CLAIMS = Object.freeze(['humanID', 'personID']);
const DEFAULT_SUBJECT_CLAIM = 'humanID';
const SUBJECT_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function nonEmptyString(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function createMjuTokenClient({ fetchImpl = global.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!fetchImpl) {
    throw new Error('fetch is required for the MJU token client');
  }

  return {
    kind: 'mju-token',
    /**
     * Redeems the callback `ac` value. Only HTTP 2xx with a JSON object is accepted; everything else fails closed.
     * @returns {Promise<object>} the raw JSON document (never logged, never returned to the browser)
     */
    async redeem({ tokenUrl, clientId, code }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(tokenUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ clientID: clientId, code }),
          redirect: 'error',
          signal: controller.signal,
        });
        const text = await response.text();
        if (response.status >= 400 && response.status < 500) {
          throw new HttpError(401, 'SSO_CODE_INVALID', 'MJU did not accept the login code');
        }
        if (!response.ok) {
          throw new HttpError(502, 'SSO_PROVIDER_ERROR', 'MJU token endpoint failed');
        }
        if (text.length > MAX_RESPONSE_BYTES) {
          throw new HttpError(502, 'SSO_RESPONSE_INVALID', 'MJU response is too large');
        }
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new HttpError(502, 'SSO_RESPONSE_INVALID', 'MJU response is not valid JSON');
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new HttpError(502, 'SSO_RESPONSE_INVALID', 'MJU response is not a JSON object');
        }
        return parsed;
      } catch (err) {
        if (err instanceof HttpError) throw err;
        if (err.name === 'AbortError') {
          throw new HttpError(504, 'SSO_PROVIDER_TIMEOUT', 'MJU token endpoint did not respond in time');
        }
        throw new HttpError(502, 'SSO_PROVIDER_ERROR', 'MJU token endpoint is unreachable');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Validates the exchange result BEFORE any identity lookup or session, and reduces it to the minimum profile:
 * { sub, citizenID }. Names, e-mail, photo and every other field are dropped: they never select an employee, and an
 * e-mail snapshot on the link would lock out a person whose MJU and RAE e-mail differ.
 *
 * Failure classes:
 *  - nothing usable (no subject and no citizenID)  -> 401 SSO_CODE_INVALID (the code did not yield an identity)
 *  - one of the two missing                        -> 502 SSO_RESPONSE_INCOMPLETE
 *  - subject unusable (ac, citizenID, bad shape)   -> 403 SSO_SUBJECT_INVALID
 */
function normalizeMjuIdentityResponse(response, { subjectClaim = DEFAULT_SUBJECT_CLAIM, ac } = {}) {
  if (!ALLOWED_SUBJECT_CLAIMS.includes(subjectClaim)) {
    throw new HttpError(503, 'SSO_NOT_READY', 'SSO_SUBJECT_CLAIM must be humanID or personID');
  }
  const doc = response && typeof response === 'object' && !Array.isArray(response) ? response : {};
  const subject = nonEmptyString(doc[subjectClaim]);
  const citizenID = nonEmptyString(doc.citizenID);

  if (!subject && !citizenID) {
    throw new HttpError(401, 'SSO_CODE_INVALID', 'MJU returned no identity for this login code');
  }
  if (!subject || !citizenID) {
    throw new HttpError(502, 'SSO_RESPONSE_INCOMPLETE', 'MJU response does not contain the required identity fields');
  }
  if (!SUBJECT_PATTERN.test(subject)) {
    throw new HttpError(403, 'SSO_SUBJECT_INVALID', 'MJU subject is not a valid identity proof');
  }
  // The subject is stored in employee_identity_links, so it must never be the callback code or a National ID.
  const subjectDigits = subject.replace(/\D/g, '');
  const sameDigits = subjectDigits.length > 0 && subjectDigits === citizenID.replace(/\D/g, '');
  if (subject === String(ac ?? '') || subject === citizenID || sameDigits) {
    throw new HttpError(403, 'SSO_SUBJECT_INVALID', 'MJU subject is not a valid identity proof');
  }

  return { sub: subject, citizenID };
}

module.exports = {
  createMjuTokenClient,
  normalizeMjuIdentityResponse,
  ALLOWED_SUBJECT_CLAIMS,
  DEFAULT_SUBJECT_CLAIM,
  SUBJECT_PATTERN,
};
