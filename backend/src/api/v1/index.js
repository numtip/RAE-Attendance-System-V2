const express = require('express');
const healthRoutes = require('./routes/health');
const readyRoutes = require('./routes/ready');
const { HttpError } = require('../../utils/httpError');
const { createAuthenticate } = require('../../middleware/authenticate');
const { createAuthController } = require('../../controllers/authController');
const { createSsoController } = require('../../controllers/ssoController');
const { createEmployeeController } = require('../../controllers/employeeController');
const { createAttendanceController } = require('../../controllers/attendanceController');
const { createLeaveController } = require('../../controllers/leaveController');
const { createAuthService } = require('../../services/authService');
const { createEmployeeService } = require('../../services/employeeService');
const { createAttendanceService } = require('../../services/attendanceService');
const { createAttendanceRecordService } = require('../../services/attendanceRecordService');
const { createFacescanAttendanceIngestionService } = require('../../services/facescanAttendanceIngestionService');
const { createLeaveReviewService } = require('../../services/leaveReviewService');
const { createDivisionReportService } = require('../../services/divisionReportService');
const { createLeaveMonthlyReportService } = require('../../services/leaveMonthlyReportService');
const { createLeaveService } = require('../../services/leaveService');
const { createLeaveEntitlementOverviewService } = require('../../services/leaveEntitlementOverviewService');
const { createLeaveOwnerEntryService } = require('../../services/leaveOwnerEntryService');
const { createLeaveBulkManagementService } = require('../../services/leaveBulkManagementService');
const { createSsoService } = require('../../services/ssoService');
const { createLoginAttemptStore } = require('../../services/sso/ssoLoginAttemptStore');
const { getPool, isDatabaseConfigured } = require('../../db/pool');
const { createAttendanceComputeService } = require('../../services/attendanceComputeService');
const { createAttendanceComputeController } = require('../../controllers/attendanceComputeController');
const { createReportService } = require('../../services/reportService');
const { createOrganizationReportService } = require('../../services/organizationReportService');
const { createReportController } = require('../../controllers/reportController');

function createV1Router(container) {
  const authService = createAuthService(container);
  const employeeService = createEmployeeService(container);
  const attendanceService = createAttendanceService(container);
  const attendanceRecordService = createAttendanceRecordService(container);
  const facescanIngestionService = createFacescanAttendanceIngestionService({
    repositories: container.repositories,
    recordService: attendanceRecordService,
  });
  const leaveService = createLeaveService(container);
  const attendanceComputeService = createAttendanceComputeService(container);
  // G-02: the login attempt store is chosen once, here, so there is a single place that decides
  // whether pending logins are shared across instances. A MariaDB pool is only obtained when the
  // container is actually backed by MariaDB; a fixture container never opens a connection.
  const loginAttemptPool =
    container.dataSource === 'mariadb' && isDatabaseConfigured(container.config.database)
      ? getPool(container.config.database)
      : undefined;
  const ssoService = createSsoService({
    ...container,
    stateStore: createLoginAttemptStore({ config: container.config, pool: loginAttemptPool }),
  });
  const auth = createAuthController(authService);
  const sso = createSsoController(ssoService, container);
  const employees = createEmployeeController(employeeService, attendanceService);
  const attendance = createAttendanceController(
    attendanceService,
    attendanceRecordService,
    facescanIngestionService,
  );
  const leave = createLeaveController(leaveService, createLeaveEntitlementOverviewService(container), createLeaveOwnerEntryService(container), createLeaveBulkManagementService(container));
  const attendanceCompute = createAttendanceComputeController(attendanceComputeService);
  const organizationReports = createOrganizationReportService(container);
  const reports = createReportController(
    createReportService(container),
    organizationReports,
    createLeaveMonthlyReportService(container),
    createDivisionReportService({ ...container, organizationReportService: organizationReports }),
    createLeaveReviewService(container),
  );
  const authenticate = createAuthenticate(container.repositories.accessTokenRevocations);

  const router = express.Router();
  router.use('/health', healthRoutes);
  router.use('/ready', readyRoutes);

  router.post('/auth/login', auth.login);
  router.post('/auth/refresh', auth.refresh);
  router.get('/auth/me', authenticate, auth.me);
  router.post('/auth/logout', authenticate, auth.logout);

  function methodNotAllowed(allowedMethod, code = 'SSO_METHOD_NOT_ALLOWED') {
    return (_req, _res, next) => {
      next(
        new HttpError(405, code, `Endpoint requires ${allowedMethod}`, { allow: allowedMethod }),
      );
    };
  }

  router.get('/auth/sso/login', sso.login);
  router.all('/auth/sso/login', methodNotAllowed('GET'));
  router.get('/auth/sso/callback', sso.callback);
  router.all('/auth/sso/callback', methodNotAllowed('GET', 'SSO_CALLBACK_METHOD'));
  router.post('/auth/sso/exchange', sso.exchange);
  router.all('/auth/sso/exchange', methodNotAllowed('POST'));
  router.get('/auth/sso/me', authenticate, sso.me);
  router.all('/auth/sso/me', methodNotAllowed('GET'));
  router.post('/auth/sso/logout', authenticate, sso.logout);
  router.all('/auth/sso/logout', methodNotAllowed('POST', 'SSO_LOGOUT_METHOD'));
  // Public and idempotent: ends the MJU IdP session and lands the browser safely. Revokes nothing.
  router.get('/auth/sso/signout', sso.signout);
  router.all('/auth/sso/signout', methodNotAllowed('GET'));

  router.get('/employees', authenticate, employees.list);
  router.get('/employees/:employeeUid/attendance', authenticate, employees.attendance);
  router.get('/employees/:employeeUid', authenticate, employees.detail);

  router.get('/attendance/daily/:date', authenticate, attendance.daily);
  // Staff cannot list the whole organisation, but they can always read their own day.
  router.get('/attendance/me/:date', authenticate, attendance.me);
  router.get('/attendance/monthly/:employeeUid/:year/:month', authenticate, attendance.monthly);
  // The first writer for daily_attendance: evaluate one employee-day with AR-0001, persist it, and
  // re-derive that employee-month. No new migration — 004/005/023/024 already carry the columns.
  router.post('/attendance/daily/:employeeUid/:date', authenticate, attendance.record);
  // Promote that day's resolved facescan scans into attendance_events and derive the day from them.
  router.post('/attendance/facescan/:employeeUid/:date', authenticate, attendance.deriveFacescan);
  router.post('/attendance/evaluate-day', authenticate, attendanceCompute.evaluateDay);
  router.post('/attendance/evaluate-period', authenticate, attendanceCompute.evaluatePeriod);
  router.post('/attendance/explain', authenticate, attendanceCompute.explainResult);

  router.get('/leave', authenticate, leave.list);
  router.get('/leave/entitlements', authenticate, leave.entitlements);
  router.get('/leave/entitlements/template', authenticate, leave.entitlementTemplate);
  router.post('/leave/entitlements/import', authenticate, leave.importEntitlementFiles);
  router.post('/leave/entitlements/eligibility', authenticate, leave.bulkEligibility);
  router.put('/leave/entitlements/:employeeUid', authenticate, leave.saveEntitlementFacts);
  router.get('/leave/balance/:employeeUid', authenticate, leave.balance);
  router.get('/leave/history/:employeeUid', authenticate, leave.history);

  router.get('/reports/organization/export', authenticate, reports.organizationExport);
  router.get('/reports/organization', authenticate, reports.organization);
  router.get('/leave-review', authenticate, reports.leaveReviewList);
  router.post('/leave-review/decisions', authenticate, reports.leaveReviewDecide);
  router.get('/reports/divisions', authenticate, reports.divisions);
  router.get('/reports/leave-monthly/export', authenticate, reports.leaveMonthlyExport);
  router.get('/reports/leave-monthly', authenticate, reports.leaveMonthly);
  router.get('/reports/personal/export', authenticate, reports.personalExport);
  router.get('/reports/personal', authenticate, reports.personal);

  return router;
}

module.exports = { createV1Router };
