const PROVIDER_MJU_SSO = 'mju_sso';

const LINK_STATUS = {
  CANDIDATE: 'candidate',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  REVOKED: 'revoked',
};

const ENRICHMENT_SOURCES = new Set(['mju_person_enrich', 'person_api_enrich']);

const BLOCKED_ENRICHMENT_OUTCOMES = new Set([
  'ambiguous',
  'not_found',
  'timeout',
  'api_error',
  'fallback',
  'firstname_only',
]);

function normalizeEmail(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).trim().toLowerCase();
}

function isAuthenticatableStatus(status) {
  return status === LINK_STATUS.APPROVED;
}

function enrichmentBlocksApproval(link) {
  if (!ENRICHMENT_SOURCES.has(link.source)) return false;
  if (BLOCKED_ENRICHMENT_OUTCOMES.has(link.enrichmentOutcome)) return true;
  if (link.confidence === 'ambiguous' || link.confidence === 'low') return true;
  return false;
}

module.exports = {
  PROVIDER_MJU_SSO,
  LINK_STATUS,
  ENRICHMENT_SOURCES,
  BLOCKED_ENRICHMENT_OUTCOMES,
  normalizeEmail,
  isAuthenticatableStatus,
  enrichmentBlocksApproval,
};
