const { DECISION_PATH } = require('./constants');
const { AgentCoreError } = require('./errors');

function trimBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

function createAgentCoreClient({
  baseUrl,
  projectId,
  projectToken = '',
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
        if (err instanceof AgentCoreError) {
          if (err.code === 'AGENT_CORE_MALFORMED_RESPONSE' || err.code === 'AGENT_CORE_PROVIDER_ERROR') {
            throw err;
          }
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
