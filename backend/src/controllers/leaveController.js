const { success } = require('../utils/response');
const { asyncRoute } = require('../utils/asyncRoute');

function createLeaveController(leaveService) {
  return {
    list: asyncRoute(async (req, res) => {
      const data = await leaveService.list(req.auth, req.query.employeeUid);
      success(res, data, 'รายการลา');
    }),
    balance: asyncRoute(async (req, res) => {
      const year = Number(req.query.year || new Date().getUTCFullYear());
      const data = await leaveService.balance(req.auth, req.params.employeeUid, year);
      success(res, data, 'วันลาคงเหลือ');
    }),
    history: asyncRoute(async (req, res) => {
      const data = await leaveService.history(req.auth, req.params.employeeUid);
      success(res, data, 'ประวัติการลา');
    }),
  };
}

module.exports = { createLeaveController };
