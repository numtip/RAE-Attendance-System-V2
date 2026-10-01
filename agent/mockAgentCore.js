const { AgentCoreError } = require('./errors');

function createMockAgentCoreProvider(options = {}) {
  const {
    response,
    delayMs = 0,
    failWith = null,
    malformed = false,
  } = options;

  return {
    kind: 'mock-agent-core',
    async postDecision(body) {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      if (failWith) {
        throw failWith;
      }
      if (malformed) {
        return { decision_type: body.decision_type };
      }
      if (response) {
        return typeof response === 'function' ? response(body) : response;
      }
      return {
        decision_type: body.decision_type,
        result: 'Proceed with GitHub-first plan',
        confidence: 0.9,
        reason_code: 'mock_ok',
        fallback: false,
        disposition: 'EXECUTE',
        provider_request_id: 'mock-req-1',
      };
    },
  };
}

function approvalRequiredResponse() {
  return {
    decision_type: 'QA_DISPOSITION',
    result: 'Hold for human review',
    confidence: 0.55,
    reason_code: 'low_confidence',
    fallback: false,
    disposition: 'REVIEW',
    provider_request_id: 'mock-req-review',
  };
}

function unavailableError() {
  return new AgentCoreError('AGENT_CORE_UNAVAILABLE', 'mock down');
}

module.exports = {
  AgentCoreError,
  approvalRequiredResponse,
  createMockAgentCoreProvider,
  unavailableError,
};
