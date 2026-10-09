const { success } = require('../utils/response');
const { asyncRoute } = require('../utils/asyncRoute');

function createAttendanceComputeController(attendanceComputeService) {
  return {
    evaluateDay: asyncRoute(async (req, res) => {
      success(res, await attendanceComputeService.evaluateDay(req.auth, req.body), 'ผลการประเมินการมาทำงานรายวัน');
    }),
    evaluatePeriod: asyncRoute(async (req, res) => {
      success(res, await attendanceComputeService.evaluatePeriod(req.auth, req.body), 'ผลการประเมินการมาทำงานรายช่วง');
    }),
    explainResult: asyncRoute(async (req, res) => {
      success(res, await attendanceComputeService.explainResult(req.auth, req.body), 'คำอธิบายผลการประเมิน');
    }),
  };
}

module.exports = { createAttendanceComputeController };
