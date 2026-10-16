const { success } = require('../utils/response');
const { asyncRoute } = require('../utils/asyncRoute');

/**
 * R-04 reconciliation endpoints. Thin, like `attendanceReportController`: all authorization, validation
 * and comparison live in `reconciliationService`, and `asyncRoute` turns any thrown `HttpError` into the
 * standard JSON error envelope.
 *
 * These are READ-ONLY JSON responses, so they use `success()` (unlike the R-03 exports, whose body is a
 * binary artifact). None of them is a POST/derive route.
 */
function createReconciliationController(reconciliationService) {
  return {
    // One employee-day reconciliation snapshot.
    day: asyncRoute(async (req, res) => {
      const data = await reconciliationService.reconcileDay(req.auth, {
        employeeUid: req.params.employeeUid,
        date: req.params.date,
      });
      success(res, data, 'กระทบยอดการมาทำงานรายวัน');
    }),

    // One employee-month reconciliation snapshot.
    month: asyncRoute(async (req, res) => {
      const data = await reconciliationService.reconcileMonth(req.auth, {
        employeeUid: req.params.employeeUid,
        year: Number(req.params.year),
        month: Number(req.params.month),
      });
      success(res, data, 'กระทบยอดการมาทำงานรายเดือน');
    }),

    // One employee fiscal year (Oct-Sep, Buddhist Era) reconciliation snapshot.
    fiscalYear: asyncRoute(async (req, res) => {
      const data = await reconciliationService.reconcileFiscalYear(req.auth, {
        employeeUid: req.params.employeeUid,
        fiscalYear: Number(req.params.fiscalYear),
      });
      success(res, data, 'กระทบยอดการมาทำงานรายปีงบประมาณ');
    }),
  };
}

module.exports = { createReconciliationController };
