/**
 * Optional Agent Core adapter — no hard dependency on external Agent Core package.
 */
function createAgentCoreAdapter(decisionsApi) {
  if (!decisionsApi) {
    return {
      available: false,
      async evaluate() {
        return {
          decision: 'Agent Core adapter unavailable (no Jev client)',
          requires_human_approval: true,
        };
      },
    };
  }
  return {
    available: true,
    async evaluate({ task, intent, context }) {
      return decisionsApi.decide({
        useCase: task || 'agent_core_task',
        intent,
        context,
        question: context?.question,
      });
    },
  };
}

module.exports = { createAgentCoreAdapter };
