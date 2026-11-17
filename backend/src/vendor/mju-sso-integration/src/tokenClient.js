import { SsoError, SSO_ERROR_CODES } from './errors.js';
import { assertTrustedEndpoint } from './contract.js';

/** Total budget for the server-to-server exchange. */
export const DEFAULT_TIMEOUT_MS = 15_000;
/** A JSON identity document is small; anything larger is not a valid answer. */
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Server-side exchange of the callback `ac` for an identity document.
 *
 * Contract position (see docs/PROVIDER_CONTRACT.md, C-05..C-09):
 *   POST {tokenUrl}  Content-Type: application/json  { "clientID": "...", "code": "<ac>" }
 *
 * Deliberate properties:
 *   - never called from the browser
 *   - TLS verification cannot be disabled from here (no agent/TLS options are exposed)
 *   - redirects are refused instead of followed (a redirect is not an identity answer)
 *   - one attempt, no retry: an invalid or expired code must not be retried
 *   - the response body never appears in an error, a log line or a returned value
 *
 * The returned document is an UNTRUSTED assertion. It is not an authenticated
 * identity until `normalizeIdentityAssertion` plus an approved local link accept it.
 */
export function createTokenClient({
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  allowedHosts,
  requireHttps = true,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, {
      status: 500,
      message: 'A fetch implementation is required for the token client',
    });
  }

  return {
    kind: 'mju-token-client',

    /**
     * @param {{tokenUrl: string, clientId: string, code: string}} input
     * @returns {Promise<Record<string, unknown>>} the raw, still-untrusted JSON object
     */
    async exchange({ tokenUrl, clientId, code }) {
      // Guard the destination before any request exists.
      const url = assertTrustedEndpoint(tokenUrl, { requireHttps, allowedHosts });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url.toString(), {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ clientID: clientId, code }),
          redirect: 'error',
          credentials: 'omit',
          signal: controller.signal,
        });

        // Read with a hard cap so a hostile/huge response cannot exhaust memory.
        const text = await readBoundedText(response, maxResponseBytes);

        if (response.status >= 400 && response.status < 500) {
          throw new SsoError(SSO_ERROR_CODES.CODE_REJECTED, {
            status: 401,
            message: 'The provider did not accept this login code',
            details: { providerStatus: response.status },
          });
        }
        if (!response.ok) {
          throw new SsoError(SSO_ERROR_CODES.PROVIDER_ERROR, {
            status: 502,
            message: 'The provider exchange failed',
            details: { providerStatus: response.status },
          });
        }

        const contentType = String(response.headers?.get?.('content-type') ?? '');
        if (contentType.toLowerCase().startsWith('text/html')) {
          throw new SsoError(SSO_ERROR_CODES.RESPONSE_INVALID, {
            status: 502,
            message: 'The provider returned a non-JSON document',
          });
        }

        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new SsoError(SSO_ERROR_CODES.RESPONSE_INVALID, {
            status: 502,
            message: 'The provider response is not valid JSON',
          });
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new SsoError(SSO_ERROR_CODES.RESPONSE_INVALID, {
            status: 502,
            message: 'The provider response is not a JSON object',
          });
        }
        return parsed;
      } catch (error) {
        if (error instanceof SsoError) throw error;
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
          throw new SsoError(SSO_ERROR_CODES.PROVIDER_TIMEOUT, {
            status: 504,
            message: 'The provider did not answer in time',
          });
        }
        // Network failure, refused redirect, TLS failure: all fail closed, none leak detail.
        throw new SsoError(SSO_ERROR_CODES.PROVIDER_ERROR, {
          status: 502,
          message: 'The provider is unreachable',
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function readBoundedText(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new SsoError(SSO_ERROR_CODES.RESPONSE_TOO_LARGE, {
      status: 502,
      message: 'The provider response is too large',
    });
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new SsoError(SSO_ERROR_CODES.RESPONSE_TOO_LARGE, { status: 502, message: 'The provider response is too large' });
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new SsoError(SSO_ERROR_CODES.RESPONSE_TOO_LARGE, {
        status: 502,
        message: 'The provider response is too large',
      });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}
