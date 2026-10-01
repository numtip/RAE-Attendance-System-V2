const { success } = require('../utils/response');
const { asyncRoute } = require('../utils/asyncRoute');

function createAttendanceController(attendanceService) {
  return {
    daily: asyncRoute(async (req, res) => {
      success(res, await attendanceService.daily(req.auth, req.params.date), 'การมาทำงานรายวัน');
    }),
    monthly: asyncRoute(async (req, res) => {
      const data = await attendanceService.monthly(
        req.auth,
        req.params.employeeUid,
        Number(req.params.year),
        Number(req.params.month),
      );
      success(res, data, 'สรุปรายเดือน');
    }),
  };
}

module.exports = { createAttendanceController };
