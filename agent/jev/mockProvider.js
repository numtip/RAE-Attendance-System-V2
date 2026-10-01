const { JevError } = require('./errors');

function createMockOpenRouterProvider(options = {}) {
  const responses = options.responses || {};
  const delayMs = options.delayMs || 0;
  let callCount = 0;

  return {
    kind: 'mock',
    async chatCompletion(_payload) {
      callCount += 1;
      if (options.failWith) {
        throw options.failWith;
      }
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      if (options.timeoutSimulate) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
      const key = options.responseKey || 'default';
      const content = responses[key] ?? responses.default;
      if (content === undefined) {
        return {
          choices: [{ message: { role: 'assistant', content: JSON.stringify({
            decision: 'Proceed with mock plan',
            reasoning_summary: 'Mock provider default response for tests.',
            risk: 'low',
            recommended_action: 'Continue in GitHub/CI with fixtures.',
            requires_human_approval: false,
          }) } }],
        };
      }
      if (typeof content === 'function') {
        return content({ callCount, payload: _payload });
      }
      return {
        choices: [{ message: { role: 'assistant', content } }],
      };
    },
  };
}

function malformedJsonResponse() {
  return createMockOpenRouterProvider({
    responses: {
      default: '{ not valid json',
    },
  });
}

function missingFieldsResponse() {
  return createMockOpenRouterProvider({
    responses: {
      default: JSON.stringify({ decision: 'incomplete' }),
    },
  });
}

module.exports = {
  createMockOpenRouterProvider,
  malformedJsonResponse,
  missingFieldsResponse,
  JevError,
};
