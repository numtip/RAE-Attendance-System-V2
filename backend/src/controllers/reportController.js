const { success } = require('../utils/response');
const { asyncRoute } = require('../utils/asyncRoute');

function sendFile(res, file) {
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.setHeader('Content-Length', String(file.buffer.length));
  res.setHeader('Cache-Control', 'no-store');
  res.end(file.buffer);
}

function createReportController(reportService, organizationReportService, leaveMonthlyReportService, divisionReportService, leaveReviewService) {
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
    leaveReviewList: asyncRoute(async (req, res) => {
      success(res, await leaveReviewService.list(req.auth, req.query), 'รายการลารอตรวจสอบ');
    }),
    leaveReviewDecide: asyncRoute(async (req, res) => {
      success(res, await leaveReviewService.decide(req.auth, req.body && req.body.decisions), 'บันทึกผลการตรวจสอบการลา');
    }),
    divisions: asyncRoute(async (req, res) => {
      success(res, await divisionReportService.divisions(req.auth, req.query), 'แดชบอร์ดผู้บริหารรายกอง');
    }),
    leaveMonthlyExport: asyncRoute(async (req, res) => {
      sendFile(res, await leaveMonthlyReportService.export(req.auth, req.query));
    }),
    leaveMonthly: asyncRoute(async (req, res) => {
      success(res, await leaveMonthlyReportService.monthly(req.auth, req.query), 'สรุปการลารายเดือน');
    }),
    organizationExport: asyncRoute(async (req, res) => {
      sendFile(res, await organizationReportService.export(req.auth, req.query));
    }),
  };
}

module.exports = { createReportController };
