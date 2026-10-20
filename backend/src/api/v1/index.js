const express = require('express');
const healthRoutes = require('./routes/health');
const readyRoutes = require('./routes/ready');
const { createAuthenticate } = require('../../middleware/authenticate');
const { createAuthController } = require('../../controllers/authController');
const { createSsoController } = require('../../controllers/ssoController');
const { createEmployeeController } = require('../../controllers/employeeController');
const { createAttendanceController } = require('../../controllers/attendanceController');
const { createLeaveController } = require('../../controllers/leaveController');
const { createAuthService } = require('../../services/authService');
const { createEmployeeService } = require('../../services/employeeService');
const { createAttendanceService } = require('../../services/attendanceService');
const { createLeaveService } = require('../../services/leaveService');
const { createSsoService } = require('../../services/ssoService');
const { createAttendanceComputeService } = require('../../services/attendanceComputeService');
const { createAttendanceComputeController } = require('../../controllers/attendanceComputeController');
const { createReportService } = require('../../services/reportService');
const { createReportController } = require('../../controllers/reportController');

function createV1Router(container) {
  const authService = createAuthService(container);
  const employeeService = createEmployeeService(container);
  const attendanceService = createAttendanceService(container);
  const leaveService = createLeaveService(container);
  const attendanceComputeService = createAttendanceComputeService(container);
  const ssoService = createSsoService(container);
  const auth = createAuthController(authService);
  const sso = createSsoController(ssoService, container);
  const employees = createEmployeeController(employeeService, attendanceService);
  const attendance = createAttendanceController(attendanceService);
  const leave = createLeaveController(leaveService);
  const attendanceCompute = createAttendanceComputeController(attendanceComputeService);
  const reports = createReportController(createReportService(container));
  const authenticate = createAuthenticate(container.repositories.accessTokenRevocations);

  const router = express.Router();
  router.use('/health', healthRoutes);
  router.use('/ready', readyRoutes);

  router.post('/auth/login', auth.login);
  router.post('/auth/refresh', auth.refresh);
  router.get('/auth/me', authenticate, auth.me);
  router.post('/auth/logout', authenticate, auth.logout);

  router.get('/auth/sso/login', sso.login);
  router.get('/auth/sso/callback', sso.callback);
  router.get('/auth/sso/me', authenticate, sso.me);
  router.post('/auth/sso/logout', authenticate, sso.logout);

  router.get('/employees', authenticate, employees.list);
  router.get('/employees/:employeeUid/attendance', authenticate, employees.attendance);
  router.get('/employees/:employeeUid', authenticate, employees.detail);

  router.get('/attendance/daily/:date', authenticate, attendance.daily);
  router.get('/attendance/monthly/:employeeUid/:year/:month', authenticate, attendance.monthly);
  router.post('/attendance/evaluate-day', authenticate, attendanceCompute.evaluateDay);
  router.post('/attendance/evaluate-period', authenticate, attendanceCompute.evaluatePeriod);
  router.post('/attendance/explain', authenticate, attendanceCompute.explainResult);

  router.get('/leave', authenticate, leave.list);
  router.get('/leave/balance/:employeeUid', authenticate, leave.balance);
  router.get('/leave/history/:employeeUid', authenticate, leave.history);

  router.get('/reports/personal/export', authenticate, reports.personalExport);
  router.get('/reports/personal', authenticate, reports.personal);

  return router;
}

module.exports = { createV1Router };
