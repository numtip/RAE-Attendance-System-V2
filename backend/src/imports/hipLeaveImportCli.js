const fs = require('node:fs');
const path = require('node:path');
const { createEmployeeIdentityService } = require('../services/employeeIdentityService');
const { operatorAuth, EXIT } = require('./facescanImportCli');
const { analyzeHipLeaveFile, decodeHipFile, HipLeaveFileError } = require('./hipLeaveRemarks');

/**
 * `npm run leave:import-hip` — record the leave found in the `Remark [n]` column of monthly HIP reports.
 *
 *   leave:import-hip <file|dir> [<file|dir> …] [--confirm --operator <employee_uid>]
 *
 * Dry run by default (parse, resolve identities, classify, count — write nothing). `--confirm` needs
 * `--operator` with a data scope and the MariaDB source. It only INSERTs into employee_leave_record and
 * the coverage table (idempotent); it never touches employee_leave, leave_balance, attendance, identity,
 * grants or memberships. Rows are HIP-derived candidates with approval_status 'unverified' — not approvals.
 *
 * Identities come from the approved facescan_id links (the same resolution the attendance import uses).
 * A machine code with no link is counted and skipped. Output is counts only: no code, name, uid or date.
 */
const SOURCE_SYSTEM = 'hip_daily_report_remark';
const USAGE = 'usage: leave:import-hip <file|dir> [<file|dir> …] [--confirm --operator <employee_uid>]';

function parseArgs(argv) {
  const options = { inputs: [], confirm: false, operator: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--confirm') options.confirm = true;
    else if (arg === '--operator') {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) return { error: '--operator needs a value' };
      index += 1;
      options.operator = next;
    } else if (arg.startsWith('--')) return { error: `unknown option ${arg}` };
    else options.inputs.push(arg);
  }
  if (options.inputs.length === 0) return { error: USAGE };
  if (options.confirm && !options.operator) return { error: '--confirm needs --operator <employee_uid>' };
  if (options.operator && !options.confirm) return { error: '--operator is only used with --confirm' };
  return { options };
}

function expandInputs(inputs) {
  const files = [];
  for (const input of inputs) {
    if (fs.statSync(input).isDirectory()) {
      for (const name of fs.readdirSync(input).sort()) if (name.toLowerCase().endsWith('.csv')) files.push(path.join(input, name));
    } else files.push(input);
  }
  return files;
}

async function runHipLeaveImport(argv, { container }) {
  const parsed = parseArgs(argv);
  if (parsed.error) return { exitCode: EXIT.USAGE, report: { refused: parsed.error } };
  const { options } = parsed;
  const { repositories } = container;

  let files;
  const analyses = [];
  try {
    files = expandInputs(options.inputs);
    for (const file of files) {
      const decoded = decodeHipFile(fs.readFileSync(file));
      analyses.push({ ...analyzeHipLeaveFile(decoded.text), encoding: decoded.encoding });
    }
  } catch (error) {
    const known = error instanceof HipLeaveFileError;
    return { exitCode: EXIT.FILE_REFUSED, report: { refused: known ? error.message : 'a file could not be read', nothingWritten: true } };
  }
  const periods = analyses.map((analysis) => analysis.period);
  if (new Set(periods).size !== periods.length) {
    return { exitCode: EXIT.FILE_REFUSED, report: { refused: 'two files cover the same month; supply one file per month', nothingWritten: true } };
  }

  const identity = createEmployeeIdentityService({ repositories });
  const uidByMachine = new Map();
  async function resolve(machineId) {
    if (!uidByMachine.has(machineId)) {
      let uid = null;
      try { uid = await identity.resolveUid('facescan_id', machineId); } catch (error) {
        if (error.code !== 'EMPLOYEE_NOT_FOUND') throw error;
      }
      uidByMachine.set(machineId, uid);
    }
    return uidByMachine.get(machineId);
  }

  const months = [];
  const toWrite = [];
  const totals = { candidates: 0, days: 0, full: 0, am: 0, pm: 0, needsReview: 0, unmappedRecords: 0 };
  for (const analysis of analyses.sort((a, b) => a.period.localeCompare(b.period))) {
    const month = {
      period: analysis.period, encoding: analysis.encoding, rowsScanned: analysis.stats.rowsScanned, machines: analysis.stats.machines,
      remarkRows: analysis.stats.remarkRows, multiRemarkRows: analysis.stats.multiRemarkRows,
      candidates: 0, full: 0, am: 0, pm: 0, days: 0, needsReview: 0, reviewReasons: {}, unmappedRecords: 0,
      notLeave: { missingPunchOnly: analysis.stats.missingPunchOnly, absentFlagged: analysis.stats.absentFlagged, officialDuty: analysis.stats.officialDuty },
    };
    for (const record of analysis.records) {
      const employeeUid = await resolve(record.machineId);
      if (!employeeUid) { month.unmappedRecords += 1; continue; }
      if (record.reviewStatus === 'candidate') {
        month.candidates += 1;
        month[record.dayPart.toLowerCase()] += 1;
        month.days += record.dayFraction;
      } else {
        month.needsReview += 1;
        for (const reason of record.reviewReason.split(',')) month.reviewReasons[reason] = (month.reviewReasons[reason] || 0) + 1;
      }
      toWrite.push({
        employeeUid, leaveDate: record.date, leaveType: record.leaveType, dayPart: record.dayPart, dayFraction: record.dayFraction,
        reviewStatus: record.reviewStatus, reviewReason: record.reviewReason, sourceSystem: SOURCE_SYSTEM,
        sourcePeriod: analysis.period, sourceLine: record.line,
      });
    }
    months.push(month);
    for (const key of ['candidates', 'days', 'full', 'am', 'pm', 'needsReview', 'unmappedRecords']) totals[key] += month[key];
  }
  const unmappedMachines = [...uidByMachine.values()].filter((uid) => !uid).length;
  const summary = { months, totals, machinesInFiles: uidByMachine.size, unmappedMachines };

  if (!options.confirm) {
    return { exitCode: EXIT.OK, report: { mode: 'dry-run', written: false, files: files.length, ...summary } };
  }
  if (container.dataSource !== 'mariadb') {
    return { exitCode: EXIT.USAGE, report: { refused: '--confirm needs DATA_SOURCE=mariadb' } };
  }
  try {
    await operatorAuth(repositories, options.operator);
  } catch (error) {
    return { exitCode: error.exitCode ?? EXIT.NOT_AUTHORISED, report: { refused: error.message } };
  }
  const inserted = await repositories.leaveRecords.insertIgnore(toWrite);
  for (const analysis of analyses) {
    await repositories.leaveRecords.upsertCoverage({
      sourceSystem: SOURCE_SYSTEM, sourcePeriod: analysis.period,
      rowsScanned: analysis.stats.rowsScanned, employeesInSource: analysis.stats.machines,
    });
  }
  return {
    exitCode: EXIT.OK,
    report: { mode: 'apply', written: true, files: files.length, ...summary, rowsInserted: inserted, rowsAlreadyPresent: toWrite.length - inserted },
  };
}

module.exports = { runHipLeaveImport, parseArgs, SOURCE_SYSTEM };

if (require.main === module) {
  const { createContainer } = require('../container');
  const { closePool } = require('../db/pool');
  (async () => {
    let exitCode = 1;
    try {
      const result = await runHipLeaveImport(process.argv.slice(2), { container: createContainer() });
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
