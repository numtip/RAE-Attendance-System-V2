const { HttpError } = require('../utils/httpError');
const { resolveScope } = require('./authorizationService');
const { backupBeforeWrite } = require('./productionBackup');
const engine = require('../domain/attendanceRuleEngine');
const { deriveSummary } = require('./attendanceRecordService');
const { createAttendanceMariaDbRepository } = require('../repositories/mariadb/attendanceMariaDbRepository');
const { createAttendanceHolidayMariaDbRepository } = require('../repositories/mariadb/attendanceHolidayMariaDbRepository');
const { getPool } = require('../db/pool');

function createHolidayManagementService(container, backup = backupBeforeWrite) {
  const { repositories } = container;
  async function owner(auth) {
    if (!(await resolveScope(auth, repositories, 'data')).all) throw new HttpError(403, 'FORBIDDEN', 'Owner access required');
  }
  async function recalculate(connection, dates) {
    const holidayRepo = createAttendanceHolidayMariaDbRepository(connection);
    const attendance = createAttendanceMariaDbRepository(connection);
    for (const date of new Set(dates)) {
      const holiday = (await holidayRepo.listApproved(date, date)).length > 0;
      const [rows] = await connection.query(`SELECT employee_uid, is_leave,
        DATE_FORMAT(DATE_ADD(check_in, INTERVAL 7 HOUR), '%H:%i') AS check_in,
        DATE_FORMAT(DATE_ADD(check_out, INTERVAL 7 HOUR), '%H:%i') AS check_out
        FROM daily_attendance WHERE date = ? FOR UPDATE`, [date]);
      for (const row of rows) {
        let evaluation;
        try { evaluation = engine.evaluateDay({ date, checkIn: row.check_in, checkOut: row.check_out, leave: Boolean(row.is_leave) }, { holiday }); }
        catch (error) {
          if (error.code !== 'RULE_YEAR_NOT_APPROVED') throw error;
          evaluation = { status: engine.STATUS.NO_DATA, isWorkday: true, lateMinutes: 0, earlyLeaveMinutes: 0, ruleVersion: null, reasons: ['rule_year_not_approved'], pendingPolicy: true };
        }
        const weekend = [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
        const classification = evaluation.isWorkday ? 'workday' : weekend ? 'weekend' : 'holiday';
        const status = evaluation.pendingPolicy || evaluation.status === engine.STATUS.NO_DATA ? 'pending'
          : evaluation.status === engine.STATUS.HOLIDAY ? 'holiday'
            : evaluation.status === engine.STATUS.LEAVE ? 'leave'
              : [engine.STATUS.LATE, engine.STATUS.LATE_AND_EARLY_LEAVE].includes(evaluation.status) ? 'late' : 'present';
        const computation = evaluation.pendingPolicy ? 'pending_policy' : evaluation.status === engine.STATUS.NO_DATA ? 'no_data' : 'calculated';
        await connection.query(`UPDATE daily_attendance SET status=?, day_classification=?, computation_status=?,
          is_late=?, late_minutes=?, early_minutes=?, rule_version_code=?, calculated_at=UTC_TIMESTAMP(),
          reconciliation_json=JSON_SET(IF(JSON_VALID(reconciliation_json), reconciliation_json, '{}'),
            '$.engineStatus', ?, '$.reasons', JSON_EXTRACT(?, '$')), updated_at=UTC_TIMESTAMP()
          WHERE employee_uid=? AND date=?`, [status, classification, computation, status === 'late' ? 1 : 0,
          evaluation.lateMinutes || 0, evaluation.earlyLeaveMinutes || 0, evaluation.ruleVersion,
          evaluation.pendingPolicy ? 'rule_year_not_approved' : evaluation.status, JSON.stringify(evaluation.reasons || []), row.employee_uid, date]);
      }
    }
    for (const period of new Set(dates.map((date) => date.slice(0, 7)))) {
      const [year, month] = period.split('-').map(Number);
      const end = `${period}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`;
      const holidays = await holidayRepo.listApproved(`${period}-01`, end);
      const excluded = new Set(holidays.map((h) => h.date).filter((date) => {
        const day = new Date(`${date}T00:00:00Z`).getUTCDay(); return day > 0 && day < 6;
      })).size;
      const [people] = await connection.query('SELECT employee_uid FROM monthly_summary WHERE year=? AND month=?', [year, month]);
      for (const { employee_uid: uid } of people) {
        const rows = (await attendance.findForEmployee(uid)).filter((row) => row.date.startsWith(period));
        const summary = deriveSummary(uid, year, month, rows);
        if (summary.expectedWorkingDays !== null) summary.expectedWorkingDays -= excluded;
        await attendance.upsertMonthly(summary);
      }
    }
  }
  function valid(body) {
    if (!engine.isCalendarDate(body.date) || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 255
      || !['candidate', 'approved'].includes(body.status) || typeof body.sourceReference !== 'string'
      || !/^https:\/\//.test(body.sourceReference) || body.sourceReference.length > 255) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Date, name, status and HTTPS source are required');
    }
  }
  return {
    async list(auth, year) {
      await owner(auth);
      if (!/^\d{4}$/.test(String(year))) throw new HttpError(400, 'VALIDATION_ERROR', 'Year is required');
      return repositories.attendanceHolidays.listAll(`${year}-01-01`, `${year}-12-31`);
    },
    async recalculateYear(auth, year) {
      await owner(auth);
      if (!/^\d{4}$/.test(String(year))) throw new HttpError(400, 'VALIDATION_ERROR', 'Year is required');
      if (container.dataSource !== 'mariadb') throw new HttpError(503, 'DB_UNAVAILABLE', 'Recalculation requires MariaDB');
      return repositories.facescanRaw.withImportLock(async () => {
        await backup(container);
        const connection = await getPool(container.config.database).getConnection();
        try {
          await connection.beginTransaction();
          const holidayDates = await createAttendanceHolidayMariaDbRepository(connection).listApproved(`${year}-01-01`, `${year}-12-31`);
          const dates = [...new Set(holidayDates.map((row) => row.date))];
          await recalculate(connection, dates);
          await connection.commit();
          return { dates: dates.length };
        } catch (error) { await connection.rollback(); throw error; }
        finally { connection.release(); }
      });
    },
    async change(auth, id, body, remove = false) {
      await owner(auth);
      if (container.dataSource !== 'mariadb') throw new HttpError(503, 'DB_UNAVAILABLE', 'Holiday management requires MariaDB');
      if (id && !/^\d+$/.test(String(id))) throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid holiday');
      if (!remove) valid(body);
      return repositories.facescanRaw.withImportLock(async () => {
        await backup(container);
        const connection = await getPool(container.config.database).getConnection();
        try {
          await connection.beginTransaction();
          let previous = null;
          if (id) {
            const [rows] = await connection.query("SELECT DATE_FORMAT(holiday_date, '%Y-%m-%d') AS date FROM attendance_holiday WHERE id=? AND scope IN ('national','university') FOR UPDATE", [id]);
            previous = rows[0];
            if (!previous) throw new HttpError(404, 'NOT_FOUND', 'Holiday not found');
          }
          if (remove) await connection.query('DELETE FROM attendance_holiday WHERE id=?', [id]);
          else if (id) await connection.query(`UPDATE attendance_holiday SET holiday_date=?, name=?, status=?, source_reference=?,
            source_system='owner', approved_by=?, approved_at=IF(?='approved', UTC_TIMESTAMP(), NULL), updated_at=UTC_TIMESTAMP() WHERE id=?`,
          [body.date, body.name.trim(), body.status, body.sourceReference, body.status === 'approved' ? auth.employeeUid : null, body.status, id]);
          else await connection.query(`INSERT INTO attendance_holiday (holiday_date,name,scope,status,source_system,source_reference,approved_by,approved_at,created_at,updated_at)
            VALUES (?,?,'university',?,'owner',?,?,IF(?='approved',UTC_TIMESTAMP(),NULL),UTC_TIMESTAMP(),UTC_TIMESTAMP())`,
          [body.date, body.name.trim(), body.status, body.sourceReference, body.status === 'approved' ? auth.employeeUid : null, body.status]);
          await recalculate(connection, [...new Set([previous?.date, remove ? null : body.date].filter(Boolean))]);
          await connection.commit();
          return { saved: true };
        } catch (error) { await connection.rollback(); throw error; }
        finally { connection.release(); }
      });
    },
  };
}
module.exports = { createHolidayManagementService };
