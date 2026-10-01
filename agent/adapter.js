const { createDecisionsFromEnv } = require('./decisions');

function createAttendanceAgentCoreAdapter(options = {}) {
  const decisionsApi = options.decisionsApi ?? createDecisionsFromEnv(options);

  if (!decisionsApi) {
    return {
      available: false,
      async evaluate() {
        return {
          decision: 'Agent Core unavailable — use deterministic GitHub-first workflow',
          requires_human_approval: true,
          meta: { fallback: true, provider: 'none' },
        };
      },
    };
  }

  return {
    available: true,
    projectId: decisionsApi.projectId,
    async evaluate({ task, useCase, intent, context, question }) {
      return decisionsApi.decide({
        useCase: useCase || task || 'architecture_review',
        intent,
        context,
        question,
      });
    },
  };
}

module.exports = { createAttendanceAgentCoreAdapter };
