const { success } = require('../utils/response');
const { asyncRoute } = require('../utils/asyncRoute');

function sendFile(res, file) {
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.setHeader('Content-Length', String(file.buffer.length));
  res.setHeader('Cache-Control', 'no-store');
  res.end(file.buffer);
}

function createReportController(reportService, organizationReportService) {
  return {
    personal: asyncRoute(async (req, res) => {
      success(res, await reportService.personal(req.auth, req.query), 'รายงานของฉัน');
    }),
    personalExport: asyncRoute(async (req, res) => {
      sendFile(res, await reportService.export(req.auth, req.query));
    }),
    organization: asyncRoute(async (req, res) => {
      success(res, await organizationReportService.organization(req.auth, req.query), 'รายงานองค์กร/ทีม');
    }),
    organizationExport: asyncRoute(async (req, res) => {
      sendFile(res, await organizationReportService.export(req.auth, req.query));
    }),
  };
}

module.exports = { createReportController };
