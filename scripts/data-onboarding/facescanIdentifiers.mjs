/**
 * Verified HIP device codes -> `employee_identifier` rows with `id_type = facescan_id`.
 *
 * Input is an owner-supplied mapping CSV with the columns `employee_id,facescan_id`, produced from device
 * evidence (a HIP export or the device user list). The roster's `ID HIP` is NOT assumed to be the device
 * USERID: this tool links only the pairs the mapping file states, and refuses to write without an evidence
 * reference.
 *
 * Identity rules (ADR-012): the employee is looked up by its existing `employee_id`; an `employee_uid` is
 * never created, derived, replaced or re-pointed. Writes go through `employeeIdentityService.linkIdentifier`,
 * the same path the backend uses, so the unique key and the 017 namespace triggers still apply.
 *
 * Plan statuses: `new` (will be linked) · `already_linked` (same employee, same code: nothing to do) · and the
 * conflicts below, any one of which blocks `--confirm` for the whole file:
 *   EMPLOYEE_NOT_FOUND · CODE_OWNED_BY_OTHER_EMPLOYEE · EMPLOYEE_HAS_OTHER_FACESCAN_ID (never replaced)
 *   · CODE_IS_OTHER_EMPLOYEES_PERSONNEL_ID (017 namespace collision).
 *
 * Every report is aggregates plus line numbers: no code, employee_id, name or UID is printed.
 */
import { createHash } from 'node:crypto';
import { decodeCsvBuffer, parseCsv } from './csvText.mjs';

export const SOURCE_SYSTEM = 'hip_device_evidence';
const REQUIRED = ['employee_id', 'facescan_id'];
const FACESCAN_ID_MAX = 64; // staging_facescan_raw.facescan_id VARCHAR(64)
const EVIDENCE_MAX = 200;

export class MappingFileError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.issues = issues;
  }
}

/** Whole-file validation; one bad line refuses the file. Extra columns are ignored and never read. */
export function parseMappingFile(buffer) {
  const text = typeof buffer === 'string' ? buffer.replace(/^﻿/, '') : decodeCsvBuffer(buffer);
  const rows = parseCsv(text);
  if (rows.length === 0) throw new MappingFileError('file is empty');
  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const missing = REQUIRED.filter((name) => !header.includes(name));
  if (missing.length > 0) throw new MappingFileError(`header is missing ${missing.join(', ')}`);
  const repeated = REQUIRED.filter((name) => header.indexOf(name) !== header.lastIndexOf(name));
  if (repeated.length > 0) throw new MappingFileError(`header repeats ${repeated.join(', ')}`);
  const at = Object.fromEntries(REQUIRED.map((name) => [name, header.indexOf(name)]));

  const pairs = [];
  const issues = [];
  const seenEmployee = new Map();
  const seenCode = new Map();
  rows.slice(1).forEach((cells, index) => {
    const line = index + 2;
    const employeeId = String(cells[at.employee_id] ?? '').trim();
    const facescanId = String(cells[at.facescan_id] ?? '').trim();
    if (!employeeId) issues.push({ line, message: 'employee_id is empty' });
    if (!facescanId) issues.push({ line, message: 'facescan_id is empty' });
    else if (facescanId.length > FACESCAN_ID_MAX) issues.push({ line, message: `facescan_id exceeds ${FACESCAN_ID_MAX} characters` });
    if (employeeId && seenEmployee.has(employeeId)) issues.push({ line, message: `employee_id repeats line ${seenEmployee.get(employeeId)}` });
    if (facescanId && seenCode.has(facescanId)) issues.push({ line, message: `facescan_id repeats line ${seenCode.get(facescanId)}` });
    if (employeeId) seenEmployee.set(employeeId, line);
    if (facescanId) seenCode.set(facescanId, line);
    pairs.push({ line, employeeId, facescanId });
  });
  if (issues.length > 0) throw new MappingFileError(`${issues.length} invalid line(s); nothing was planned`, issues.slice(0, 20));
  if (pairs.length === 0) throw new MappingFileError('file has a header but no mapping rows');
  return { pairs, contentSha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}

export function validateEvidence(evidence) {
  const text = String(evidence ?? '').trim();
  if (!text) return 'an --evidence reference is required to write mappings';
  if (text.length > EVIDENCE_MAX) return `--evidence must be at most ${EVIDENCE_MAX} characters`;
  return null;
}

/** Read-only: classifies every pair against the database. Writes nothing. */
export async function planMappings(pairs, repositories) {
  const { employees, employeeIdentifiers } = repositories;
  const planned = [];
  for (const pair of pairs) {
    const employee = await employees.findByEmployeeId(pair.employeeId);
    if (!employee) {
      planned.push({ ...pair, status: 'EMPLOYEE_NOT_FOUND' });
      continue;
    }
    const entry = { ...pair, employeeUid: employee.employeeUid, inactive: employee.status !== 'active' };
    const owner = await employeeIdentifiers.findActiveByTypeAndValue('facescan_id', pair.facescanId);
    if (owner && owner.employeeUid === employee.employeeUid) {
      planned.push({ ...entry, status: 'already_linked' });
      continue;
    }
    if (owner) {
      planned.push({ ...entry, status: 'CODE_OWNED_BY_OTHER_EMPLOYEE' });
      continue;
    }
    const current = (await employeeIdentifiers.listByEmployeeUid(employee.employeeUid))
      .filter((row) => row.idType === 'facescan_id');
    if (current.length > 0) {
      planned.push({ ...entry, status: 'EMPLOYEE_HAS_OTHER_FACESCAN_ID' });
      continue;
    }
    const personnel = await employeeIdentifiers.findActiveByTypeAndValue('personnel_id', pair.facescanId);
    if (personnel && personnel.employeeUid !== employee.employeeUid) {
      planned.push({ ...entry, status: 'CODE_IS_OTHER_EMPLOYEES_PERSONNEL_ID' });
      continue;
    }
    planned.push({ ...entry, status: 'new' });
  }
  return planned;
}

const isConflict = (entry) => entry.status !== 'new' && entry.status !== 'already_linked';

/** Aggregates and line numbers only. */
export function summarize(planned) {
  const statuses = {};
  for (const entry of planned) statuses[entry.status] = (statuses[entry.status] || 0) + 1;
  return {
    pairs: planned.length,
    statuses,
    inactiveEmployees: planned.filter((entry) => entry.inactive).length,
    conflicts: planned.filter(isConflict).map((entry) => ({ line: entry.line, reason: entry.status })),
  };
}

/**
 * Writes the `new` pairs through `linkIdentifier`. Refuses the whole file when any conflict exists, so a
 * partial mapping is never applied by accident. Returns aggregates.
 */
export async function applyMappings(planned, { identity, evidence, now = new Date() }) {
  if (planned.some(isConflict)) throw new MappingFileError('conflicts must be resolved first; nothing was written');
  const evidenceProblem = validateEvidence(evidence);
  if (evidenceProblem) throw new MappingFileError(evidenceProblem);
  const outcomes = {};
  for (const entry of planned.filter((candidate) => candidate.status === 'new')) {
    let outcome = 'linked';
    try {
      await identity.linkIdentifier({
        employeeUid: entry.employeeUid,
        idType: 'facescan_id',
        idValue: entry.facescanId,
        sourceSystem: SOURCE_SYSTEM,
        verifiedAt: now,
      });
    } catch (error) {
      // The unique key or the 017 trigger can still refuse a row that changed after the plan.
      outcome = error.code || 'ERROR';
    }
    outcomes[outcome] = (outcomes[outcome] || 0) + 1;
  }
  return outcomes;
}
