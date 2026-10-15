const { success } = require('../utils/response');
const { asyncRoute } = require('../utils/asyncRoute');

/**
 * Slice 2: daily attendance calculation endpoints.
 *
 * Authorization lives in the service (it owns the scope rules), so every handler delegates and lets
 * `asyncRoute` translate the thrown HttpError into the response envelope. No endpoint here can widen
 * scope from a query parameter: the employee is always taken from the path and checked against the
 * caller's resolved scope.
 */
function createDailyAttendanceController(dailyAttendanceService) {
  return {
    // Read the stored (computed) day for one employee.
    stored: asyncRoute(async (req, res) => {
      const data = await dailyAttendanceService.getStored(
        req.auth,
        req.params.employeeUid,
        req.params.date,
      );
      success(res, data, 'ผลการคำนวณการมาทำงานรายวัน');
    }),

    // Read a stored range for one employee.
    range: asyncRoute(async (req, res) => {
      const data = await dailyAttendanceService.listStored(req.auth, {
        employeeUid: req.params.employeeUid,
        from: req.query.from,
        to: req.query.to,
      });
      success(res, data, 'ผลการคำนวณการมาทำงานตามช่วงวันที่');
    }),

    // Show the calculation for a day WITHOUT storing it, plus why it came out that way.
    explain: asyncRoute(async (req, res) => {
      const data = await dailyAttendanceService.explain(
        req.auth,
        req.params.employeeUid,
        req.params.date,
      );
      success(res, data, 'คำอธิบายผลการคำนวณการมาทำงาน');
    }),

    // Recalculate a range. Manager/admin only, own-scope for a non-admin, idempotent and deterministic.
    recalculate: asyncRoute(async (req, res) => {
      const body = req.body || {};
      const data = await dailyAttendanceService.recalculate(req.auth, {
        employeeUid: body.employeeUid ?? req.params.employeeUid ?? null,
        from: body.from,
        to: body.to,
        sourceSystem: body.sourceSystem,
      });
      success(res, data, 'คำนวณการมาทำงานใหม่เรียบร้อย');
    }),
  };
}

module.exports = { createDailyAttendanceController };
