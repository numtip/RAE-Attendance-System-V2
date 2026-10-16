const { asyncRoute } = require('../utils/asyncRoute');

/**
 * R-03 export endpoints. Thin, like `attendanceReportController`: all authorization, validation and
 * rendering live in `exportService`, and `asyncRoute` turns any thrown `HttpError` into the standard JSON
 * error envelope.
 *
 * These handlers do NOT use the JSON `success()` envelope — the body is a binary artifact. That is exactly
 * why every failure must happen BEFORE a byte is written: the service resolves and renders first, and only a
 * fully built buffer reaches `res`. A 403 therefore arrives as JSON, never as a half-sent PDF.
 *
 * An attendance report is per-user data, so the response is marked `no-store` and `private`: a shared proxy
 * must never keep a copy.
 */
function createExportController(exportService) {
  function sendFile(res, { buffer, contentType, fileName }) {
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(buffer);
  }

  async function respond(req, res, kind, params) {
    const result = await exportService.exportReport(req.auth, {
      kind,
      ...params,
      format: req.query.format,
    });
    sendFile(res, result);
  }

  return {
    // One employee-day as a document.
    day: asyncRoute((req, res) => respond(req, res, 'day', {
      employeeUid: req.params.employeeUid,
      date: req.params.date,
    })),

    // One employee-month as a document.
    month: asyncRoute((req, res) => respond(req, res, 'month', {
      employeeUid: req.params.employeeUid,
      year: req.params.year,
      month: req.params.month,
    })),

    // One Thai academic year (1 June - 31 May) as a document.
    academicYear: asyncRoute((req, res) => respond(req, res, 'academic_year', {
      employeeUid: req.params.employeeUid,
      year: req.params.year,
    })),
  };
}

module.exports = { createExportController };
