const { success } = require('../utils/response');
const { asyncRoute } = require('../utils/asyncRoute');

/**
 * Individual attendance report endpoints (R-02).
 *
 * Authorization lives in the service, which owns the scope rules, so every handler delegates and lets
 * `asyncRoute` translate the thrown HttpError into the response envelope. No query or body parameter here
 * can widen scope: the employee always comes from the path and is checked against the caller's resolved
 * scope before anything is read.
 *
 * These endpoints are READ-ONLY by design. Deriving a month is a separate, manager/admin-only write
 * (`/attendance/monthly-summary/recalculate`), so a report can never change the data it describes.
 */
function createAttendanceReportController(attendanceReportService) {
  return {
    // One stored employee-day with its rule version, cutoff and completeness verdict.
    day: asyncRoute(async (req, res) => {
      const data = await attendanceReportService.dayReport(
        req.auth,
        req.params.employeeUid,
        req.params.date,
      );
      success(res, data, 'รายงานการมาทำงานรายวัน');
    }),

    // One stored employee-month: the month row plus its days, and whether it may be read as final.
    month: asyncRoute(async (req, res) => {
      const data = await attendanceReportService.monthReport(
        req.auth,
        req.params.employeeUid,
        Number(req.params.year),
        Number(req.params.month),
      );
      success(res, data, 'รายงานการมาทำงานรายเดือน');
    }),

    // The twelve months of a Thai academic year (1 June - 31 May) for one employee.
    academicYear: asyncRoute(async (req, res) => {
      const data = await attendanceReportService.academicYearReport(
        req.auth,
        req.params.employeeUid,
        Number(req.params.year),
      );
      success(res, data, 'รายงานการมาทำงานรายปีการศึกษา');
    }),
  };
}

module.exports = { createAttendanceReportController };
