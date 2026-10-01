const { AgentCoreError } = require('./errors');

const ALLOWED_RISK = new Set(['low', 'medium', 'high']);

function confidenceToRisk(confidence) {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) {
    return 'medium';
  }
  if (confidence >= 0.85) return 'low';
  if (confidence >= 0.6) return 'medium';
  return 'high';
}

function normalizeAgentCoreResponse(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new AgentCoreError('AGENT_CORE_MALFORMED_RESPONSE', 'Decision payload is not an object');
  }
  const decisionType = String(raw.decision_type || '').trim();
  const result = String(raw.result || '').trim();
  const disposition = String(raw.disposition || '').trim();
  const confidence = Number(raw.confidence);
  const fallback = Boolean(raw.fallback);

  if (!decisionType) {
    throw new AgentCoreError('AGENT_CORE_MALFORMED_RESPONSE', 'decision_type is required');
  }
  if (!result) {
    throw new AgentCoreError('AGENT_CORE_MALFORMED_RESPONSE', 'result is required');
  }
  if (!['EXECUTE', 'REVIEW', 'FALLBACK'].includes(disposition)) {
    throw new AgentCoreError('AGENT_CORE_MALFORMED_RESPONSE', 'disposition must be EXECUTE, REVIEW, or FALLBACK');
  }
  if (Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
    throw new AgentCoreError('AGENT_CORE_MALFORMED_RESPONSE', 'confidence must be between 0 and 1');
  }

  const risk = confidenceToRisk(confidence);
  const reasonCode = raw.reason_code ? String(raw.reason_code) : null;
  const requiresHumanApproval = disposition !== 'EXECUTE' || fallback || risk === 'high';

  return {
    decision: result,
    reasoning_summary: (reasonCode || `${decisionType} via Agent Core (disposition=${disposition})`).slice(0, 2000),
    risk,
    recommended_action: disposition === 'EXECUTE'
      ? 'Proceed in GitHub/CI within documented policy gates.'
      : 'Stop for human review before production-impacting steps.',
    requires_human_approval: requiresHumanApproval,
    disposition,
    confidence,
    fallback,
    decision_type: decisionType,
    provider_request_id: raw.provider_request_id ?? null,
  };
}

function normalizeLegacyDecision(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new AgentCoreError('AGENT_CORE_MALFORMED_RESPONSE', 'Decision payload is not an object');
  }
  const decision = String(raw.decision || '').trim();
  const reasoningSummary = String(raw.reasoning_summary || raw.reasoningSummary || '').trim();
  const risk = String(raw.risk || 'medium').toLowerCase();
  const recommendedAction = String(raw.recommended_action || raw.recommendedAction || '').trim();
  const requiresHumanApproval = Boolean(
    raw.requires_human_approval ?? raw.requiresHumanApproval ?? false,
  );

  if (!decision || !reasoningSummary || !recommendedAction) {
    throw new AgentCoreError('AGENT_CORE_MALFORMED_RESPONSE', 'Legacy decision fields incomplete');
  }
  if (!ALLOWED_RISK.has(risk)) {
    throw new AgentCoreError('AGENT_CORE_MALFORMED_RESPONSE', 'risk must be low, medium, or high');
  }

  return {
    decision,
    reasoning_summary: reasoningSummary.slice(0, 2000),
    risk,
    recommended_action: recommendedAction.slice(0, 2000),
    requires_human_approval: requiresHumanApproval,
  };
}

module.exports = {
  confidenceToRisk,
  normalizeAgentCoreResponse,
  normalizeLegacyDecision,
};
