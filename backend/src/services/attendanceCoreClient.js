const { HttpError } = require('../utils/httpError');

function createAttendanceCoreClient(options = {}) {
  const baseUrl = (options.baseUrl || process.env.ATTENDANCE_CORE_URL || '').replace(/\/$/, '');
  const fetchImpl = options.fetchImpl || global.fetch;
  const timeoutMs = Number(options.timeoutMs || process.env.ATTENDANCE_CORE_TIMEOUT_MS || 8000);

  async function request(path, body) {
    if (!baseUrl) {
      throw new HttpError(503, 'ATTENDANCE_CORE_UNAVAILABLE', 'Attendance Core URL is not configured');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new HttpError(
          response.status >= 500 ? 502 : response.status,
          'ATTENDANCE_CORE_ERROR',
          payload.error || 'Attendance Core request failed',
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      if (error.name === 'AbortError') {
        throw new HttpError(504, 'ATTENDANCE_CORE_TIMEOUT', 'Attendance Core request timed out');
      }
      throw new HttpError(502, 'ATTENDANCE_CORE_ERROR', 'Attendance Core is unreachable');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    evaluateDay(payload) {
      return request('/attendance/evaluate-day', payload);
    },
    evaluatePeriod(payload) {
      return request('/attendance/evaluate-period', payload);
    },
  };
}

module.exports = { createAttendanceCoreClient };
