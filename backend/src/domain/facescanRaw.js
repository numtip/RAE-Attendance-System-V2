const { createHash } = require('node:crypto');

const SCAN_TYPES = Object.freeze(['in', 'out', 'unknown']);
const RESOLUTION_STATUS = Object.freeze(['resolved', 'unmapped', 'duplicate']);
const BATCH_STATUS = Object.freeze(['open', 'committed', 'failed']);

function normalizeFacescanId(value) {
  return String(value ?? '').trim();
}

function normalizeScanType(value) {
  const raw = String(value ?? 'unknown').trim().toLowerCase();
  return SCAN_TYPES.includes(raw) ? raw : 'unknown';
}

function normalizeScanDatetime(value) {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 19).replace('T', ' ');
  }
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.includes('T')) {
    return text.slice(0, 19).replace('T', ' ');
  }
  return text;
}

function buildIdempotencyKey({ facescanId, scanDatetime, scanType }) {
  const canonical = [
    'facescan_raw:v1',
    normalizeFacescanId(facescanId),
    normalizeScanDatetime(scanDatetime),
    normalizeScanType(scanType),
  ].join('|');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

module.exports = {
  SCAN_TYPES,
  RESOLUTION_STATUS,
  BATCH_STATUS,
  normalizeFacescanId,
  normalizeScanType,
  normalizeScanDatetime,
  buildIdempotencyKey,
};
