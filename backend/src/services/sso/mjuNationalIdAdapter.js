const { normalizeIdentifierValue, maskIdentifierForLog } = require('../../domain/employeeIdentifier');

/**
 * Claim names documented for MJU Person / identity mapping (not proven on SSO userinfo until MJU confirms).
 * @see docs/IDENTITY_CONTRACT.md (citizenID)
 * @see docs/DATA_MAPPING.md (citizen_id CSV column)
 */
const DOCUMENTED_NATIONAL_ID_CLAIMS = Object.freeze(['citizenID', 'citizen_id']);

function configuredClaims(nationalIdClaimsEnv) {
  const fromEnv = String(nationalIdClaimsEnv || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return fromEnv.length > 0 ? fromEnv : [...DOCUMENTED_NATIONAL_ID_CLAIMS];
}

/**
 * @returns {{ status: 'present'|'missing'|'invalid', normalized?: string, claim?: string, evidence: string, masked?: string }}
 */
function extractNationalIdFromProfile(profile, nationalIdClaimsEnv) {
  if (!profile || typeof profile !== 'object') {
    return { status: 'missing', evidence: 'no_profile' };
  }

  const claims = configuredClaims(nationalIdClaimsEnv);
  for (const claim of claims) {
    if (!(claim in profile)) continue;
    const raw = profile[claim];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;

    const normalized = normalizeIdentifierValue('national_id', raw);
    const digits = normalized.replace(/\D/g, '');
    if (digits.length !== 13) {
      return {
        status: 'invalid',
        evidence: 'invalid_national_id_format',
        claim,
        masked: maskIdentifierForLog('national_id', digits),
      };
    }
    return {
      status: 'present',
      normalized: digits,
      claim,
      masked: maskIdentifierForLog('national_id', digits),
    };
  }

  return { status: 'missing', evidence: 'national_id_claim_absent', configuredClaims: claims };
}

module.exports = {
  DOCUMENTED_NATIONAL_ID_CLAIMS,
  configuredClaims,
  extractNationalIdFromProfile,
};
