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

  return router;
}

module.exports = { createV1Router };
