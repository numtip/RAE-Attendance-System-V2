const { JevError } = require('./errors');
const {
  OPENROUTER_CHAT_COMPLETIONS_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  RETRYABLE_STATUS,
} = require('./constants');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createOpenRouterClient({
  apiKey,
  fetchImpl = global.fetch,
  baseUrl = OPENROUTER_CHAT_COMPLETIONS_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
  provider = null,
} = {}) {
  if (provider) {
    return {
      kind: provider.kind || 'mock',
      async chatCompletion(payload) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const result = await Promise.race([
            provider.chatCompletion(payload),
            new Promise((_resolve, reject) => {
              controller.signal.addEventListener('abort', () => {
                const err = new Error('Aborted');
                err.name = 'AbortError';
                reject(err);
              });
            }),
          ]);
          return result;
        } catch (err) {
          if (err.name === 'AbortError') {
            throw new JevError('JEV_TIMEOUT', 'OpenRouter request timed out');
          }
          throw err;
        } finally {
          clearTimeout(timer);
        }
      },
    };
  }

  if (!apiKey) {
    throw new JevError('JEV_NOT_CONFIGURED', 'OPENROUTER_API_KEY is not set');
  }
  if (!fetchImpl) {
    throw new JevError('JEV_NOT_CONFIGURED', 'fetch is not available');
  }

  async function chatCompletion(payload) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(baseUrl, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        const text = await response.text();
        let body;
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          throw new JevError('JEV_PROVIDER_ERROR', 'OpenRouter returned non-JSON', { status: response.status });
        }
        if (!response.ok) {
          if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
            await sleep(250 * 2 ** attempt);
            continue;
          }
          throw new JevError('JEV_PROVIDER_ERROR', 'OpenRouter rejected the request', { status: response.status });
        }
        return body;
      } catch (err) {
        lastError = err;
        if (err instanceof JevError) {
          if (err.code === 'JEV_PROVIDER_ERROR' && err.status && RETRYABLE_STATUS.has(err.status) && attempt < maxRetries) {
            await sleep(250 * 2 ** attempt);
            continue;
          }
          throw err;
        }
        if (err.name === 'AbortError') {
          throw new JevError('JEV_TIMEOUT', 'OpenRouter request timed out');
        }
        if (attempt < maxRetries) {
          await sleep(250 * 2 ** attempt);
          continue;
        }
        throw new JevError('JEV_PROVIDER_ERROR', 'OpenRouter is unreachable', { cause: err });
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  return { kind: 'openrouter', chatCompletion };
}

module.exports = { createOpenRouterClient };
