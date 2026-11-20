const fs = require('node:fs');
const { operatorAuth, EXIT } = require('./facescanImportCli');

/**
 * `npm run employees:import-profile` — bring the profile fields shown on "ข้อมูลของฉัน" in line with the
 * owner's personnel file (database/01-updatedb2.csv).
 *
 *   employees:import-profile --file <csv> [--update-names] [--allow-admin-grant] [--confirm --operator <employee_uid>]
 *
 * Columns: รหัส, ชื่อ-นามสกุล, ตำแหน่ง, ประเภทบุคลากร, หน่วยงาน, สถานะ, บทบาทในระบบ.
 * Matches existing employees by employee_id only: it never creates or deletes an employee, and never
 * touches email, credentials, identifiers, org memberships or grants. Dry run by default; --confirm needs
 * --operator with a data scope and the MariaDB source.
 *
 * The CSV carries the title inside the first name ("นาย…"). It is split off into employees.title_th
 * (shown on "ข้อมูลของฉัน" only); first/last names stay title-free, so reports print the same name. They are
 * only rewritten from the CSV with --update-names.
 *
 * Role safety: a row whose current role is anything but `user` keeps it (a CSV that has no `executive`
 * must not demote the executive), and promotion to `admin` is skipped unless --allow-admin-grant is given.
 *
 * Output is counts only: no employee id, name or uid is printed.
 */
const USAGE = 'usage: employees:import-profile --file <csv> [--update-names] [--allow-admin-grant] [--confirm --operator <employee_uid>]';

const TYPE_MAP = Object.freeze({
  'พนักงานมหาวิทยาลัย': 'university',
  'พนักงานส่วนงาน': 'department',
  'พนักงานส่วนงานจ้างเหมา': 'contract',
  'นักวิชาการพัสดุ': 'procurement_academic',
});
/** Longest first, so "นางสาว" is not read as "นาง" + "สาว". */
const TITLES = Object.freeze(['ว่าที่ร้อยตรี', 'นางสาว', 'นาง', 'นาย', 'ดร.']);

function splitTitle(token) {
  const title = TITLES.find((candidate) => token.startsWith(candidate) && token.length > candidate.length);
  return title ? { titleTh: title, firstNameTh: token.slice(title.length) } : { titleTh: null, firstNameTh: token };
}

const STATUS_MAP = Object.freeze({ 'ปฏิบัติงานอยู่': 'active' });
const ROLE_MAP = Object.freeze({ 'ผู้ดูแลระบบ(System admin)': 'admin', 'บุคลากร': 'user' });

function splitLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function readCsv(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/).filter((line) => line.trim());
  const header = splitLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitLine(line);
    return Object.fromEntries(header.map((name, index) => [name, cells[index] ?? '']));
  });
}

function parseArgs(argv) {
  const options = { file: null, confirm: false, operator: null, allowAdminGrant: false, updateNames: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--confirm') options.confirm = true;
    else if (arg === '--allow-admin-grant') options.allowAdminGrant = true;
    else if (arg === '--update-names') options.updateNames = true;
    else if (arg === '--file' || arg === '--operator') {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) return { error: `${arg} needs a value` };
      index += 1;
      options[arg.slice(2)] = next;
    } else return { error: `unknown option ${arg}` };
  }
  if (!options.file) return { error: USAGE };
  if (options.confirm && !options.operator) return { error: '--confirm needs --operator <employee_uid>' };
  if (options.operator && !options.confirm) return { error: '--operator is only used with --confirm' };
  return { options };
}

async function runEmployeeProfileImport(argv, { container }) {
  const parsed = parseArgs(argv);
  if (parsed.error) return { exitCode: EXIT.USAGE, report: { refused: parsed.error } };
  const { options } = parsed;
  const { repositories } = container;

  let rows;
  try {
    rows = readCsv(options.file);
  } catch {
    return { exitCode: EXIT.FILE_REFUSED, report: { refused: 'the file could not be read' } };
  }

  const counts = {
    rows: rows.length, blankRows: 0, duplicateId: 0, notInDatabase: 0, badName: 0, unknownType: 0,
    unknownStatus: 0, unknownRole: 0, noTitle: 0, unchanged: 0, toUpdate: 0, roleKept: 0, adminGrantSkipped: 0,
  };
  const changed = { title: 0, name: 0, position: 0, department: 0, employeeType: 0, status: 0, role: 0 };
  const plan = [];
  const seen = new Set();

  for (const row of rows) {
    const id = (row['รหัส'] ?? '').trim();
    if (!id) { counts.blankRows += 1; continue; }
    if (seen.has(id)) { counts.duplicateId += 1; continue; }
    seen.add(id);

    const names = (row['ชื่อ-นามสกุล'] ?? '').trim().split(/\s+/).filter(Boolean);
    if (names.length !== 2) { counts.badName += 1; continue; }
    const employeeType = TYPE_MAP[(row['ประเภทบุคลากร'] ?? '').trim()];
    if (!employeeType) { counts.unknownType += 1; continue; }
    const status = STATUS_MAP[(row['สถานะ'] ?? '').trim()];
    if (!status) { counts.unknownStatus += 1; continue; }
    const wantedRole = ROLE_MAP[(row['บทบาทในระบบ'] ?? '').trim()];
    if (!wantedRole) { counts.unknownRole += 1; continue; }
    const department = (row['หน่วยงาน'] ?? '').trim();

    const current = await repositories.employees.findByEmployeeId(id);
    if (!current) { counts.notInDatabase += 1; continue; }

    let role = wantedRole;
    if (current.role && current.role !== 'user' && current.role !== wantedRole) {
      role = current.role;
      counts.roleKept += 1;
    } else if (wantedRole === 'admin' && current.role !== 'admin' && !options.allowAdminGrant) {
      role = current.role;
      counts.adminGrantSkipped += 1;
    }

    const split = splitTitle(names[0]);
    if (!split.titleTh) counts.noTitle += 1;
    const next = {
      titleTh: split.titleTh,
      firstNameTh: options.updateNames ? split.firstNameTh : current.firstNameTh,
      lastNameTh: options.updateNames ? names[1] : current.lastNameTh,
      position: (row['ตำแหน่ง'] ?? '').trim() || current.position || null,
      department: department || current.department,
      employeeType,
      status,
      role,
    };
    const diff = {
      title: next.titleTh !== (current.titleTh ?? null),
      name: next.firstNameTh !== current.firstNameTh || next.lastNameTh !== current.lastNameTh,
      position: next.position !== (current.position ?? null),
      department: next.department !== current.department,
      employeeType: next.employeeType !== current.employeeType,
      status: next.status !== current.status,
      role: next.role !== current.role,
    };
    if (!Object.values(diff).some(Boolean)) { counts.unchanged += 1; continue; }
    for (const [field, isChanged] of Object.entries(diff)) if (isChanged) changed[field] += 1;
    plan.push({ employeeUid: current.employeeUid, fields: next });
  }
  counts.toUpdate = plan.length;

  if (!options.confirm) {
    return { exitCode: EXIT.OK, report: { mode: 'dry-run', written: false, ...counts, changed } };
  }
  if (container.dataSource !== 'mariadb') {
    return { exitCode: EXIT.USAGE, report: { refused: '--confirm needs DATA_SOURCE=mariadb' } };
  }
  const unresolved = counts.badName + counts.unknownType + counts.unknownStatus + counts.unknownRole
    + counts.duplicateId; // notInDatabase is only reported: this tool never creates an employee
  if (unresolved > 0) {
    return { exitCode: EXIT.FILE_REFUSED, report: { refused: 'the file has rows that cannot be applied; fix them first', ...counts } };
  }
  try {
    await operatorAuth(repositories, options.operator);
  } catch (error) {
    return { exitCode: error.exitCode ?? EXIT.NOT_AUTHORISED, report: { refused: error.message } };
  }
  let written = 0;
  for (const { employeeUid, fields } of plan) {
    if (await repositories.employees.updateProfile(employeeUid, fields)) written += 1;
  }
  return { exitCode: EXIT.OK, report: { mode: 'apply', written: true, ...counts, changed, rowsUpdated: written } };
}

module.exports = { runEmployeeProfileImport, parseArgs, splitTitle, TYPE_MAP, STATUS_MAP, ROLE_MAP };

if (require.main === module) {
  const { createContainer } = require('../container');
  const { closePool } = require('../db/pool');
  (async () => {
    let exitCode = 1;
    try {
      const result = await runEmployeeProfileImport(process.argv.slice(2), { container: createContainer() });
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
