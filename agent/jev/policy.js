const { JevError } = require('./errors');

const FORBIDDEN_INTENTS = new Set([
  'production_db_write',
  'production_deploy',
  'bypass_approval',
  'manage_secrets',
  'override_security',
  'vps_ssh_without_gate',
]);

const HIGH_RISK_REQUIRES_APPROVAL = new Set([
  'production_cutover',
  'db_recovery_execute',
  'sso_enable_production',
]);

function assertAllowedDecisionRequest({ intent, context = {} }) {
  if (intent && FORBIDDEN_INTENTS.has(intent)) {
    throw new JevError('JEV_FORBIDDEN', `Jev cannot perform intent: ${intent}`);
  }
  if (context.productionWrite === true) {
    throw new JevError('JEV_FORBIDDEN', 'Jev cannot authorize production database writes');
  }
  if (context.deployProduction === true) {
    throw new JevError('JEV_FORBIDDEN', 'Jev cannot deploy production');
  }
  if (context.bypassApproval === true) {
    throw new JevError('JEV_FORBIDDEN', 'Jev cannot bypass human approval');
  }
}

function applyApprovalGate(decision, { intent }) {
  const normalized = { ...decision };
  if (HIGH_RISK_REQUIRES_APPROVAL.has(intent)) {
    normalized.requires_human_approval = true;
  }
  if (normalized.risk === 'high') {
    normalized.requires_human_approval = true;
  }
  return normalized;
}

module.exports = {
  FORBIDDEN_INTENTS,
  assertAllowedDecisionRequest,
  applyApprovalGate,
};
