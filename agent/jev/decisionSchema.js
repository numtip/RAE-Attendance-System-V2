const { JevError } = require('./errors');

const ALLOWED_RISK = new Set(['low', 'medium', 'high']);

const DECISION_OUTPUT_FIELDS = [
  'decision',
  'reasoning_summary',
  'risk',
  'recommended_action',
  'requires_human_approval',
];

function normalizeDecision(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new JevError('JEV_MALFORMED_RESPONSE', 'Decision payload is not an object');
  }
  const decision = String(raw.decision || '').trim();
  const reasoningSummary = String(raw.reasoning_summary || raw.reasoningSummary || '').trim();
  const risk = String(raw.risk || 'medium').toLowerCase();
  const recommendedAction = String(raw.recommended_action || raw.recommendedAction || '').trim();
  const requiresHumanApproval = Boolean(
    raw.requires_human_approval ?? raw.requiresHumanApproval ?? false,
  );

  if (!decision) {
    throw new JevError('JEV_MALFORMED_RESPONSE', 'decision is required');
  }
  if (!reasoningSummary) {
    throw new JevError('JEV_MALFORMED_RESPONSE', 'reasoning_summary is required');
  }
  if (!ALLOWED_RISK.has(risk)) {
    throw new JevError('JEV_MALFORMED_RESPONSE', 'risk must be low, medium, or high');
  }
  if (!recommendedAction) {
    throw new JevError('JEV_MALFORMED_RESPONSE', 'recommended_action is required');
  }

  return {
    decision,
    reasoning_summary: reasoningSummary.slice(0, 2000),
    risk,
    recommended_action: recommendedAction.slice(0, 2000),
    requires_human_approval: requiresHumanApproval,
  };
}

function buildDecisionSystemPrompt() {
  return [
    'You are Jev, an agent decision layer for RAE Attendance System V2.',
    'Respond with a single JSON object only (no markdown).',
    'Fields: decision, reasoning_summary, risk (low|medium|high), recommended_action, requires_human_approval (boolean).',
    'reasoning_summary must be concise and auditable — no chain-of-thought or hidden reasoning.',
    'Never recommend production DB writes, production deploy, bypassing approval, or handling secrets.',
    'Prefer GitHub-first / VPS-last workflow.',
  ].join(' ');
}

module.exports = {
  DECISION_OUTPUT_FIELDS,
  normalizeDecision,
  buildDecisionSystemPrompt,
};
