const { success } = require('../utils/response');
const { asyncRoute } = require('../utils/asyncRoute');

function createReportController(reportService) {
  return {
    personal: asyncRoute(async (req, res) => {
      success(res, await reportService.personal(req.auth, req.query), 'รายงานของฉัน');
    }),
    personalExport: asyncRoute(async (req, res) => {
      const file = await reportService.export(req.auth, req.query);
      res.setHeader('Content-Type', file.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
      res.setHeader('Content-Length', String(file.buffer.length));
      res.setHeader('Cache-Control', 'no-store');
      res.end(file.buffer);
    }),
  };
}

module.exports = { createReportController };
