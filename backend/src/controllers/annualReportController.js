const { success } = require('../utils/response');
const { asyncRoute } = require('../utils/asyncRoute');

/**
 * R-05 annual HR report endpoints (JSON + binary export) in ONE thin controller.
 *
 * All authorization, validation and rendering live in `annualReportService`, and `asyncRoute` turns any
 * thrown `HttpError` into the standard JSON error envelope. Neither endpoint can widen scope: the employee
 * always comes from the path and is checked against the caller's resolved scope before anything is read.
 *
 * The JSON handlers answer with the `success()` envelope (like R-02/R-04). The export handlers do NOT:
 * the body is a binary artifact, which is exactly why every failure must happen BEFORE a byte is written —
 * the service resolves and renders first, and only a fully built buffer reaches `res`. A 403 therefore
 * arrives as JSON, never as a half-sent PDF. An attendance report is per-user data, so the response is
 * marked `no-store` and `private`.
 *
 * These are READ-ONLY by construction: there is no POST/derive variant, so a report can never change the
 * data it describes.
 */
function createAnnualReportController(annualReportService) {
  function sendFile(res, { buffer, contentType, fileName }) {
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(buffer);
  }

  return {
    // The Thai government fiscal year (Oct-Sep), named by its Buddhist-Era year (e.g. 2569).
    fiscalYear: asyncRoute(async (req, res) => {
      const data = await annualReportService.fiscalYearReport(
        req.auth,
        req.params.employeeUid,
        Number(req.params.fiscalYear),
      );
      success(res, data, 'รายงานการมาทำงานรายปีงบประมาณ');
    }),

    // The annual academic year (1 June - 31 May), named by the Gregorian year it starts. A distinct path
    // from R-02's `/attendance/report/academic-year/:year`, which is a different payload for the same
    // window, so the existing R-02 contract is never changed.
    academicAnnual: asyncRoute(async (req, res) => {
      const data = await annualReportService.academicAnnualReport(
        req.auth,
        req.params.employeeUid,
        Number(req.params.year),
      );
      success(res, data, 'รายงานการมาทำงานรายปีการศึกษา');
    }),

    // Fiscal-year annual report as a PDF or XLSX. `?format=pdf|xlsx` is REQUIRED (no default).
    exportFiscalYear: asyncRoute(async (req, res) => {
      const result = await annualReportService.exportAnnualReport(req.auth, {
        periodKind: 'fiscal',
        employeeUid: req.params.employeeUid,
        year: Number(req.params.fiscalYear),
        format: req.query.format,
      });
      sendFile(res, result);
    }),

    // Academic-year annual report as a PDF or XLSX.
    exportAcademicAnnual: asyncRoute(async (req, res) => {
      const result = await annualReportService.exportAnnualReport(req.auth, {
        periodKind: 'academic',
        employeeUid: req.params.employeeUid,
        year: Number(req.params.year),
        format: req.query.format,
      });
      sendFile(res, result);
    }),
  };
}

module.exports = { createAnnualReportController };
