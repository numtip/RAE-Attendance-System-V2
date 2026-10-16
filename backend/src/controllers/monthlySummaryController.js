const { success } = require('../utils/response');
const { asyncRoute } = require('../utils/asyncRoute');

/**
 * Slice 3: monthly summary derivation endpoints.
 *
 * Authorization lives in the service, which owns the scope rules — including the organization-wide guard on
 * `recalculate`. No query or body parameter here can widen scope: the employee always comes from the path
 * and is checked against the caller's resolved scope.
 */
function createMonthlySummaryController(monthlySummaryService) {
  return {
    // Stored month. Returns null data when the month was never derived, rather than a fabricated zero month.
    stored: asyncRoute(async (req, res) => {
      const data = await monthlySummaryService.getStored(
        req.auth,
        req.params.employeeUid,
        Number(req.params.year),
        Number(req.params.month),
      );
      success(res, data, 'สรุปการมาทำงานรายเดือน');
    }),

    // Every stored month of a year for one employee.
    year: asyncRoute(async (req, res) => {
      const data = await monthlySummaryService.listStored(
        req.auth,
        req.params.employeeUid,
        Number(req.params.year),
      );
      success(res, data, 'สรุปการมาทำงานรายปี');
    }),

    // Stored month next to a fresh derivation, plus whether the stored one is stale.
    explain: asyncRoute(async (req, res) => {
      const data = await monthlySummaryService.explain(
        req.auth,
        req.params.employeeUid,
        Number(req.params.year),
        Number(req.params.month),
      );
      success(res, data, 'คำอธิบายสรุปรายเดือน');
    }),

    // Derive and store one month for one employee.
    recalculateMonth: asyncRoute(async (req, res) => {
      const data = await monthlySummaryService.recalculateMonth(
        req.auth,
        req.params.employeeUid,
        Number(req.params.year),
        Number(req.params.month),
      );
      success(res, data, 'คำนวณสรุปรายเดือนใหม่เรียบร้อย');
    }),

    // Derive a whole year, or the whole organization when no employeeUid is given (broad scope required).
    recalculate: asyncRoute(async (req, res) => {
      const body = req.body || {};
      const data = await monthlySummaryService.recalculate(req.auth, {
        employeeUid: body.employeeUid ?? req.params.employeeUid ?? null,
        year: body.year,
        month: body.month ?? null,
      });
      success(res, data, 'คำนวณสรุปการมาทำงานใหม่เรียบร้อย');
    }),
  };
}

module.exports = { createMonthlySummaryController };
