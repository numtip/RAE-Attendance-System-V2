const express = require('express');
const healthRoutes = require('./routes/health');
const { authenticate } = require('../../middleware/authenticate');
const { createAuthController } = require('../../controllers/authController');
const { createSsoController } = require('../../controllers/ssoController');
const { createEmployeeController } = require('../../controllers/employeeController');
const { createAttendanceController } = require('../../controllers/attendanceController');
const { createLeaveController } = require('../../controllers/leaveController');
const { createAuthService } = require('../../services/authService');
const { createEmployeeService } = require('../../services/employeeService');
const { createEmployeeAssignmentService } = require('../../services/employeeAssignmentService');
const { createAttendanceService } = require('../../services/attendanceService');
const { createLeaveService } = require('../../services/leaveService');
const { createSsoService } = require('../../services/ssoService');
const { createAttendanceComputeService } = require('../../services/attendanceComputeService');
const { createAttendanceComputeController } = require('../../controllers/attendanceComputeController');
const { createDailyAttendanceController } = require('../../controllers/dailyAttendanceController');
const { createDailyAttendanceService } = require('../../services/dailyAttendanceService');
const { createMonthlySummaryController } = require('../../controllers/monthlySummaryController');
const { createMonthlySummaryService } = require('../../services/monthlySummaryService');
const { createAttendanceReportController } = require('../../controllers/attendanceReportController');
const { createAttendanceReportService } = require('../../services/attendanceReportService');
const { createExportController } = require('../../controllers/exportController');
const { createExportService } = require('../../services/exportService');
const { createReconciliationController } = require('../../controllers/reconciliationController');
const { createReconciliationService } = require('../../services/reconciliationService');
const { createAnnualReportController } = require('../../controllers/annualReportController');
const { createAnnualReportService } = require('../../services/annualReportService');

function createV1Router(container) {
  const authService = createAuthService(container);
  const employeeService = createEmployeeService(container);
  const employeeAssignmentService = createEmployeeAssignmentService(container);
  const attendanceService = createAttendanceService(container);
  const leaveService = createLeaveService(container);
  const attendanceComputeService = createAttendanceComputeService(container);
  const ssoService = createSsoService(container);
  const auth = createAuthController(authService);
  const sso = createSsoController(ssoService, container);
  const employees = createEmployeeController(employeeService, attendanceService, employeeAssignmentService);
  const attendance = createAttendanceController(attendanceService);
  const leave = createLeaveController(leaveService);
  const attendanceCompute = createAttendanceComputeController(attendanceComputeService);
  // Slice 2. The advisory is injected through the container, NOT imported from the `agent/` folder: that
  // folder is documented as agent-only and is not part of the Express runtime. It is optional by design, so
  // a missing or failing advisory can never block a calculation.
  const dailyAttendance = createDailyAttendanceController(createDailyAttendanceService({
    repositories: container.repositories,
    agentAdvisory: container.agentAdvisory ?? null,
  }));
  // Slice 3: monthly summaries are derived from the stored daily rows, not recomputed from scans.
  const monthlySummary = createMonthlySummaryController(createMonthlySummaryService({
    repositories: container.repositories,
  }));
  // R-02: read-only individual attendance reports (day / month / academic year). This layer never writes
  // and never recomputes; deriving a month stays behind the manager/admin-only monthly-summary route.
  const attendanceReport = createAttendanceReportController(createAttendanceReportService({
    repositories: container.repositories,
  }));
  // R-03: exports are rendered from the R-02 payload, so the two can never disagree about a number.
  const exportReport = createExportController(createExportService({
    repositories: container.repositories,
  }));
  // R-04: read-only reconciliation snapshots (day / month / fiscal year). They COMPARE stored V2 records
  // only; they never derive a month and never write. The fiscal year is the Oct-Sep government convention
  // and is named explicitly in the response so it cannot be confused with the CE `:year` used elsewhere.
  const reconciliation = createReconciliationController(createReconciliationService({
    repositories: container.repositories,
  }));
  // R-05: the ANNUAL HR report. Read-only by construction (no POST/derive). Every monthly number comes from
  // R-02 and the artifact is rendered by the R-03 renderer, so the annual layer derives nothing of its own.
  // The fiscal year (Oct-Sep, Buddhist-Era label) and the academic year (Jun-May) are named distinctly in
  // the payload, so the two windows can never be confused. Paths: `fiscal-year` for the fiscal window, and
  // `annual-academic` for the annual academic window (R-02 already owns `/attendance/report/academic-year`).
  const annualReport = createAnnualReportController(createAnnualReportService({
    repositories: container.repositories,
  }));

  const router = express.Router();
  router.use('/health', healthRoutes);

  router.post('/auth/login', auth.login);
  router.post('/auth/refresh', auth.refresh);
  router.get('/auth/me', authenticate, auth.me);
  router.post('/auth/logout', authenticate, auth.logout);

  router.get('/auth/sso/login', sso.login);
  router.get('/auth/sso/callback', sso.callback);
  router.post('/auth/sso/exchange', sso.exchange);
  router.get('/auth/sso/me', authenticate, sso.me);
  router.post('/auth/sso/logout', authenticate, sso.logout);

  router.get('/employees', authenticate, employees.list);
  router.get('/employees/:employeeUid/attendance', authenticate, employees.attendance);
  router.get('/employees/:employeeUid/assignments', authenticate, employees.assignments);
  router.get('/employees/:employeeUid', authenticate, employees.detail);

  router.get('/attendance/daily/:date', authenticate, attendance.daily);
  router.get('/attendance/monthly/:employeeUid/:year/:month', authenticate, attendance.monthly);
  router.post('/attendance/evaluate-day', authenticate, attendanceCompute.evaluateDay);
  router.post('/attendance/evaluate-period', authenticate, attendanceCompute.evaluatePeriod);
  router.post('/attendance/explain', authenticate, attendanceCompute.explainResult);

  router.get('/leave', authenticate, leave.list);
  router.get('/leave/balance/:employeeUid', authenticate, leave.balance);
  router.get('/leave/history/:employeeUid', authenticate, leave.history);

  // Slice 2: computed daily attendance (versioned rules + provenance).
  router.get('/attendance/daily-computed/:employeeUid/:date', authenticate, dailyAttendance.stored);
  router.get('/attendance/daily-computed/:employeeUid', authenticate, dailyAttendance.range);
  router.get('/attendance/explain/:employeeUid/:date', authenticate, dailyAttendance.explain);
  router.post('/attendance/recalculate', authenticate, dailyAttendance.recalculate);
  router.post('/attendance/recalculate/:employeeUid', authenticate, dailyAttendance.recalculate);

  // Slice 3: monthly summary derived from the daily rows.
  router.get('/attendance/monthly-summary/:employeeUid/:year/:month', authenticate, monthlySummary.stored);
  router.get('/attendance/monthly-summary/:employeeUid/:year', authenticate, monthlySummary.year);
  router.get('/attendance/monthly-summary-explain/:employeeUid/:year/:month', authenticate, monthlySummary.explain);
  router.post('/attendance/monthly-summary/recalculate/:employeeUid/:year/:month', authenticate, monthlySummary.recalculateMonth);
  router.post('/attendance/monthly-summary/recalculate', authenticate, monthlySummary.recalculate);

  // R-02: read-only individual reports. Every one of them surfaces `computationStatus` and `isFinal`, so a
  // partial or pending-policy month can never be rendered as a final figure.
  router.get('/attendance/report/day/:employeeUid/:date', authenticate, attendanceReport.day);
  router.get('/attendance/report/month/:employeeUid/:year/:month', authenticate, attendanceReport.month);
  router.get('/attendance/report/academic-year/:employeeUid/:year', authenticate, attendanceReport.academicYear);

  // R-03: the same three reports as downloadable documents. `?format=pdf|xlsx` is REQUIRED (a missing or
  // unknown format is a 400, never a default file). The export is rendered from the R-02 payload above, so
  // authorization, scope and period validation are inherited rather than re-implemented.
  router.get('/attendance/export/day/:employeeUid/:date', authenticate, exportReport.day);
  router.get('/attendance/export/month/:employeeUid/:year/:month', authenticate, exportReport.month);
  router.get('/attendance/export/academic-year/:employeeUid/:year', authenticate, exportReport.academicYear);

  // R-04: read-only reconciliation snapshots. Read-only by construction — no POST/derive variant exists.
  // `:fiscalYear` is the BUDDHIST ERA year (e.g. 2569) and the response states both the BE year and the
  // Gregorian window.
  router.get('/attendance/reconciliation/day/:employeeUid/:date', authenticate, reconciliation.day);
  router.get('/attendance/reconciliation/month/:employeeUid/:year/:month', authenticate, reconciliation.month);
  router.get('/attendance/reconciliation/fiscal-year/:employeeUid/:fiscalYear', authenticate, reconciliation.fiscalYear);

  // R-05: read-only annual HR report. `:fiscalYear` is the BUDDHIST ERA year (e.g. 2569); `:year` on the
  // academic route is the GREGORIAN year the academic year starts. The export pair mirrors R-03: `format`
  // is required and has no default, and the response is a file, not the JSON envelope.
  router.get('/attendance/report/fiscal-year/:employeeUid/:fiscalYear', authenticate, annualReport.fiscalYear);
  router.get('/attendance/report/annual-academic/:employeeUid/:year', authenticate, annualReport.academicAnnual);
  router.get('/attendance/export/fiscal-year/:employeeUid/:fiscalYear', authenticate, annualReport.exportFiscalYear);
  router.get('/attendance/export/annual-academic/:employeeUid/:year', authenticate, annualReport.exportAcademicAnnual);

  return router;
}

module.exports = { createV1Router };
