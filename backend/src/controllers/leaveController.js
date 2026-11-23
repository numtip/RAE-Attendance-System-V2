const { success } = require('../utils/response');
const { asyncRoute } = require('../utils/asyncRoute');
const { fiscalYearOf } = require('../domain/leavePolicyEngine');
const { bangkokDate } = require('../services/leaveEntitlementService');

function createLeaveController(leaveService) {
  return {
    list: asyncRoute(async (req, res) => {
      const data = await leaveService.list(req.auth, req.query.employeeUid, { year: req.query.year });
      success(res, data, 'รายการลา');
    }),
    balance: asyncRoute(async (req, res) => {
      // No `basis` is the long-standing calendar-year behaviour; `basis=fiscal&year=<BE fiscal year>` is opt-in.
      const basis = req.query.basis === undefined || req.query.basis === '' ? 'calendar' : String(req.query.basis);
      const fallbackYear = basis === 'fiscal' ? fiscalYearOf(bangkokDate(new Date())).be : new Date().getUTCFullYear();
      const year = Number(req.query.year || fallbackYear);
      const data = await leaveService.balance(req.auth, req.params.employeeUid, year, { basis });
      success(res, data, 'วันลาคงเหลือ');
    }),
    history: asyncRoute(async (req, res) => {
      const data = await leaveService.history(req.auth, req.params.employeeUid);
      success(res, data, 'ประวัติการลา');
    }),
  };
}

module.exports = { createLeaveController };
