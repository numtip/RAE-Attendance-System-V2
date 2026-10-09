const { createHash } = require('node:crypto');
const { normalizeCheckTimeBangkok } = require('../utils/bangkokTime');

const SOURCE_SYSTEM_HIP = 'hip_pm2014';
const RESOLUTION_STATUS = Object.freeze(['resolved', 'unmapped']);
const BATCH_STATUS = Object.freeze(['open', 'completed', 'failed']);
const FACESCAN_ID_MAX_LEN = 64;

function normalizeFacescanId(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > FACESCAN_ID_MAX_LEN) return null;
  if (text.split('').some((ch) => {
    const code = ch.charCodeAt(0);
    return code < 32;
  })) return null;
  return text;
}

function normalizeOptionalField(value, maxLen = 64) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!text || text.length > maxLen) return null;
  return text;
}

function normalizeCheckinoutRow(row) {
  const userId = row.USERID ?? row.userId ?? row.facescan_id ?? row.facescanId;
  const facescanId = normalizeFacescanId(userId);
  const checkTime = normalizeCheckTimeBangkok(row.CHECKTIME ?? row.checkTime ?? row.check_time);
  const checkType = normalizeOptionalField(row.CHECKTYPE ?? row.checkType ?? row.check_type, 16);
  const verifyCode = normalizeOptionalField(row.VERIFYCODE ?? row.verifyCode ?? row.verify_code, 32);
  const sensorId = normalizeOptionalField(row.SensorID ?? row.sensorId ?? row.sensor_id, 64);
  const workCode = normalizeOptionalField(row.WorkCode ?? row.workCode ?? row.work_code, 32);

  const invalidReason = !facescanId
    ? 'invalid_userid'
    : !checkTime
      ? 'invalid_checktime'
      : null;

  return {
    facescanId,
    checkTime,
    checkType,
    verifyCode,
    sensorId,
    workCode,
    invalidReason,
    rawPayload: row,
  };
}

/**
 * Deterministic idempotency for HIP CHECKINOUT.
 * USERID + CHECKTIME + SensorID + CHECKTYPE + VERIFYCODE + WorkCode (all normalized; empty → '-').
 */
function buildSourceEventKey(normalized) {
  const parts = [
    'hip_checkinout:v1',
    normalized.facescanId || '-',
    normalized.checkTime || '-',
    normalized.sensorId || '-',
    normalized.checkType || '-',
    normalized.verifyCode || '-',
    normalized.workCode || '-',
  ];
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}

module.exports = {
  SOURCE_SYSTEM_HIP,
  RESOLUTION_STATUS,
  BATCH_STATUS,
  FACESCAN_ID_MAX_LEN,
  normalizeFacescanId,
  normalizeCheckinoutRow,
  buildSourceEventKey,
};
