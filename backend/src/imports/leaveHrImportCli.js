const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { operatorAuth, EXIT } = require('./facescanImportCli');
const { TYPE_MAP, splitTitle } = require('./employeeProfileCli');
const csv = require('../domain/hrLeaveCsv');
const { computeEntitlements, fiscalYearOf, tenYearStatus, fiscalYearByBE, policyForDate } = require('../domain/leavePolicyEngine');
const { POLICIES } = require('../domain/leavePolicy2569');
const { bangkokDate } = require('../services/leaveEntitlementService');

/**
 * `npm run leave:import-hr-data` — bring HR-confirmed leave facts into the database.
 *
 *   leave:import-hr-data [--profile <csv>] [--entitlement <csv>] [--report <file>] [--confirm --operator <employee_uid>]
 *
 * Rules and column definitions: docs/policies/HR_LEAVE_DATA_ONBOARDING.md. Behaves like employees:import-profile:
 *  - matches existing employees by employee_id only (never creates one), dry run by default;
 *  - output is counts and rule codes only: no employee id, name, uid or HR value is ever printed;
 *  - `--report <file>` writes `kind,line,level,code` per finding (line numbers, no personal data);
 *  - `--confirm` needs --operator with a data scope and DATA_SOURCE=mariadb, refuses while ANY blocking error exists,
 *    and applies every file in ONE transaction: a failure leaves nothing behind.
 *
 * Idempotent: a file whose SHA-256 was already applied (per kind) is a no-op. A blank cell never overwrites a stored
 * value; `-` clears it. Every changed field is audited (before / after, batch, operator). The tool never touches
 * leave_balance, leave records, approvals, credentials or grants, and writes only employees.hire_date of `employees`.
 *
 * A dry run also previews, per leave type, how many of the people in the files are `ok / unknown / pending_… /
 * needs_hr / hr_verified` before and after the import, so HR can see how much of the gap a file closes.
 */
const USAGE = 'usage: leave:import-hr-data [--profile <csv>] [--entitlement <csv>] [--report <file>] [--confirm --operator <employee_uid>]';
const PROFILE_FIELDS = ['continuousServiceStart', 'appointmentKind', 'eligibilityConfirmed', 'eligibilityReference', 'sourceReference'];
const ENTITLEMENT_FIELDS = ['entitlementDays', 'carryoverDays', 'usageBaselineDays', 'usageBaselineThrough', 'sourceReference'];
const SNAKE = {
  hireDate: 'hire_date', continuousServiceStart: 'continuous_service_start', appointmentKind: 'appointment_kind',
  eligibilityConfirmed: 'eligibility_confirmed', eligibilityReference: 'eligibility_reference', sourceReference: 'source_reference',
  entitlementDays: 'entitlement_days', carryoverDays: 'carryover_days', usageBaselineDays: 'usage_baseline_days', usageBaselineThrough: 'usage_baseline_through',
};

function parseArgs(argv) {
  const options = { profile: null, entitlement: null, report: null, confirm: false, operator: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--confirm') options.confirm = true;
    else if (['--profile', '--entitlement', '--report', '--operator'].includes(arg)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) return { error: `${arg} needs a value` };
      i += 1;
      options[arg.slice(2)] = next;
    } else return { error: `unknown option ${arg}` };
  }
  if (!options.profile && !options.entitlement) return { error: USAGE };
  if (options.confirm && !options.operator) return { error: '--confirm needs --operator <employee_uid>' };
  if (options.operator && !options.confirm) return { error: '--operator is only used with --confirm' };
  return { options };
}

const bump = (counts, key) => { counts[key] = (counts[key] || 0) + 1; };
const same = (a, b) => (a ?? null) === (b ?? null);
const show = (value) => (value === null || value === undefined ? null : String(value));

function fullNameKey(first, last) { return `${String(first).trim()} ${String(last).trim()}`; }

/** Status per leave type for the preview: an HR row (any) shows as hr_verified, else the engine's status. */
function previewStatuses({ fiscalYearBe, facts, profile, hrTypes, carryover }) {
  const employee = {
    employeeType: facts.employeeType,
    hireDate: facts.hireDate || null,
    continuousServiceStart: profile?.continuousServiceStart || null,
    appointmentKind: profile?.appointmentKind || null,
  };
  if (profile && profile.eligibilityConfirmed !== null && profile.eligibilityConfirmed !== undefined) {
    employee.eligibilityConfirmation = { confirmed: profile.eligibilityConfirmed, reference: profile.eligibilityReference };
  }
  const result = computeEntitlements({ fiscalYear: fiscalYearBe, employee, records: [], carryover: { vacationDays: carryover ?? null } });
  return Object.fromEntries(['sick', 'personal', 'vacation'].map((t) => [t, hrTypes.has(t) ? 'hr_verified' : result.results[t].status]));
}

async function runLeaveHrImport(argv, { container, readFile = (file) => fs.readFileSync(file), writeFile = (file, text) => fs.writeFileSync(file, text) }) {
  const parsed = parseArgs(argv);
  if (parsed.error) return { exitCode: EXIT.USAGE, report: { refused: parsed.error } };
  const { options } = parsed;
  const { repositories } = container;
  const today = bangkokDate(new Date());
  const currentFiscalYearBe = fiscalYearOf(today).be;

  // ---- read + validate (pure) ----
  const inputs = {};
  for (const kind of ['profile', 'entitlement']) {
    if (!options[kind]) continue;
    let buffer;
    try { buffer = Buffer.from(readFile(options[kind])); } catch { return { exitCode: EXIT.FILE_REFUSED, report: { refused: `the ${kind} file could not be read` } }; }
    const table = csv.parseCsv(buffer.toString('utf8'));
    const validation = kind === 'profile' ? csv.validateProfile(table, { today }) : csv.validateEntitlement(table, { currentFiscalYearBe });
    inputs[kind] = { sha256: createHash('sha256').update(buffer).digest('hex'), validation };
  }

  const findings = []; // { kind, line, level, code } — what --report writes
  const summary = {};
  const fileBlocked = [];
  for (const [kind, input] of Object.entries(inputs)) {
    const s = { sha256: input.sha256, rows: input.validation.rows.length, fileErrors: input.validation.fileErrors, errors: {}, warnings: {}, matched: 0, unchanged: 0, toApply: 0, changed: {}, alreadyApplied: false };
    summary[kind] = s;
    if (input.validation.fileErrors.length) { fileBlocked.push(kind); for (const code of input.validation.fileErrors) findings.push({ kind, line: 0, level: 'error', code }); }
  }
  if (fileBlocked.length) return finish(EXIT.FILE_REFUSED, { mode: options.confirm ? 'apply' : 'dry-run', written: false, files: summary, refused: 'a file does not match the template' });

  const add = (kind, row, level, code) => {
    findings.push({ kind, line: row.line, level, code });
    bump(summary[kind][level === 'error' ? 'errors' : 'warnings'], code);
    if (level === 'error') row.blocked = true;
  };
  for (const [kind, input] of Object.entries(inputs)) {
    for (const row of input.validation.rows) {
      for (const code of row.errors) add(kind, row, 'error', code);
      for (const code of row.warnings) add(kind, row, 'warning', code);
    }
  }

  // ---- match, diff (read-only) ----
  const people = new Map(); // employeeUid -> { facts, profileNow, profileAfter, hrNow: Map, hrAfter: Map, uid }
  const plan = { profile: [], entitlement: [] };
  const personOf = async (id) => {
    const employee = await repositories.employees.findByEmployeeId(id);
    if (!employee) return null;
    if (!people.has(employee.employeeUid)) {
      const profileNow = await repositories.leaveHr.getProfile(employee.employeeUid);
      people.set(employee.employeeUid, {
        employee,
        facts: { employeeType: employee.employeeType, hireDate: employee.hireDate || null },
        profileNow, profileAfter: profileNow ? { ...profileNow } : null,
        hireAfter: employee.hireDate || null,
        hrNow: new Map(), hrAfter: new Map(),
      });
    }
    return people.get(employee.employeeUid);
  };

  if (inputs.profile) {
    const kind = 'profile';
    const s = summary[kind];
    for (const row of inputs.profile.validation.rows) {
      if (row.blocked || row.skip || !row.data.employeeId) continue;
      const person = await personOf(row.data.employeeId);
      if (!person) { add(kind, row, 'error', 'id_not_found'); continue; }
      const { employee } = person;
      if (employee.status !== 'active') add(kind, row, 'error', 'not_active');
      if (row.type && TYPE_MAP[row.type] !== employee.employeeType) add(kind, row, 'error', 'type_mismatch');
      if (row.name) {
        const tokens = row.name.split(/\s+/).filter(Boolean);
        const first = tokens.length === 2 ? splitTitle(tokens[0]).firstNameTh : null;
        if (tokens.length !== 2 || fullNameKey(first, tokens[1]) !== fullNameKey(employee.firstNameTh, employee.lastNameTh)) add(kind, row, 'warning', 'name_mismatch');
      }
      // Merge the cells that carry a value over what is stored (blank = leave alone, null = clear).
      const merged = { ...(person.profileAfter || { employeeUid: employee.employeeUid, continuousServiceStart: null, appointmentKind: null, eligibilityConfirmed: null, eligibilityReference: null, sourceReference: null }) };
      for (const field of PROFILE_FIELDS) if (field in row.data) merged[field] = row.data[field];
      // Contract staff (พนักงานส่วนงานจ้างเหมา) are outside the policy: no confirmation can bring them in.
      if (employee.employeeType === 'contract') add(kind, row, 'error', 'type_out_of_scope');
      if (['department', 'procurement_academic'].includes(employee.employeeType) && merged.eligibilityConfirmed === null) add(kind, row, 'warning', 'eligibility_unconfirmed');
      if (row.blocked) continue;
      s.matched += 1;

      const changes = [];
      if ('hireDate' in row.data && !same(row.data.hireDate, person.hireAfter)) changes.push({ table: 'employees', field: 'hireDate', before: person.hireAfter, after: row.data.hireDate });
      const before = person.profileAfter;
      for (const field of PROFILE_FIELDS) {
        if (field in row.data && !same(row.data[field], before ? before[field] : null)) {
          changes.push({ table: 'employee_leave_profile', field, before: before ? before[field] : null, after: row.data[field] });
        }
      }
      // A different source note on its own is not a change worth a batch or an audit row (it keeps an unchanged
      // export re-uploadable as a no-op).
      if (changes.every((c) => c.field === 'sourceReference')) changes.length = 0;
      if (!changes.length) { s.unchanged += 1; continue; }
      // Replacing a stored value is worth a warning; filling in a missing one is not.
      if (changes.some((c) => c.before !== null && c.before !== undefined)) add(kind, row, 'warning', 'conflicts_with_existing');
      for (const c of changes) bump(s.changed, SNAKE[c.field]);
      if ('hireDate' in row.data) person.hireAfter = row.data.hireDate;
      person.profileAfter = merged;
      s.toApply += 1;
      plan.profile.push({ person, row, changes, merged });
    }
  }

  if (inputs.entitlement) {
    const kind = 'entitlement';
    const s = summary[kind];
    for (const row of inputs.entitlement.validation.rows) {
      if (row.blocked || row.skip || !row.data.employeeId) continue;
      const person = await personOf(row.data.employeeId);
      if (!person) { add(kind, row, 'error', 'id_not_found'); continue; }
      const { employee } = person;
      if (employee.status !== 'active') add(kind, row, 'error', 'not_active');
      if (employee.employeeType === 'contract') add(kind, row, 'error', 'type_out_of_scope');
      if (row.blocked) continue;
      s.matched += 1;

      const { fiscalYearBe, leaveType } = row.data;
      const key = `${fiscalYearBe}|${leaveType}`;
      const now = person.hrAfter.has(key) ? person.hrAfter.get(key) : await repositories.leaveHr.getEntitlement(employee.employeeUid, fiscalYearBe, leaveType);
      const merged = { employeeUid: employee.employeeUid, fiscalYearBe, leaveType, carryoverDays: null, usageBaselineDays: null, usageBaselineThrough: null, ...(now || {}) };
      for (const field of ENTITLEMENT_FIELDS) if (field in row.data) merged[field] = row.data[field];

      // Warnings that need the person's facts.
      const asEmployee = {
        employeeType: employee.employeeType, hireDate: person.hireAfter,
        continuousServiceStart: person.profileAfter?.continuousServiceStart || null,
        appointmentKind: person.profileAfter?.appointmentKind || null,
        eligibilityConfirmation: { confirmed: true, reference: 'hr-import-preview' },
      };
      const policy = policyForDate(fiscalYearByBE(fiscalYearBe).end) || POLICIES[0];
      if (leaveType === 'vacation' && merged.carryoverDays !== null) {
        const cap = tenYearStatus(policy, asEmployee, fiscalYearByBE(fiscalYearBe)) === 'yes' ? policy.vacation.combinedCapDaysAfter10YearsContinuous : policy.vacation.combinedCapDays;
        if (merged.entitlementDays + merged.carryoverDays > cap) add(kind, row, 'warning', 'vacation_cap_exceeded');
      }
      const engine = computeEntitlements({ fiscalYear: fiscalYearBe, employee: asEmployee, records: [], carryover: { vacationDays: merged.carryoverDays } });
      const engineOut = engine.results[leaveType];
      if (engineOut.status === 'ok' && engineOut.entitlementDays !== merged.entitlementDays) add(kind, row, 'warning', 'differs_from_policy');

      const changes = [];
      for (const field of ENTITLEMENT_FIELDS) {
        if (field in row.data && !same(row.data[field], now ? now[field] : null)) changes.push({ table: 'employee_leave_entitlement', field, before: now ? now[field] : null, after: row.data[field], entityKey: key });
      }
      person.hrAfter.set(key, merged);
      if (!changes.length) { s.unchanged += 1; continue; }
      if (changes.some((c) => c.before !== null && c.before !== undefined)) add(kind, row, 'warning', 'conflicts_with_existing');
      for (const c of changes) bump(s.changed, SNAKE[c.field]);
      s.toApply += 1;
      plan.entitlement.push({ person, row, changes, merged });
    }
  }

  // ---- idempotency: was this exact file already applied? ----
  for (const kind of Object.keys(inputs)) {
    const batch = await repositories.leaveHr.findBatch(kind, inputs[kind].sha256);
    if (batch) summary[kind].alreadyApplied = true;
  }

  // ---- preview: statuses before / after for the people in the files ----
  const preview = { fiscalYearBe: currentFiscalYearBe, people: people.size, before: {}, after: {} };
  for (const t of ['sick', 'personal', 'vacation']) { preview.before[t] = {}; preview.after[t] = {}; }
  for (const person of people.values()) {
    const hrNow = new Set();
    const hrAfter = new Set();
    let carryNow = null;
    let carryAfter = null;
    for (const [k, v] of person.hrAfter) if (Number(k.split('|')[0]) === currentFiscalYearBe) { hrAfter.add(v.leaveType); if (v.leaveType === 'vacation') carryAfter = v.carryoverDays; }
    for (const t of ['sick', 'personal', 'vacation']) {
      const stored = await repositories.leaveHr.getEntitlement(person.employee.employeeUid, currentFiscalYearBe, t);
      if (stored) { hrNow.add(t); if (t === 'vacation') carryNow = stored.carryoverDays; }
    }
    const before = previewStatuses({ fiscalYearBe: currentFiscalYearBe, facts: person.facts, profile: person.profileNow, hrTypes: hrNow, carryover: carryNow });
    const afterHr = new Set([...hrNow, ...hrAfter]);
    const after = previewStatuses({ fiscalYearBe: currentFiscalYearBe, facts: { ...person.facts, hireDate: person.hireAfter }, profile: person.profileAfter, hrTypes: afterHr, carryover: carryAfter ?? carryNow });
    for (const t of ['sick', 'personal', 'vacation']) { bump(preview.before[t], before[t]); bump(preview.after[t], after[t]); }
  }

  const blocking = Object.values(summary).reduce((n, s) => n + Object.values(s.errors).reduce((a, b) => a + b, 0), 0);
  const base = { mode: options.confirm ? 'apply' : 'dry-run', written: false, blockingErrors: blocking, files: summary, preview };
  if (!options.confirm) return finish(blocking ? EXIT.FILE_REFUSED : EXIT.OK, base);

  // ---- apply ----
  if (container.dataSource !== 'mariadb') return finish(EXIT.USAGE, { refused: '--confirm needs DATA_SOURCE=mariadb' });
  if (blocking) return finish(EXIT.FILE_REFUSED, { ...base, refused: 'the files have errors that block the import; fix them first' });
  let auth;
  try { auth = await operatorAuth(repositories, options.operator); } catch (error) { return finish(error.exitCode ?? EXIT.NOT_AUTHORISED, { refused: error.message }); }

  const pending = Object.keys(inputs).filter((kind) => !summary[kind].alreadyApplied);
  if (pending.length === 0) return finish(EXIT.OK, { ...base, written: false, alreadyApplied: true });

  const applied = {};
  await repositories.leaveHr.transaction(async (tx) => {
    for (const kind of ['profile', 'entitlement']) {
      if (!pending.includes(kind)) continue;
      const s = summary[kind];
      const batchUid = await tx.insertBatch({ kind, fileSha256: inputs[kind].sha256, rowsRead: s.rows, rowsApplied: s.toApply, rowsUnchanged: s.unchanged, operatorUid: auth.employeeUid });
      const audit = [];
      for (const { person, row, changes, merged } of plan[kind]) {
        const uid = person.employee.employeeUid;
        if (kind === 'profile') {
          if (changes.some((c) => c.field === 'hireDate')) await tx.setHireDate(uid, row.data.hireDate);
          await tx.upsertProfile({ ...merged, employeeUid: uid, verifiedByUid: auth.employeeUid });
        } else {
          await tx.upsertEntitlement({ ...merged, employeeUid: uid, importBatchUid: batchUid, verifiedByUid: auth.employeeUid });
        }
        for (const c of changes) {
          audit.push({ batchUid, employeeUid: uid, tableName: c.table, fieldName: SNAKE[c.field], entityKey: c.entityKey ?? null, beforeValue: show(c.before), afterValue: show(c.after), actorUid: auth.employeeUid });
        }
      }
      await tx.appendAudit(audit);
      applied[kind] = { rowsApplied: s.toApply, rowsUnchanged: s.unchanged, auditRows: audit.length };
    }
  });
  return finish(EXIT.OK, { ...base, written: true, applied });

  function finish(exitCode, report) {
    if (options.report) {
      try { writeFile(options.report, `kind,line,level,code\n${findings.map((f) => `${f.kind},${f.line},${f.level},${f.code}`).join('\n')}\n`); } catch { report.reportFile = 'could not be written'; }
    }
    return { exitCode, report };
  }
}

module.exports = { runLeaveHrImport, parseArgs };

if (require.main === module) {
  const { createContainer } = require('../container');
  const { closePool } = require('../db/pool');
  (async () => {
    let exitCode = 1;
    try {
      const result = await runLeaveHrImport(process.argv.slice(2), { container: createContainer() });
      exitCode = result.exitCode;
      (exitCode === 0 ? console.log : console.error)(JSON.stringify(result.report, null, 2));
    } catch (error) {
      console.error(JSON.stringify({ failed: error?.name ?? 'Error', code: error?.code ?? null }));
    } finally {
      await closePool();
    }
    process.exit(exitCode);
  })();
}
