const { normalizeIdentifierValue, maskIdentifierForLog } = require('../../domain/employeeIdentifier');
const { valueKind, valueLength } = require('./callbackDiagnostic');

const NATIONAL_ID_NAME = /citizen|national|pid|person_citizen/i;

function fieldPresence(value) {
  if (value === undefined) return 'absent';
  if (value === null || value === '') return 'empty';
  return 'present';
}

function nationalIdShape(name, value) {
  if (!NATIONAL_ID_NAME.test(String(name))) {
    const digits = String(value ?? '').replace(/\D/g, '');
    if (digits.length === 13) return 'national-id-shaped';
  }
  if (NATIONAL_ID_NAME.test(String(name))) {
    const normalized = normalizeIdentifierValue('national_id', value);
    const digits = normalized.replace(/\D/g, '');
    if (digits.length === 13) return 'national-id-claim';
    return 'national-id-claim-invalid';
  }
  return null;
}

/**
 * Redacted userinfo field manifest for live MJU contract discovery.
 * Never includes raw values, tokens, or full citizen IDs.
 */
function summarizeUserInfoProfile(profile) {
  const source = profile && typeof profile === 'object' ? profile : {};
  const fields = Object.keys(source).sort().map((name) => {
    const value = source[name];
    const nationalHint = nationalIdShape(name, value);
    const entry = {
      name,
      type: nationalHint || valueKind(name, value),
      presence: fieldPresence(value),
      length: valueLength(value),
    };
    if (nationalHint === 'national-id-claim' || nationalHint === 'national-id-shaped') {
      entry.maskedSample = maskIdentifierForLog('national_id', String(value));
    }
    return entry;
  });

  const nationalCandidates = fields.filter(
    (f) => f.type === 'national-id-claim' || f.type === 'national-id-shaped',
  );

  return {
    fieldCount: fields.length,
    fields,
    nationalIdCandidates: nationalCandidates.map((f) => ({
      name: f.name,
      valueType: f.type,
      candidateClassification: 'possible_national_id',
      presence: f.presence,
      length: f.length,
      maskedSample: f.maskedSample,
    })),
  };
}

module.exports = { summarizeUserInfoProfile };
