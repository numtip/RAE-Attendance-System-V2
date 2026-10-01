const { AgentCoreError } = require('./errors');

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
    throw new AgentCoreError('AGENT_CORE_FORBIDDEN', `Forbidden intent: ${intent}`);
  }
  if (context.productionWrite === true) {
    throw new AgentCoreError('AGENT_CORE_FORBIDDEN', 'Cannot authorize production database writes');
  }
  if (context.deployProduction === true) {
    throw new AgentCoreError('AGENT_CORE_FORBIDDEN', 'Cannot authorize production deploy');
  }
  if (context.bypassApproval === true) {
    throw new AgentCoreError('AGENT_CORE_FORBIDDEN', 'Cannot bypass human approval');
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
  if (normalized.disposition === 'REVIEW' || normalized.disposition === 'FALLBACK') {
    normalized.requires_human_approval = true;
  }
  return normalized;
}

module.exports = {
  FORBIDDEN_INTENTS,
  assertAllowedDecisionRequest,
  applyApprovalGate,
};
