const { success } = require('../utils/response');
const { asyncRoute } = require('../utils/asyncRoute');

function createReportController(reportService) {
  return {
    personal: asyncRoute(async (req, res) => {
      const year = Number(req.query.year);
      const month = Number(req.query.month);
      const data = await reportService.personal(req.auth, year, month);
      success(res, data, 'รายงานของฉัน');
    }),
  };
}

module.exports = { createReportController };
