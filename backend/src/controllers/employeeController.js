const { success } = require('../utils/response');
const { asyncRoute } = require('../utils/asyncRoute');

function createEmployeeController(employeeService, attendanceService, employeeAssignmentService = null) {
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
    // Effective-dated employment attributes (Slice 1). Scope is enforced by the service, not the UI.
    assignments: asyncRoute(async (req, res) => {
      const data = await employeeAssignmentService.listForEmployee(req.auth, req.params.employeeUid, {
        onDate: req.query.onDate,
      });
      success(res, data, 'ประวัติการกำหนดตำแหน่ง');
    }),
  };
}

module.exports = { createEmployeeController };
