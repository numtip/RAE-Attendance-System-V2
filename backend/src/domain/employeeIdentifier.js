const STORED_IDENTIFIER_TYPES = Object.freeze([
  'employee_id',
  'personnel_id',
  'facescan_id',
  'national_id',
]);

const ALL_RESOLVABLE_TYPES = Object.freeze([...STORED_IDENTIFIER_TYPES]);

const LINK_SOURCES = Object.freeze(['operator', 'import', 'system']);

function normalizeIdentifierValue(idType, idValue) {
  const raw = String(idValue ?? '').trim();
  if (!raw) return '';
  if (idType === 'national_id') {
    // FAIL CLOSED. A national ID is matched only as an HMAC digest (see security/nationalIdContract.js), so a
    // raw value should never reach here. Returning the raw text for a malformed value — the previous
    // behaviour — would hash arbitrary input into a "lookup value" and silently create an unmatchable row.
    // Callers that need to protect a national ID must use the protector, not this normaliser.
    const digits = raw.replace(/\D/g, '');
    return digits.length === 13 ? digits : '';
  }
  if (idType === 'employee_id' || idType === 'personnel_id' || idType === 'facescan_id') {
    return raw;
  }
  return raw;
}

/**
 * Normalises a value for a LOOKUP (as opposed to a raw write).
 *
 * `national_id` is stored as a 64-hex HMAC digest, so a lookup value for that type is already canonical and
 * must be passed through untouched. Running the raw-value normaliser over a digest returns `''` (a digest is
 * not 13 digits), which would silently make every national-ID lookup miss — and, on a write path, create a
 * duplicate row instead of reusing the existing one.
 */
function normalizeLookupValue(idType, idValue) {
  if (idType === 'national_id') return String(idValue ?? '').trim();
  return normalizeIdentifierValue(idType, idValue);
}

function maskIdentifierForLog(idType, idValue) {  if (idType === 'national_id') {
    const digits = String(idValue || '').replace(/\D/g, '');
    if (digits.length >= 4) {
      return `****${digits.slice(-4)}`;
    }
    return '[redacted-national-id]';
  }
  const text = String(idValue || '');
  if (text.length <= 4) return '…';
  return `${text.slice(0, 2)}…${text.slice(-2)}`;
}

function isStoredIdentifierType(idType) {
  return STORED_IDENTIFIER_TYPES.includes(idType);
}

function isResolvableIdentifierType(idType) {
  return ALL_RESOLVABLE_TYPES.includes(idType);
}

function notFoundMessage(idType) {
  return `No employee for identifier type ${idType}`;
}

module.exports = {
  STORED_IDENTIFIER_TYPES,
  ALL_RESOLVABLE_TYPES,
  LINK_SOURCES,
  normalizeIdentifierValue,
  normalizeLookupValue,
  maskIdentifierForLog,
  isStoredIdentifierType,
  isResolvableIdentifierType,
  notFoundMessage,
};
