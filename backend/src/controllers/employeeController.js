const { success } = require('../utils/response');
const { asyncRoute } = require('../utils/asyncRoute');

function createEmployeeController(employeeService, attendanceService) {
  return {
    list: asyncRoute(async (req, res) => {
      success(res, await employeeService.list(req.auth), 'รายชื่อพนักงาน');
    }),
    detail: asyncRoute(async (req, res) => {
      success(res, await employeeService.getByUid(req.auth, req.params.employeeUid, req.query.employeeId), 'ข้อมูลพนักงาน');
    }),
    attendance: asyncRoute(async (req, res) => {
      const data = await attendanceService.forEmployee(req.auth, req.params.employeeUid);
      success(res, data, 'ประวัติการมาทำงาน');
    }),
  };
}

module.exports = { createEmployeeController };
