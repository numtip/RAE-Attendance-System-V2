const DEFAULT_AGENT_CORE_PROJECT = 'rae-attendance-v2';

const DECISION_PATH = '/v1/decision';

const USE_CASE_DECISION_TYPES = {
  architecture_review: 'NEXT_ACTION',
  pr_risk_review: 'QA_DISPOSITION',
  migration_planning: 'NEXT_ACTION',
  db_recovery_decision: 'HUMAN_ESCALATION',
  api_contract_review: 'QA_DISPOSITION',
  sso_readiness_review: 'QA_DISPOSITION',
  release_readiness: 'QA_DISPOSITION',
};

module.exports = {
  DECISION_PATH,
  DEFAULT_AGENT_CORE_PROJECT,
  USE_CASE_DECISION_TYPES,
};
