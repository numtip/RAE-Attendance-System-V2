const USE_CASES = {
  ARCHITECTURE_REVIEW: 'architecture_review',
  PR_RISK_REVIEW: 'pr_risk_review',
  MIGRATION_PLANNING: 'migration_planning',
  DB_RECOVERY_DECISION: 'db_recovery_decision',
  API_CONTRACT_REVIEW: 'api_contract_review',
  SSO_READINESS_REVIEW: 'sso_readiness_review',
  RELEASE_READINESS: 'release_readiness',
};

function buildUseCaseRequest(useCase, { summary, artifacts = [], constraints = [] } = {}) {
  return {
    useCase,
    question: `Review ${useCase} for RAE Attendance V2.`,
    context: {
      summary: summary || '',
      artifacts,
      constraints: [
        'GitHub-first / VPS-last',
        'No production database writes from agents',
        'SSO mock-first until MJU callback confirmed',
        ...constraints,
      ],
    },
  };
}

function createUseCaseHelpers(decisionsApi) {
  if (!decisionsApi) {
    return null;
  }
  async function run(useCase, payload) {
    const req = buildUseCaseRequest(useCase, payload);
    return decisionsApi.decide({
      useCase,
      context: req.context,
      question: req.question,
    });
  }
  return {
    architectureReview: (payload) => run(USE_CASES.ARCHITECTURE_REVIEW, payload),
    prRiskReview: (payload) => run(USE_CASES.PR_RISK_REVIEW, payload),
    migrationPlanning: (payload) => run(USE_CASES.MIGRATION_PLANNING, payload),
    dbRecoveryDecision: (payload) => run(USE_CASES.DB_RECOVERY_DECISION, {
      ...payload,
      constraints: ['copy-only evidence', 'isolated lab', ...(payload.constraints || [])],
    }),
    apiContractReview: (payload) => run(USE_CASES.API_CONTRACT_REVIEW, payload),
    ssoReadinessReview: (payload) => run(USE_CASES.SSO_READINESS_REVIEW, payload),
    releaseReadiness: (payload) => run(USE_CASES.RELEASE_READINESS, payload),
  };
}

module.exports = { USE_CASES, buildUseCaseRequest, createUseCaseHelpers };
