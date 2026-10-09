const { mapRow } = require('./rowMapper');
const {
  normalizeIdentifierValue,
  isStoredIdentifierType,
} = require('../../domain/employeeIdentifier');
const {
  IdentifierCryptoError,
  WRITE_LOCK_NAME,
  buildAuditEvent,
  createNationalIdProtector,
} = require('../../security/nationalIdContract');

// Requires migration 015 (lookup_key_version, audit table). 015 is additive/NULLable, so it is safe to
// apply BEFORE deploying this code; deploying this code before 015 fails closed on identifier queries.
const COLUMNS = `id, employee_uid, id_type, id_value, lookup_key_version, source_system, is_primary, status,
  verified_at, created_at, updated_at`;
const DEFAULT_ACTOR = 'system:identity-service';
const LOCK_TIMEOUT_SECONDS = 10;

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function mapIdentifier(row) {
  if (!row) return null;
  const mapped = mapRow(row);
  const protectedType = mapped.idType === 'national_id';
  return {
    id: mapped.id,
    employeeUid: mapped.employeeUid,
    idType: mapped.idType,
    // national_id rows hold only an HMAC lookup: never expose it (it is a stable pseudonymous identifier).
    idValue: protectedType ? null : mapped.idValue,
    lookupKeyVersion: protectedType ? mapped.lookupKeyVersion ?? null : undefined,
    sourceSystem: mapped.sourceSystem,
    isPrimary: Boolean(mapped.isPrimary),
    status: mapped.status,
    verifiedAt: mapped.verifiedAt ? new Date(mapped.verifiedAt).toISOString() : null,
    createdAt: new Date(mapped.createdAt).toISOString(),
    updatedAt: new Date(mapped.updatedAt).toISOString(),
  };
}

function auditValues(event) {
  return [
    event.identifier_id, event.employee_uid, event.action, event.key_version,
    event.actor, event.reason, event.created_at,
  ];
}

const AUDIT_SQL = `INSERT INTO employee_identifier_access_audit
  (identifier_id, employee_uid, action, key_version, actor, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`;

/**
 * InnoDB may pick a deadlock victim when several writers race for the same (type,value) unique key (for example
 * when a migration-017 namespace collision rolls the winner back). The victim statement is fully rolled back, so a
 * bounded retry is safe: the retry then reports the real outcome (success / duplicate / namespace collision).
 */
async function withDeadlockRetry(fn, attempts = 5) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const retryable = error && (error.errno === 1213 || error.code === 'ER_LOCK_DEADLOCK');
      if (!retryable || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 30) * attempt));
    }
  }
}

function createEmployeeIdentifierMariaDbRepository(pool, { nationalId = null } = {}) {
  let protector = nationalId;
  const getProtector = () => {
    if (!protector) protector = createNationalIdProtector(process.env);
    return protector;
  };

  async function findNational(idValue, ctx = {}) {
    const candidates = getProtector().lookupCandidates(idValue); // throws NOT_CONFIGURED: fail closed, no plaintext fallback
    const [rows] = await pool.query(
      `SELECT ${COLUMNS} FROM employee_identifier
       WHERE id_type = 'national_id' AND id_value IN (?) AND status = 'active'
       ORDER BY lookup_key_version DESC LIMIT 1`,
      [candidates.map((c) => c.lookup_hmac)],
    );
    const found = mapIdentifier(rows[0]);
    // Best-effort lookup audit: an audit outage must not take down SSO resolution; create is mandatory.
    const event = buildAuditEvent({
      action: 'lookup',
      actor: ctx.actor || DEFAULT_ACTOR,
      reason: ctx.reason || (found ? 'resolve:hit' : 'resolve:miss'),
      keyVersion: found?.lookupKeyVersion ?? null,
      employeeUid: found?.employeeUid ?? null,
      identifierId: found?.id ?? null,
    }); // unsafe actor/reason text throws here (caller bug) and is not swallowed
    try {
      await pool.query(AUDIT_SQL, auditValues(event));
    } catch {
      /* audit storage outage: tolerated for lookups only */
    }
    return found;
  }

  async function insertNational(input) {
    const p = getProtector();
    p.assertWritable();
    const current = p.lookupCurrent(input.idValue);
    const candidates = p.lookupCandidates(input.idValue);
    const now = new Date();
    const connection = await pool.getConnection();
    let locked = false;
    try {
      // Serialize ALL national_id writes: UNIQUE(id_type,id_value) cannot see cross-key-version duplicates.
      const [[lock]] = await connection.query('SELECT GET_LOCK(?, ?) AS acquired', [WRITE_LOCK_NAME, LOCK_TIMEOUT_SECONDS]);
      if (Number(lock.acquired) !== 1) throw codedError('WRITE_LOCK_TIMEOUT');
      locked = true;
      await connection.beginTransaction();

      const [existing] = await connection.query(
        `SELECT id, employee_uid, id_value, lookup_key_version, status FROM employee_identifier
         WHERE id_type = 'national_id' AND id_value IN (?) FOR UPDATE`,
        [candidates.map((c) => c.lookup_hmac)],
      );
      if (existing.length > 0) {
        await connection.rollback();
        const hit = existing[0];
        if (hit.employee_uid === input.employeeUid && hit.status === 'active') {
          const [rows] = await connection.query(`SELECT ${COLUMNS} FROM employee_identifier WHERE id = ?`, [hit.id]);
          return mapIdentifier(rows[0]);
        }
        throw codedError('DUPLICATE_IDENTIFIER');
      }

      let insertId;
      try {
        const [result] = await connection.query(
          `INSERT INTO employee_identifier (
             employee_uid, id_type, id_value, lookup_key_version, source_system, is_primary, status,
             verified_at, created_at, updated_at
           ) VALUES (?, 'national_id', ?, ?, ?, ?, 'active', ?, ?, ?)`,
          [
            input.employeeUid, current.lookup_hmac, current.key_version, input.sourceSystem ?? null,
            input.isPrimary ? 1 : 0, input.verifiedAt ?? null, now, now,
          ],
        );
        insertId = result.insertId;
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
          if (String(error.sqlMessage || '').includes('uk_employee_identifier_national_owner')) {
            throw codedError('EMPLOYEE_ALREADY_HAS_NATIONAL_ID');
          }
          throw codedError('DUPLICATE_IDENTIFIER');
        }
        if (error.code === 'ER_NO_REFERENCED_ROW_2') throw codedError('UNKNOWN_EMPLOYEE');
        throw error;
      }

      const event = buildAuditEvent({
        action: 'create',
        actor: input.actor || DEFAULT_ACTOR,
        reason: input.reason || 'link:national_id',
        keyVersion: current.key_version,
        employeeUid: input.employeeUid,
        identifierId: insertId,
        now,
      });
      await connection.query(AUDIT_SQL, auditValues(event)); // mandatory, same transaction
      await connection.commit();
      const [rows] = await connection.query(`SELECT ${COLUMNS} FROM employee_identifier WHERE id = ?`, [insertId]);
      return mapIdentifier(rows[0]);
    } catch (error) {
      try { await connection.rollback(); } catch { /* nothing to roll back */ }
      throw error;
    } finally {
      if (locked) {
        try { await connection.query('SELECT RELEASE_LOCK(?)', [WRITE_LOCK_NAME]); } catch { /* connection lost => lock freed */ }
      }
      connection.release();
    }
  }

  return {
    async findActiveByTypeAndValue(idType, idValue, ctx = {}) {
      const normalized = normalizeIdentifierValue(idType, idValue);
      if (idType === 'national_id') {
        if (!normalized) throw new IdentifierCryptoError('INVALID_IDENTIFIER');
        return findNational(normalized, ctx);
      }
      const [rows] = await pool.query(
        `SELECT ${COLUMNS} FROM employee_identifier
         WHERE id_type = ? AND id_value = ? AND status = 'active'
         LIMIT 1`,
        [idType, normalized],
      );
      return mapIdentifier(rows[0]);
    },

    async listByEmployeeUid(employeeUid, { includeInactive = false } = {}) {
      const statusClause = includeInactive ? '' : " AND status = 'active'";
      const [rows] = await pool.query(
        `SELECT ${COLUMNS} FROM employee_identifier
         WHERE employee_uid = ?${statusClause}
         ORDER BY id_type, id`,
        [employeeUid],
      );
      return rows.map((row) => mapIdentifier(row));
    },

    async insert(input) {
      if (!isStoredIdentifierType(input.idType)) {
        throw codedError('INVALID_IDENTIFIER_TYPE');
      }
      const idValue = normalizeIdentifierValue(input.idType, input.idValue);
      if (input.idType === 'national_id') {
        if (!idValue) throw new IdentifierCryptoError('INVALID_IDENTIFIER');
        return insertNational({ ...input, idValue });
      }
      const now = new Date();
      try {
        const [result] = await withDeadlockRetry(() => pool.query(
          `INSERT INTO employee_identifier (
             employee_uid, id_type, id_value, source_system, is_primary, status, verified_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
          [
            input.employeeUid,
            input.idType,
            idValue,
            input.sourceSystem ?? null,
            input.isPrimary ? 1 : 0,
            input.verifiedAt ?? null,
            now,
            now,
          ],
        ));
        const [rows] = await pool.query(
          `SELECT ${COLUMNS} FROM employee_identifier WHERE id = ? LIMIT 1`,
          [result.insertId],
        );
        return mapIdentifier(rows[0]);
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
          const existing = await this.findActiveByTypeAndValue(input.idType, idValue);
          if (existing && existing.employeeUid === input.employeeUid) {
            return existing;
          }
          throw codedError('DUPLICATE_IDENTIFIER');
        }
        if (error.code === 'ER_NO_REFERENCED_ROW_2') {
          throw codedError('UNKNOWN_EMPLOYEE');
        }
        // Migration 017 trigger: same facescan_id/personnel_id text owned by another employee (atomic, DB-level).
        if (error.sqlState === '45000' && String(error.sqlMessage || error.message).includes('IDENTIFIER_NAMESPACE_COLLISION')) {
          throw codedError('IDENTIFIER_NAMESPACE_COLLISION');
        }
        throw error;
      }
    },

    async deactivate(id, employeeUid) {
      const [result] = await pool.query(
        `UPDATE employee_identifier
         SET status = 'inactive', updated_at = ?
         WHERE id = ? AND employee_uid = ? AND status = 'active'`,
        [new Date(), id, employeeUid],
      );
      return result.affectedRows > 0;
    },
  };
}

module.exports = { createEmployeeIdentifierMariaDbRepository };
