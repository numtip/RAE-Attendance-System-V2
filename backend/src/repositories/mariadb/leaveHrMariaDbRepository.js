const { randomUUID } = require('node:crypto');

/**
 * HR-confirmed leave data: profile facts (034), verified entitlements (035) and the import ledger + audit (036).
 *
 * Reads treat a missing table as "no rows" (like the leave-record repository) so the service keeps working on a
 * database where 034-036 have not been applied yet. Writes never swallow that error.
 *
 * `transaction(fn)` hands `fn` a repository bound to one connection; it commits when `fn` resolves and rolls
 * back when it throws, so a partly applied import can never remain.
 */

function isMissingTable(error) {
  return error && (error.code === 'ER_NO_SUCH_TABLE' || error.errno === 1146);
}

const num = (v) => (v === null || v === undefined ? null : Number(v));

function profileRow(r) {
  return {
    employeeUid: r.employee_uid,
    continuousServiceStart: r.continuous_service_start,
    appointmentKind: r.appointment_kind,
    eligibilityConfirmed: r.eligibility_confirmed === null ? null : Boolean(r.eligibility_confirmed),
    eligibilityReference: r.eligibility_reference,
    sourceReference: r.source_reference,
    verifiedByUid: r.verified_by_uid,
  };
}

function entitlementRow(r) {
  return {
    employeeUid: r.employee_uid,
    fiscalYearBe: Number(r.fiscal_year_be),
    leaveType: r.leave_type,
    entitlementDays: num(r.entitlement_days),
    carryoverDays: num(r.carryover_days),
    usageBaselineDays: num(r.usage_baseline_days),
    usageBaselineThrough: r.usage_baseline_through,
    sourceReference: r.source_reference,
    importBatchUid: r.import_batch_uid,
    verifiedByUid: r.verified_by_uid,
  };
}

const PROFILE_SELECT = `SELECT employee_uid, DATE_FORMAT(continuous_service_start, '%Y-%m-%d') AS continuous_service_start,
       appointment_kind, eligibility_confirmed, eligibility_reference, source_reference, verified_by_uid
  FROM employee_leave_profile`;
const ENTITLEMENT_SELECT = `SELECT employee_uid, fiscal_year_be, leave_type, entitlement_days, carryover_days, usage_baseline_days,
       DATE_FORMAT(usage_baseline_through, '%Y-%m-%d') AS usage_baseline_through, source_reference, import_batch_uid, verified_by_uid
  FROM employee_leave_entitlement`;

function buildRepository(db, withTransaction) {
  const readSafely = async (sql, params) => {
    try {
      const [rows] = await db.query(sql, params);
      return rows;
    } catch (error) {
      if (isMissingTable(error)) return [];
      throw error;
    }
  };

  return {
    async getProfile(employeeUid) {
      const rows = await readSafely(`${PROFILE_SELECT} WHERE employee_uid = ?`, [employeeUid]);
      return rows[0] ? profileRow(rows[0]) : null;
    },

    /** One query for many employees (never one per employee). */
    async listProfiles(employeeUids) {
      if (!employeeUids.length) return [];
      return (await readSafely(`${PROFILE_SELECT} WHERE employee_uid IN (?)`, [employeeUids])).map(profileRow);
    },

    async upsertProfile(p) {
      await db.query(
        `INSERT INTO employee_leave_profile
           (employee_uid, continuous_service_start, appointment_kind, eligibility_confirmed, eligibility_reference,
            source_reference, verified_by_uid, verified_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())
         ON DUPLICATE KEY UPDATE continuous_service_start = VALUES(continuous_service_start),
           appointment_kind = VALUES(appointment_kind), eligibility_confirmed = VALUES(eligibility_confirmed),
           eligibility_reference = VALUES(eligibility_reference), source_reference = VALUES(source_reference),
           verified_by_uid = VALUES(verified_by_uid), verified_at = NOW(), updated_at = NOW()`,
        [p.employeeUid, p.continuousServiceStart, p.appointmentKind,
          p.eligibilityConfirmed === null ? null : (p.eligibilityConfirmed ? 1 : 0), p.eligibilityReference,
          p.sourceReference, p.verifiedByUid],
      );
    },

    async listEntitlements(employeeUid, fiscalYearBe) {
      return (await readSafely(`${ENTITLEMENT_SELECT} WHERE employee_uid = ? AND fiscal_year_be = ? ORDER BY leave_type`,
        [employeeUid, fiscalYearBe])).map(entitlementRow);
    },

    /** One query for many employees in one fiscal year. */
    async listEntitlementsForYear(employeeUids, fiscalYearBe) {
      if (!employeeUids.length) return [];
      return (await readSafely(`${ENTITLEMENT_SELECT} WHERE fiscal_year_be = ? AND employee_uid IN (?)`,
        [fiscalYearBe, employeeUids])).map(entitlementRow);
    },

    async getEntitlement(employeeUid, fiscalYearBe, leaveType) {
      const rows = await readSafely(`${ENTITLEMENT_SELECT} WHERE employee_uid = ? AND fiscal_year_be = ? AND leave_type = ?`,
        [employeeUid, fiscalYearBe, leaveType]);
      return rows[0] ? entitlementRow(rows[0]) : null;
    },

    async upsertEntitlement(e) {
      await db.query(
        `INSERT INTO employee_leave_entitlement
           (employee_uid, fiscal_year_be, leave_type, entitlement_days, carryover_days, usage_baseline_days,
            usage_baseline_through, source_reference, import_batch_uid, verified_by_uid, verified_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())
         ON DUPLICATE KEY UPDATE entitlement_days = VALUES(entitlement_days), carryover_days = VALUES(carryover_days),
           usage_baseline_days = VALUES(usage_baseline_days), usage_baseline_through = VALUES(usage_baseline_through),
           source_reference = VALUES(source_reference), import_batch_uid = VALUES(import_batch_uid),
           verified_by_uid = VALUES(verified_by_uid), verified_at = NOW(), updated_at = NOW()`,
        [e.employeeUid, e.fiscalYearBe, e.leaveType, e.entitlementDays, e.carryoverDays, e.usageBaselineDays,
          e.usageBaselineThrough, e.sourceReference, e.importBatchUid, e.verifiedByUid],
      );
    },

    async findBatch(kind, fileSha256) {
      const rows = await readSafely(
        'SELECT batch_uid, kind, file_sha256, rows_read, rows_applied, rows_unchanged FROM leave_hr_import_batch WHERE kind = ? AND file_sha256 = ?',
        [kind, fileSha256],
      );
      return rows[0] ? {
        batchUid: rows[0].batch_uid, kind: rows[0].kind, fileSha256: rows[0].file_sha256,
        rowsRead: rows[0].rows_read, rowsApplied: rows[0].rows_applied, rowsUnchanged: rows[0].rows_unchanged,
      } : null;
    },

    async insertBatch(batch) {
      const batchUid = batch.batchUid || randomUUID();
      await db.query(
        `INSERT INTO leave_hr_import_batch (batch_uid, kind, file_sha256, rows_read, rows_applied, rows_unchanged, operator_uid, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
        [batchUid, batch.kind, batch.fileSha256, batch.rowsRead, batch.rowsApplied, batch.rowsUnchanged, batch.operatorUid],
      );
      return batchUid;
    },

    async appendAudit(entries) {
      for (const a of entries) {
        await db.query(
          `INSERT INTO leave_hr_audit (batch_uid, employee_uid, table_name, field_name, entity_key, before_value, after_value, actor_uid, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
          [a.batchUid, a.employeeUid, a.tableName, a.fieldName, a.entityKey ?? null,
            a.beforeValue === null || a.beforeValue === undefined ? null : String(a.beforeValue).slice(0, 200),
            a.afterValue === null || a.afterValue === undefined ? null : String(a.afterValue).slice(0, 200), a.actorUid],
        );
      }
    },

    async listAudit(batchUid) {
      const rows = await readSafely(
        'SELECT employee_uid, table_name, field_name, entity_key, before_value, after_value FROM leave_hr_audit WHERE batch_uid = ? ORDER BY id',
        [batchUid],
      );
      return rows.map((r) => ({
        employeeUid: r.employee_uid, tableName: r.table_name, fieldName: r.field_name, entityKey: r.entity_key,
        beforeValue: r.before_value, afterValue: r.after_value,
      }));
    },

    /** employees.hire_date (existing column): the only column of `employees` this repository writes. */
    /** Removes one verified entitlement row (the owner undoing an override); the audit row is written by the caller. */
    async deleteEntitlement(employeeUid, fiscalYearBe, leaveType) {
      const [result] = await db.query('DELETE FROM employee_leave_entitlement WHERE employee_uid = ? AND fiscal_year_be = ? AND leave_type = ?', [employeeUid, fiscalYearBe, leaveType]);
      return result.affectedRows > 0;
    },

    async setHireDate(employeeUid, hireDate) {
      const [result] = await db.query('UPDATE employees SET hire_date = ?, updated_at = NOW() WHERE employee_uid = ?', [hireDate, employeeUid]);
      return result.affectedRows > 0;
    },

    transaction: withTransaction,
  };
}

function createLeaveHrMariaDbRepository(pool) {
  const transaction = async (fn) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const bound = buildRepository(connection, () => { throw new Error('transactions do not nest'); });
      const result = await fn(bound);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  };
  return buildRepository(pool, transaction);
}

module.exports = { createLeaveHrMariaDbRepository };
