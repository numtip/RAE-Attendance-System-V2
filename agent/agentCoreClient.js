const { DECISION_PATH } = require('./constants');
const { AgentCoreError } = require('./errors');

/**
 * Errors that a retry cannot fix, so they must surface unchanged instead of being collapsed into a generic
 * "unavailable". A retry is only sensible for a timeout, a network fault or a 5xx.
 */
const NON_RETRYABLE = new Set([
  'AGENT_CORE_MALFORMED_RESPONSE',
  'AGENT_CORE_PROVIDER_ERROR',
  // An intermediary (Cloudflare Access) refused the request before the gateway saw it. Retrying the same
  // headers will be refused again.
  'AGENT_CORE_EDGE_FORBIDDEN',
]);

function trimBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

function createAgentCoreClient({
  baseUrl,
  projectId,
  projectToken = '',
  cfAccessClientId = '',
  cfAccessClientSecret = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  maxRetries = 1,
} = {}) {
  if (!baseUrl) {
    throw new AgentCoreError('AGENT_CORE_NOT_CONFIGURED', 'AGENT_CORE_URL is not set');
  }
  if (!projectId) {
    throw new AgentCoreError('AGENT_CORE_NOT_CONFIGURED', 'AGENT_CORE_PROJECT is not set');
  }
  if (!fetchImpl) {
    throw new AgentCoreError('AGENT_CORE_NOT_CONFIGURED', 'fetch is not available');
  }

  const root = trimBaseUrl(baseUrl);

  async function postDecision(body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const headers = {
          'content-type': 'application/json',
          'x-agent-project': projectId,
        };
        if (projectToken) {
          headers['x-agent-project-token'] = projectToken;
        }
        // The public edge (Cloudflare Access) requires its own service token IN ADDITION to the project
        // token, and refuses the request before the origin sees it. Without these two headers the caller
        // gets an HTML 403 with no JSON body, which is why the error mapping below names that case.
        if (cfAccessClientId && cfAccessClientSecret) {
          headers['CF-Access-Client-Id'] = cfAccessClientId;
          headers['CF-Access-Client-Secret'] = cfAccessClientSecret;
        }

        const response = await fetchImpl(`${root}${DECISION_PATH}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        const text = await response.text();
        let payload = null;
        if (text) {
          try {
            payload = JSON.parse(text);
          } catch {
            // A non-JSON body is almost always an intermediary, not the gateway: Cloudflare Access answers
            // a request it refuses with an HTML page. Naming that case turns a mystery into a diagnosis,
            // because the fix (send the Access service token) is different from any origin-side fix.
            if (response.status === 403) {
              throw new AgentCoreError(
                'AGENT_CORE_EDGE_FORBIDDEN',
                'the edge refused the request before the gateway saw it; the Cloudflare Access service token is missing or invalid',
                { status: response.status },
              );
            }
            throw new AgentCoreError(
              'AGENT_CORE_MALFORMED_RESPONSE',
              'Agent Core returned non-JSON',
              { status: response.status },
            );
          }
        }

        if (!response.ok) {
          if (response.status === 503) {
            throw new AgentCoreError('AGENT_CORE_UNAVAILABLE', payload?.message || 'Agent Core unavailable');
          }
          throw new AgentCoreError(
            'AGENT_CORE_PROVIDER_ERROR',
            payload?.message || 'Agent Core rejected the request',
            { status: response.status },
          );
        }

        clearTimeout(timer);
        return payload;
      } catch (err) {
        lastError = err;
        if (err instanceof AgentCoreError && NON_RETRYABLE.has(err.code)) {
          // Retrying cannot fix any of these: the request was malformed, the gateway rejected it, or an
          // intermediary refused it. Without this the retry wrapper replaced the specific code with a
          // generic AGENT_CORE_UNAVAILABLE, which hid the real cause from the caller.
          throw err;
        }
        if (err?.name === 'AbortError') {
          throw new AgentCoreError('AGENT_CORE_TIMEOUT', 'Agent Core request timed out');
        }
        if (attempt < maxRetries) {
          continue;
        }
        throw new AgentCoreError('AGENT_CORE_UNAVAILABLE', err?.message || 'Agent Core is unreachable', { cause: err });
      }
    }

    clearTimeout(timer);
    throw lastError;
  }

  return { kind: 'agent-core', postDecision };
}

module.exports = { createAgentCoreClient, trimBaseUrl };
