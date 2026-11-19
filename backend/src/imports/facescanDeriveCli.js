const { HttpError } = require('../utils/httpError');
const { createAttendanceRecordService } = require('../services/attendanceRecordService');
const { createFacescanAttendanceIngestionService } = require('../services/facescanAttendanceIngestionService');
const { operatorAuth, EXIT } = require('./facescanImportCli');

/**
 * `npm run facescan:derive` — derive the days a late identifier link left behind.
 *
 *   facescan:derive --employee-id <code>[,<code>…] [--confirm --operator <employee_uid>]
 *
 * `facescan:import` derives only the rows it writes in that run, and a replay of an imported file
 * yields duplicates, not resolved rows. After `apply-facescan-identifiers --re-resolve` promotes
 * quarantined scans to resolved, nothing derived them. This command does exactly that and nothing
 * else: for the named employees it lists resolved staging days with no `daily_attendance` row and runs
 * the same `deriveDay` (same RBAC, same AR-0001 path) on each.
 *
 * Fail closed: dry run by default; `--confirm` needs `--operator` with a data scope; an unknown
 * employee code stops the run before any write. Output is counts only, never a code, uid or time.
 */
const USAGE = 'usage: facescan:derive --employee-id <code>[,<code>…] [--confirm --operator <employee_uid>]';

function parseArgs(argv) {
  const options = { employeeIds: [], confirm: false, operator: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--confirm') options.confirm = true;
    else if (arg === '--employee-id' || arg === '--operator') {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) return { error: `${arg} needs a value` };
      index += 1;
      if (arg === '--operator') options.operator = next;
      else options.employeeIds = next.split(',').map((code) => code.trim()).filter(Boolean);
    } else return { error: `unknown option ${arg}` };
  }
  if (options.employeeIds.length === 0) return { error: USAGE };
  if (options.confirm && !options.operator) return { error: '--confirm needs --operator <employee_uid>' };
  if (options.operator && !options.confirm) return { error: '--operator is only used with --confirm' };
  return { options };
}

async function runFacescanDerive(argv, { container }) {
  const parsed = parseArgs(argv);
  if (parsed.error) return { exitCode: EXIT.USAGE, report: { refused: parsed.error } };
  const { options } = parsed;
  const { repositories } = container;
  const targets = [];
  for (const code of options.employeeIds) {
    const employee = await repositories.employees.findByEmployeeId(code);
    if (!employee) return { exitCode: EXIT.USAGE, report: { refused: 'an employee code is not onboarded; nothing derived' } };
    const days = await repositories.attendanceEvents.listUnderivedResolvedDays(employee.employeeUid);
    for (const date of days) targets.push({ employeeUid: employee.employeeUid, date });
  }
  if (!options.confirm) {
    return { exitCode: EXIT.OK, report: { mode: 'dry-run', written: false, employees: options.employeeIds.length, employeeDays: targets.length } };
  }
  if (container.dataSource !== 'mariadb') {
    return { exitCode: EXIT.USAGE, report: { refused: '--confirm needs DATA_SOURCE=mariadb' } };
  }
  let auth;
  try {
    auth = await operatorAuth(repositories, options.operator);
  } catch (error) {
    return { exitCode: error.exitCode ?? EXIT.NOT_AUTHORISED, report: { refused: error.message } };
  }
  const facescanAttendance = createFacescanAttendanceIngestionService({
    repositories,
    recordService: createAttendanceRecordService({ repositories }),
  });
  const outcomes = {};
  for (const target of targets) {
    let outcome = 'recorded';
    try {
      await facescanAttendance.deriveDay(auth, target.employeeUid, target.date);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      outcome = error.code;
    }
    outcomes[outcome] = (outcomes[outcome] || 0) + 1;
  }
  const incomplete = Object.keys(outcomes).some((key) => key !== 'recorded');
  return {
    exitCode: incomplete ? EXIT.DERIVE_INCOMPLETE : EXIT.OK,
    report: { mode: 'derive', written: true, employeeDays: targets.length, outcomes },
  };
}

module.exports = { runFacescanDerive, parseArgs };

if (require.main === module) {
  const { createContainer } = require('../container');
  const { closePool } = require('../db/pool');
  (async () => {
    let exitCode = 1;
    try {
      const result = await runFacescanDerive(process.argv.slice(2), { container: createContainer() });
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
