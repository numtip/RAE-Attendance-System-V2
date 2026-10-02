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
    const digits = raw.replace(/\D/g, '');
    return digits.length === 13 ? digits : raw;
  }
  if (idType === 'employee_id' || idType === 'personnel_id' || idType === 'facescan_id') {
    return raw;
  }
  return raw;
}

function maskIdentifierForLog(idType, idValue) {
  if (idType === 'national_id') {
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
  maskIdentifierForLog,
  isStoredIdentifierType,
  isResolvableIdentifierType,
  notFoundMessage,
};
