const { randomUUID } = require('node:crypto');
const { mapRow } = require('./rowMapper');
const { HttpError } = require('../../utils/httpError');
const {
  ASSIGNMENT_CONFLICT_CODES,
  normalizeEffectiveDate,
} = require('../../domain/employeeAssignment');

const COLUMNS = `assignment_uid, employee_uid, employee_code, department, position, employee_type,
  effective_from, effective_to, source_system, source_reference, recorded_at, created_at, updated_at`;

const INSERT_SQL = `INSERT INTO employee_assignment (
    assignment_uid, employee_uid, employee_code, department, position, employee_type,
    effective_from, effective_to, source_system, source_reference, recorded_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// Same-employee overlap: existing row still covers the new window when its upper bound is open or >= the
// new lower bound, AND its lower bound does not start after the new upper bound.
// The new upper bound may be NULL (open-ended); `? IS NULL OR ...` avoids `effective_from <= NULL`, which in
// MySQL evaluates to NULL (treated as false) and would silently skip open-ended inserts.
const OVERLAP_SQL = `SELECT assignment_uid FROM employee_assignment
   WHERE employee_uid = ?
     AND (effective_to IS NULL OR effective_to >= ?)
     AND (? IS NULL OR effective_from <= ?)
   LIMIT 1 FOR UPDATE`;

// Same predicate, scoped to a DIFFERENT employee that already owns the same employee_code ("ownership conflict").
const CODE_CONFLICT_SQL = `SELECT assignment_uid FROM employee_assignment
   WHERE employee_code = ?
     AND employee_uid <> ?
     AND (effective_to IS NULL OR effective_to >= ?)
     AND (? IS NULL OR effective_from <= ?)
   LIMIT 1 FOR UPDATE`;

const DUPLICATE_SQL = `SELECT assignment_uid FROM employee_assignment
   WHERE employee_uid = ? AND effective_from = ?
   LIMIT 1 FOR UPDATE`;

const DUPLICATE_CODE = 'ASSIGNMENT_DUPLICATE_EFFECTIVE_FROM';

function toIsoDate(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function toIsoTimestamp(value) {
  return value == null ? null : new Date(value).toISOString();
}

function mapAssignment(row) {
  if (!row) return null;
  const mapped = mapRow(row);
  return {
    assignmentUid: mapped.assignmentUid,
    employeeUid: mapped.employeeUid,
    employeeCode: mapped.employeeCode,
    department: mapped.department,
    position: mapped.position ?? null,
    employeeType: mapped.employeeType,
    // DATE columns arrive as Date objects (or plain strings with dateStrings); normalize to 'YYYY-MM-DD'.
    effectiveFrom: toIsoDate(mapped.effectiveFrom),
    effectiveTo: toIsoDate(mapped.effectiveTo),
    sourceSystem: mapped.sourceSystem,
    sourceReference: mapped.sourceReference ?? null,
    recordedAt: toIsoTimestamp(mapped.recordedAt),
    createdAt: toIsoTimestamp(mapped.createdAt),
    updatedAt: toIsoTimestamp(mapped.updatedAt),
  };
}

function normalizeWindow(input) {
  const effectiveFrom = normalizeEffectiveDate(input.effectiveFrom, 'effective_from');
  if (effectiveFrom == null) {
    throw new HttpError(400, 'ASSIGNMENT_INVALID_DATE', 'effective_from must be an ISO date (YYYY-MM-DD)');
  }
  const effectiveTo = normalizeEffectiveDate(input.effectiveTo, 'effective_to');
  if (effectiveTo != null && effectiveTo < effectiveFrom) {
    throw new HttpError(400, 'ASSIGNMENT_INVALID_WINDOW', 'effective_to must not be earlier than effective_from');
  }
  return { effectiveFrom, effectiveTo };
}

function createEmployeeAssignmentMariaDbRepository(pool) {
  return {
    async insert(input) {
      const { effectiveFrom, effectiveTo } = normalizeWindow(input);
      const now = new Date();
      const assignmentUid = randomUUID();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();

        // Exact same start date: reported as a duplicate before the broader overlap rule.
        const [duplicate] = await connection.query(DUPLICATE_SQL, [input.employeeUid, effectiveFrom]);
        if (duplicate.length > 0) {
          throw new HttpError(409, DUPLICATE_CODE, 'An assignment with that effective_from already exists for this employee');
        }

        const [overlap] = await connection.query(OVERLAP_SQL, [input.employeeUid, effectiveFrom, effectiveTo, effectiveTo]);
        if (overlap.length > 0) {
          throw new HttpError(409, ASSIGNMENT_CONFLICT_CODES.OVERLAP, 'The effective window overlaps an existing assignment for this employee');
        }

        const [codeConflict] = await connection.query(CODE_CONFLICT_SQL, [
          input.employeeCode, input.employeeUid, effectiveFrom, effectiveTo, effectiveTo,
        ]);
        if (codeConflict.length > 0) {
          throw new HttpError(409, ASSIGNMENT_CONFLICT_CODES.CODE_CONFLICT, 'The employee_code is held by another employee over an overlapping window');
        }

        try {
          await connection.query(INSERT_SQL, [
            assignmentUid, input.employeeUid, input.employeeCode, input.department, input.position ?? null,
            input.employeeType, effectiveFrom, effectiveTo, input.sourceSystem, input.sourceReference ?? null,
            now, now, now,
          ]);
        } catch (error) {
          // Backstop for a concurrent writer that committed between the SELECT and the INSERT.
          if (error.code === 'ER_DUP_ENTRY' && String(error.sqlMessage || '').includes('uk_employee_assignment_employee_from')) {
            throw new HttpError(409, DUPLICATE_CODE, 'An assignment with that effective_from already exists for this employee');
          }
          // fk_employee_assignment_employee. Coded so the fixture twin and this repo agree.
          if (error.code === 'ER_NO_REFERENCED_ROW_2') {
            throw new HttpError(404, 'ASSIGNMENT_UNKNOWN_EMPLOYEE', 'Employee was not found');
          }
          throw error;
        }

        await connection.commit();
        const [rows] = await connection.query(
          `SELECT ${COLUMNS} FROM employee_assignment WHERE assignment_uid = ? LIMIT 1`,
          [assignmentUid],
        );
        return mapAssignment(rows[0]);
      } catch (error) {
        try { await connection.rollback(); } catch { /* nothing to roll back */ }
        throw error;
      } finally {
        connection.release();
      }
    },

    async listByEmployeeUid(employeeUid, { onDate = null, includeFuture = true } = {}) {
      const date = normalizeEffectiveDate(onDate, 'onDate');
      const today = new Date().toISOString().slice(0, 10);
      const [rows] = await pool.query(
        `SELECT ${COLUMNS} FROM employee_assignment
         WHERE employee_uid = ?
           AND (? IS NULL OR (effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)))
           AND (? = 1 OR effective_from <= ?)
         ORDER BY effective_from ASC`,
        [employeeUid, date, date, date, includeFuture ? 1 : 0, today],
      );
      return rows.map((row) => mapAssignment(row));
    },

    async findEffectiveOn(employeeUid, date) {
      const onDate = normalizeEffectiveDate(date, 'date');
      if (onDate == null) {
        throw new HttpError(400, 'ASSIGNMENT_INVALID_DATE', 'date must be an ISO date (YYYY-MM-DD)');
      }
      const [rows] = await pool.query(
        `SELECT ${COLUMNS} FROM employee_assignment
         WHERE employee_uid = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
         ORDER BY effective_from DESC LIMIT 1`,
        [employeeUid, onDate, onDate],
      );
      return mapAssignment(rows[0]);
    },

    async closeAssignment(assignmentUid, employeeUid, effectiveTo) {
      const date = normalizeEffectiveDate(effectiveTo, 'effective_to');
      if (date == null) {
        throw new HttpError(400, 'ASSIGNMENT_INVALID_DATE', 'effective_to must be an ISO date (YYYY-MM-DD)');
      }
      const now = new Date();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [rows] = await connection.query(
          `SELECT ${COLUMNS} FROM employee_assignment
           WHERE assignment_uid = ? AND employee_uid = ? LIMIT 1 FOR UPDATE`,
          [assignmentUid, employeeUid],
        );
        const existing = mapAssignment(rows[0]);
        if (!existing) {
          await connection.rollback();
          return null;
        }
        if (date < existing.effectiveFrom) {
          throw new HttpError(400, 'ASSIGNMENT_INVALID_WINDOW', 'effective_to must not be earlier than effective_from');
        }
        // Closing must not CREATE an overlap: the closed row must still not intersect any other interval
        // owned by the same employee. Without this check a row could be re-closed past a later interval.
        const [overlap] = await connection.query(
          `SELECT assignment_uid FROM employee_assignment
            WHERE employee_uid = ? AND assignment_uid <> ?
              AND (effective_to IS NULL OR effective_to >= ?)
              AND effective_from <= ?
            LIMIT 1 FOR UPDATE`,
          [employeeUid, assignmentUid, existing.effectiveFrom, date],
        );
        if (overlap.length > 0) {
          throw new HttpError(409, ASSIGNMENT_CONFLICT_CODES.OVERLAP, 'Closing the window would overlap another assignment for this employee');
        }
        await connection.query(
          `UPDATE employee_assignment SET effective_to = ?, updated_at = ?
           WHERE assignment_uid = ? AND employee_uid = ?`,
          [date, now, assignmentUid, employeeUid],
        );
        await connection.commit();
        const [updated] = await connection.query(
          `SELECT ${COLUMNS} FROM employee_assignment WHERE assignment_uid = ? LIMIT 1`,
          [assignmentUid],
        );
        return mapAssignment(updated[0]);
      } catch (error) {
        try { await connection.rollback(); } catch { /* nothing to roll back */ }
        throw error;
      } finally {
        connection.release();
      }
    },
  };
}

module.exports = { createEmployeeAssignmentMariaDbRepository };
