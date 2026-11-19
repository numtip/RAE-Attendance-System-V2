const fs = require('node:fs');
const { DIVISIONS } = require('../config/organization');
const { operatorAuth, EXIT } = require('./facescanImportCli');

/**
 * `npm run org:import-divisions` — record each employee's division as an org-unit membership.
 *
 *   org:import-divisions --roster <hip-roster.csv> --mapping <facescan-id-mapping.csv>
 *                        [--confirm --operator <employee_uid>]
 *
 * Evidence chain: the HIP roster says which division a FaceScan machine id belongs to; the mapping file
 * (already used for identity onboarding) says which employee that machine id is. Only an unambiguous
 * chain writes a row. Dry run by default; --confirm needs --operator with a data scope and the MariaDB
 * source. It only INSERTs into employee_org_membership (idempotent) — never updates or deletes a row,
 * never touches employees.department, assignments, identity links or grants.
 *
 * Output is counts only: no machine id, employee id, name or uid is printed.
 */
const USAGE = 'usage: org:import-divisions --roster <csv> --mapping <csv> [--confirm --operator <employee_uid>]';
const byName = new Map(DIVISIONS.map((division) => [division.nameTh, division.code]));

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
  const options = { roster: null, mapping: null, confirm: false, operator: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--confirm') options.confirm = true;
    else if (['--roster', '--mapping', '--operator'].includes(arg)) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) return { error: `${arg} needs a value` };
      index += 1;
      options[arg.slice(2)] = next;
    } else return { error: `unknown option ${arg}` };
  }
  if (!options.roster || !options.mapping) return { error: USAGE };
  if (options.confirm && !options.operator) return { error: '--confirm needs --operator <employee_uid>' };
  if (options.operator && !options.confirm) return { error: '--operator is only used with --confirm' };
  return { options };
}

async function runDivisionMembership(argv, { container }) {
  const parsed = parseArgs(argv);
  if (parsed.error) return { exitCode: EXIT.USAGE, report: { refused: parsed.error } };
  const { options } = parsed;
  const { repositories } = container;

  let roster;
  let mapping;
  try {
    roster = readCsv(options.roster);
    mapping = readCsv(options.mapping);
  } catch {
    return { exitCode: EXIT.FILE_REFUSED, report: { refused: 'a roster or mapping file could not be read' } };
  }
  const employeeByMachine = new Map(mapping.map((row) => [row.facescan_id, row.employee_id]));

  const counts = { rosterRows: roster.length, unknownDivisionName: 0, noMapping: 0, employeeNotOnboarded: 0, ambiguous: 0, alreadyMember: 0, conflictsWithExisting: 0, toInsert: 0 };
  const wanted = new Map(); // employee_uid -> Set(code)
  for (const row of roster) {
    const code = byName.get(row['แผนก']);
    if (!code) { counts.unknownDivisionName += 1; continue; }
    const employeeId = employeeByMachine.get(row['รหัสที่เครื่อง']);
    if (!employeeId) { counts.noMapping += 1; continue; }
    const employee = await repositories.employees.findByEmployeeId(employeeId);
    if (!employee) { counts.employeeNotOnboarded += 1; continue; }
    if (!wanted.has(employee.employeeUid)) wanted.set(employee.employeeUid, new Set());
    wanted.get(employee.employeeUid).add(code);
  }

  const existing = new Map();
  for (const { employeeUid, orgUnitCode } of await repositories.authorization.listMemberships()) {
    if (!byName.size || ![...byName.values()].includes(orgUnitCode)) continue;
    if (!existing.has(employeeUid)) existing.set(employeeUid, new Set());
    existing.get(employeeUid).add(orgUnitCode);
  }

  const inserts = [];
  const perDivision = Object.fromEntries(DIVISIONS.map((division) => [division.code, 0]));
  for (const [employeeUid, codes] of wanted) {
    if (codes.size > 1) { counts.ambiguous += 1; continue; }
    const [code] = [...codes];
    const have = existing.get(employeeUid);
    if (have && have.has(code) && have.size === 1) { counts.alreadyMember += 1; continue; }
    if (have && have.size > 0) { counts.conflictsWithExisting += 1; continue; }
    inserts.push({ employeeUid, code });
    perDivision[code] += 1;
  }
  counts.toInsert = inserts.length;

  if (!options.confirm) {
    return { exitCode: EXIT.OK, report: { mode: 'dry-run', written: false, ...counts, perDivision } };
  }
  if (container.dataSource !== 'mariadb') {
    return { exitCode: EXIT.USAGE, report: { refused: '--confirm needs DATA_SOURCE=mariadb' } };
  }
  try {
    await operatorAuth(repositories, options.operator);
  } catch (error) {
    return { exitCode: error.exitCode ?? EXIT.NOT_AUTHORISED, report: { refused: error.message } };
  }
  let written = 0;
  for (const { employeeUid, code } of inserts) {
    if (await repositories.authorization.addMembership(employeeUid, code)) written += 1;
  }
  return { exitCode: EXIT.OK, report: { mode: 'apply', written: true, ...counts, perDivision, rowsInserted: written } };
}

module.exports = { runDivisionMembership, parseArgs };

if (require.main === module) {
  const { createContainer } = require('../container');
  const { closePool } = require('../db/pool');
  (async () => {
    let exitCode = 1;
    try {
      const result = await runDivisionMembership(process.argv.slice(2), { container: createContainer() });
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
