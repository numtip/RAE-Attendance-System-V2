/**
 * Roster (owner-approved 2027 personnel source) vs the previous 54-code employee master.
 *
 * Purpose: produce a *reconciliation*, not an import. Nothing here writes, merges or deletes a record, and no
 * function returns a name, an email or a national ID to a caller that prints it. The detail (which code is
 * missing, which row changed) is written by the CLI to a gitignored path; stdout only ever receives counts.
 *
 * Identity keys, in the only order this project allows:
 *   1. HIP code (roster `ID HIP`) against the master's report/device code — the authoritative join.
 *   2. National ID, used *only* to detect a conflict (one national ID under two codes). It is never used to
 *      create a match, and it is never emitted.
 *   3. A name is never an identity key. It is compared only *after* the code has matched, to report a change.
 *
 * Everything is pure. The CLI supplies parsed rows.
 */

export const CONFLICT_KIND = Object.freeze({
  DUPLICATE_HIP_CODE: 'DUPLICATE_HIP_CODE',
  HIP_CODE_OWNED_TWICE: 'HIP_CODE_OWNED_TWICE',
  NATIONAL_ID_UNDER_TWO_CODES: 'NATIONAL_ID_UNDER_TWO_CODES',
  UNKNOWN_EMPLOYEE_TYPE: 'UNKNOWN_EMPLOYEE_TYPE',
  MISSING_NATIONAL_ID: 'MISSING_NATIONAL_ID',
  MISSING_EMAIL: 'MISSING_EMAIL',
  MASTER_ROW_WITHOUT_CODE: 'MASTER_ROW_WITHOUT_CODE',
});

export const CHANGE_KIND = Object.freeze({
  NAME: 'NAME',
  ABSENT_IN_ROSTER_HAS_ATTENDANCE: 'ABSENT_IN_ROSTER_HAS_ATTENDANCE',
});

/** `employee_type` enum from `002_employees.sql`. The roster's own vocabulary must map onto exactly this set. */
export const EMPLOYEE_TYPES = Object.freeze(['university', 'department', 'contract']);

/** `employees.status` enum from `002_employees.sql`. Anything else is reported as UNKNOWN, never echoed. */
export const EMPLOYMENT_STATUSES = Object.freeze(['active', 'inactive', 'resigned']);

const NATIONAL_ID_SHAPE = /^\d{13}$/;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(value) {
  return value == null ? '' : String(value).trim();
}

/**
 * Maps one parsed roster record (already keyed by header) to the shape this module understands.
 * The column meanings are evidence-based, not assumed: `name` and `c_name` are kept separate here because
 * whether they are "given name / family name" is an owner decision (F2), not something this module may decide.
 */
export function normalizeRosterRow(record, rowNumber) {
  const nameTh = text(record['name']);
  const cNameTh = text(record['c_name']);
  return {
    rowNumber,
    code: text(record['ID HIP']),
    nameTh,
    cNameTh,
    nationalId: text(record['ID card']),
    email: text(record['email']).toLowerCase(),
    employeeType: text(record['employee type']).toLowerCase(),
    employeeTypeDescription: text(record['คำอธิบาย']),
    // Never emitted. Used only for the change comparison and the conflict check.
    fullNameCandidate: [nameTh, cNameTh].filter(Boolean).join(' '),
  };
}

export function normalizeMasterRow(record) {
  // `employee_master_integration.csv` has report_code; `normalized_employee_master.csv` has device_code only.
  // A row may have *none* of them (one real row has neither a device nor an employee code). That row is kept
  // and reported as unkeyable — dropping it silently shrinks the denominator, which is exactly the failure
  // mode this project has already been bitten by.
  const code = text(record.report_code) || text(record.device_code) || text(record.employee_code);
  const attendanceRowsRaw = record.attendance_rows;
  const status = text(record.employment_status).toLowerCase();
  return {
    code,
    personKey: text(record.person_key),
    // Only a plain row reference is ever kept. Free text from a CSV must not travel into a summary or a log:
    // a malformed source could otherwise put a name or a national ID in a column we later echo.
    sourceRowRef: /^\d{1,9}$/.test(text(record.source_workbook_row)) ? text(record.source_workbook_row) : '',
    employeeCode: text(record.employee_code),
    deviceCode: text(record.device_code),
    fullName: text(record.full_name_th),
    department: text(record.department_current),
    // Allowlisted: an unknown status becomes UNKNOWN rather than being echoed as a raw CSV value.
    employmentStatus: EMPLOYMENT_STATUSES.includes(status) ? status : 'UNKNOWN',
    active: String(record.active).toLowerCase() === 'true',
    hasName: Boolean(text(record.full_name_th)),
    hasDepartment: Boolean(text(record.department_current)),
    // An absent column and a zero are different facts. Empty/absent reads as null (unknown), never as 0.
    inAttendanceEvidence: text(record.in_attendance_evidence) || null,
    attendanceRows: attendanceRowsRaw == null || String(attendanceRowsRaw).trim() === ''
      ? null
      : (Number.isFinite(Number(attendanceRowsRaw)) ? Number(attendanceRowsRaw) : null),
  };
}

function pushTo(map, key, value) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

/**
 * @param {object} input
 * @param {Array} input.rosterRows  normalized roster rows
 * @param {Array} input.masterRows  normalized master rows
 * @returns a reconciliation object. Contains identifiers; the CLI stores it as local detail only.
 */
export function reconcileRoster({ rosterRows = [], masterRows = [] } = {}) {
  const conflicts = [];
  const rosterByCode = new Map();
  const rosterByNationalId = new Map();

  // 1. Roster-internal checks. A duplicated code or a national ID under two codes is a conflict, not a match.
  for (const row of rosterRows) {
    pushTo(rosterByCode, row.code, row);
    pushTo(rosterByNationalId, row.nationalId, row);
    if (!row.nationalId) conflicts.push({ kind: CONFLICT_KIND.MISSING_NATIONAL_ID, code: row.code, rowNumber: row.rowNumber });
    else if (!NATIONAL_ID_SHAPE.test(row.nationalId)) {
      conflicts.push({ kind: CONFLICT_KIND.MISSING_NATIONAL_ID, code: row.code, rowNumber: row.rowNumber });
    }
    if (!row.email || !EMAIL_SHAPE.test(row.email)) {
      conflicts.push({ kind: CONFLICT_KIND.MISSING_EMAIL, code: row.code, rowNumber: row.rowNumber });
    }
    if (!EMPLOYEE_TYPES.includes(row.employeeType)) {
      conflicts.push({ kind: CONFLICT_KIND.UNKNOWN_EMPLOYEE_TYPE, code: row.code, rowNumber: row.rowNumber });
    }
  }
  const duplicateCodes = [...rosterByCode.entries()].filter(([, rows]) => rows.length > 1).map(([code]) => code);
  for (const code of duplicateCodes) conflicts.push({ kind: CONFLICT_KIND.DUPLICATE_HIP_CODE, code });

  for (const [nationalId, rows] of rosterByNationalId.entries()) {
    if (!nationalId) continue;
    const codes = [...new Set(rows.map((r) => r.code))];
    if (codes.length > 1) {
      conflicts.push({ kind: CONFLICT_KIND.NATIONAL_ID_UNDER_TWO_CODES, codes });
    }
  }

  // 2. Code join against the master. A master row with no usable code is reported, never skipped: silently
  //    dropping it would understate the population and hide a person from the reconciliation entirely.
  const masterByCode = new Map();
  const unkeyable = [];
  for (const row of masterRows) {
    if (!row.code) {
      unkeyable.push({ sourceRowRef: row.sourceRowRef, employmentStatus: row.employmentStatus, hasName: row.hasName });
      conflicts.push({ kind: CONFLICT_KIND.MASTER_ROW_WITHOUT_CODE, sourceRowRef: row.sourceRowRef });
      continue;
    }
    pushTo(masterByCode, row.code, row);
  }
  for (const [code, rows] of masterByCode.entries()) {
    if (rows.length > 1) conflicts.push({ kind: CONFLICT_KIND.HIP_CODE_OWNED_TWICE, code });
  }

  const matched = [];
  const extra = [];
  for (const [code, rows] of rosterByCode.entries()) {
    const master = masterByCode.get(code)?.[0];
    if (!master) {
      extra.push({ code, employeeType: EMPLOYEE_TYPES.includes(rows[0].employeeType) ? rows[0].employeeType : 'UNKNOWN' });
      continue;
    }
    const changedFields = [];
    if (master.fullName && rows[0].fullNameCandidate && master.fullName !== rows[0].fullNameCandidate) {
      changedFields.push(CHANGE_KIND.NAME);
    }
    matched.push({ code, changedFields, master, roster: rows[0] });
  }

  const missing = [];
  for (const [code, rows] of masterByCode.entries()) {
    if (rosterByCode.has(code)) continue;
    const master = rows[0];
    missing.push({
      code,
      employmentStatus: master.employmentStatus,
      active: master.active,
      hasName: master.hasName,
      hasDepartment: master.hasDepartment,
      inAttendanceEvidence: master.inAttendanceEvidence,
      attendanceRows: master.attendanceRows,
    });
  }

  // 3. Name-shape evidence for the F2 decision (counts only; no values).
  const masterNames = new Set(masterRows.map((m) => m.fullName).filter(Boolean));
  const masterTokens = new Set([...masterNames].flatMap((name) => name.split(/\s+/).filter(Boolean)));
  const nameEvidence = {
    masterNamesWithTwoTokens: [...masterNames].filter((name) => name.split(/\s+/).filter(Boolean).length === 2).length,
    rosterFirstTokenIsAMasterToken: matched.filter((m) => masterTokens.has(m.roster.nameTh)).length,
    rosterSecondTokenIsAMasterToken: matched.filter((m) => masterTokens.has(m.roster.cNameTh)).length,
    concatenationEqualsMasterName: matched.filter((m) => m.master.fullName === m.roster.fullNameCandidate).length,
  };

  const changed = matched.filter((m) => m.changedFields.length > 0);

  return {
    counts: {
      roster_rows: rosterRows.length,
      master_rows: masterRows.length,
      master_codes: masterByCode.size,
      master_rows_unkeyable: unkeyable.length,
      matched: matched.length,
      matched_with_changes: changed.length,
      missing_from_roster: missing.length,
      extra_in_roster: extra.length,
      conflicts: conflicts.length,
      conflicting_rows: new Set(conflicts.map((c) => c.code).filter(Boolean)).size,
    },
    matched: matched.map((m) => ({ code: m.code, changedFields: m.changedFields })),
    changed: changed.map((m) => ({ code: m.code, fields: m.changedFields })),
    missing,
    extra,
    conflicts,
    unkeyable,
    nameEvidence,
    // Every absence is flagged as needing preservation; none is a removal instruction.
    preservationNote: 'Rows in the master but absent from the roster keep their existing UID and attendance. '
      + 'Absence from a personnel export is not a resignation.',
  };
}

/**
 * The only shape that may be committed or printed. Counts and reason histograms; no code, name, email or
 * national ID. `assertNoPersonalData` enforces that on the way out.
 */
export function summarize(reconciliation) {
  const { counts, nameEvidence } = reconciliation;
  const byKind = {};
  for (const conflict of reconciliation.conflicts) byKind[conflict.kind] = (byKind[conflict.kind] || 0) + 1;

  // "Unknown" and "zero" are different facts: a master source without attendance columns must not report 0.
  const attendanceAvailable = reconciliation.missing.some(
    (m) => m.inAttendanceEvidence != null || m.attendanceRows != null,
  );
  const missingAttendance = attendanceAvailable
    ? reconciliation.missing.filter(
      (m) => m.inAttendanceEvidence === 'yes' || Number(m.attendanceRows || 0) > 0,
    ).length
    : null;

  return {
    counts: { ...counts },
    conflicts_by_kind: byKind,
    missing: {
      total: reconciliation.missing.length,
      attendance_evidence_available: attendanceAvailable,
      with_attendance_evidence: missingAttendance,
      by_employment_status: reconciliation.missing.reduce((acc, m) => {
        const key = m.employmentStatus || 'UNKNOWN';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
      without_a_confirmed_name: reconciliation.missing.filter((m) => !m.hasName).length,
      without_a_department: reconciliation.missing.filter((m) => !m.hasDepartment).length,
    },
    changes_by_field: reconciliation.changed.reduce((acc, change) => {
      for (const field of change.fields) acc[field] = (acc[field] || 0) + 1;
      return acc;
    }, {}),
    name_evidence: { ...nameEvidence },
  };
}

/** A 13-digit Thai national ID. A content digest can never match it: a digest is 32+ hex characters. */
const NATIONAL_ID_RUN = /\d{13}/;
/**
 * A hex content digest (sha256 of a file, an HMAC lookup, a fingerprint). These are checked first: a random
 * 64-character digest contains a 13-digit run about 5% of the time, so a naive guard rejected its own input
 * roughly 9% of runs with a misleading "13-digit value" error. A real national ID is exactly 13 digits and can
 * never be 32+ hex characters, so exempting whole digests cannot hide a leak.
 */
const HEX_DIGEST = /^[0-9a-f]{32,128}$/i;

/**
 * Refuses to hand out anything that looks like stored personal data: a 13-digit run (Thai national ID) or an
 * email address. Object **keys** and numeric values are checked too — a malformed CSV that lands a national ID
 * in `employment_status` would otherwise become a dictionary key and slip past a values-only scan.
 */
export function assertNoPersonalData(value, path = 'summary') {
  if (value == null) return value;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPersonalData(entry, `${path}[${index}]`));
    return value;
  }
  if (typeof value === 'number') {
    if (NATIONAL_ID_RUN.test(String(value))) throw new Error(`refusing to emit a 13-digit numeric value at ${path}`);
    return value;
  }
  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (!HEX_DIGEST.test(key)) {
        if (NATIONAL_ID_RUN.test(key)) throw new Error(`refusing to emit an object key containing a 13-digit value at ${path}`);
        if (EMAIL_SHAPE.test(key)) throw new Error(`refusing to emit an object key shaped like an email at ${path}`);
      }
      assertNoPersonalData(entry, `${path}.${key}`);
    }
    return value;
  }
  if (typeof value !== 'string') return value;
  if (HEX_DIGEST.test(value)) return value;
  if (NATIONAL_ID_RUN.test(value)) throw new Error(`refusing to emit a 13-digit value at ${path}`);
  if (EMAIL_SHAPE.test(value)) throw new Error(`refusing to emit an email address at ${path}`);
  return value;
}

/**
 * Detail output (which codes) may only ever be written inside the gitignored `database/local/` tree.
 * Traversal is rejected, so `database/local/../x` cannot be used to escape.
 */
export function assertLocalOutputPath(outputPath) {
  const normalized = String(outputPath || '').replace(/\\/g, '/');
  if (!/^database\/local\/[^/].*\.json$/.test(normalized) || normalized.includes('/../')) {
    throw new Error('detail output must be a .json path under database/local/ (gitignored)');
  }
  return normalized;
}

/**
 * Resolves the detail path against the REPOSITORY ROOT, not the current working directory.
 *
 * `assertLocalOutputPath` only checks the string, so `database/local/x.json` run from `backend/` would have
 * written `backend/database/local/x.json` — outside the gitignored tree. This resolves and then proves
 * containment, so the guarantee holds no matter where the CLI is invoked from.
 */
export function resolveLocalOutputPath(repoRoot, outputPath) {
  const normalized = assertLocalOutputPath(outputPath);
  const resolvedRoot = String(repoRoot).replace(/\\/g, '/').replace(/\/+$/, '');
  const localRoot = `${resolvedRoot}/database/local`;
  if (!resolvedRoot) throw new Error('repoRoot is required to resolve a detail output path');
  const resolved = `${resolvedRoot}/${normalized}`;
  const relative = resolved.slice(localRoot.length);
  if (!resolved.startsWith(`${localRoot}/`) || relative.includes('/../')) {
    throw new Error('detail output must resolve inside database/local/ (gitignored)');
  }
  return resolved;
}
