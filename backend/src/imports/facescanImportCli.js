const path = require('node:path');
const { HttpError } = require('../utils/httpError');
const { resolveScope } = require('../services/authorizationService');
const { createFacescanRawIngestionService } = require('../services/facescanRawIngestionService');
const { createAttendanceRecordService } = require('../services/attendanceRecordService');
const { createFacescanAttendanceIngestionService } = require('../services/facescanAttendanceIngestionService');

/**
 * `npm run facescan:import` — the operator entry point for HIP FaceScan files.
 *
 *   facescan:import <file> --format hip-daily|canonical [--label <text>]
 *                   [--confirm] [--derive --operator <employee_uid>]
 *
 * Wiring only. Parsing, idempotency, identity resolution and quarantine are `facescanRawIngestionService`;
 * the day and month are `facescanAttendanceIngestionService.deriveDay` and the AR-0001 record path. This
 * module adds no rule of its own.
 *
 * Fail closed:
 *   - the default is a dry run (no batch, no staging row); writing needs `--confirm`;
 *   - `--format` is required — guessing a vendor layout is how a file gets misread;
 *   - writing needs the MariaDB data source, so a fixture run cannot pass for an import;
 *   - `--derive` runs as a real employee and through the same RBAC as the HTTP route. Scope is checked
 *     before the first write, so an operator without data scope imports nothing.
 *
 * Output is aggregates only: no facescan_id, name or national ID is ever printed.
 */

const FORMATS = Object.freeze({ 'hip-daily': 'hip_daily_report', canonical: 'canonical' });
const EXIT = Object.freeze({ OK: 0, USAGE: 2, FILE_REFUSED: 3, NOT_AUTHORISED: 4, DERIVE_INCOMPLETE: 5 });
const USAGE = 'usage: facescan:import <file> --format hip-daily|canonical [--label <text>] '
  + '[--confirm] [--derive --operator <employee_uid>]';

class CliError extends Error {
  constructor(exitCode, message, details = undefined) {
    super(message);
    this.exitCode = exitCode;
    this.details = details;
  }
}

function parseArgs(argv) {
  const options = { file: null, format: null, label: null, confirm: false, derive: false, operator: null };
  const valueOf = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new CliError(EXIT.USAGE, `${flag} needs a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--confirm') options.confirm = true;
    else if (arg === '--derive') options.derive = true;
    else if (arg === '--format') { options.format = valueOf(index, arg); index += 1; }
    else if (arg === '--label') { options.label = valueOf(index, arg); index += 1; }
    else if (arg === '--operator') { options.operator = valueOf(index, arg); index += 1; }
    else if (arg.startsWith('--')) throw new CliError(EXIT.USAGE, `unknown option ${arg}`);
    else if (options.file) throw new CliError(EXIT.USAGE, 'exactly one file');
    else options.file = arg;
  }
  if (!options.file) throw new CliError(EXIT.USAGE, USAGE);
  if (!FORMATS[options.format]) throw new CliError(EXIT.USAGE, `--format must be one of ${Object.keys(FORMATS).join(', ')}`);
  if (options.derive && !options.confirm) throw new CliError(EXIT.USAGE, '--derive writes attendance and needs --confirm');
  if (options.derive && !options.operator) throw new CliError(EXIT.USAGE, '--derive needs --operator <employee_uid>');
  if (options.operator && !options.derive) throw new CliError(EXIT.USAGE, '--operator is only used with --derive');
  return options;
}

/** The operator acts exactly as their own login would: their role and their grants, nothing more. */
async function operatorAuth(repositories, employeeUid) {
  const employee = await repositories.employees.findByUid(employeeUid);
  if (!employee) throw new CliError(EXIT.NOT_AUTHORISED, 'operator is not an employee');
  const auth = { employeeUid, role: employee.role, authMethod: 'operator_cli' };
  const scope = await resolveScope(auth, repositories, 'data');
  if (!(scope.all || scope.broad)) {
    throw new CliError(EXIT.NOT_AUTHORISED, 'operator has no data scope to record attendance (needs a grant)');
  }
  return auth;
}

function deriveTargets(ingested) {
  const targets = new Map();
  ingested.results.forEach((result, index) => {
    if (!result.employeeUid || !['resolved', 'duplicate'].includes(result.resolutionStatus)) return;
    const date = ingested.rows[index].scanDatetime.slice(0, 10);
    targets.set(`${result.employeeUid}|${date}`, { employeeUid: result.employeeUid, date });
  });
  return [...targets.values()];
}

function countBy(results, key) {
  const counts = {};
  for (const result of results) counts[result[key]] = (counts[result[key]] || 0) + 1;
  return counts;
}

/**
 * @param {string[]} argv arguments after the script name
 * @param {{ container, readFile: (file) => Promise<Buffer> }} deps
 * @returns {Promise<{ exitCode: number, report: object }>}
 */
async function runFacescanImport(argv, { container, readFile }) {
  try {
    const options = parseArgs(argv);
    const format = FORMATS[options.format];
    const { repositories } = container;
    const ingestion = createFacescanRawIngestionService({
      repositories,
      nationalIdProtector: container.nationalIdProtector ?? null,
    });
    const content = await readFile(options.file);

    if (!options.confirm) {
      const preview = await ingestion.previewFile(content, { format });
      return { exitCode: EXIT.OK, report: { mode: 'dry-run', written: false, ...preview } };
    }

    if (container.dataSource !== 'mariadb') {
      throw new CliError(EXIT.USAGE, '--confirm needs DATA_SOURCE=mariadb; a fixture run would import nothing real');
    }
    // Before the first write: an operator who cannot derive must not leave a half-done import behind.
    const auth = options.derive ? await operatorAuth(repositories, options.operator) : null;

    const label = options.label ?? (options.file === '-' ? 'stdin' : path.basename(options.file));
    const ingested = await ingestion.ingestFile(content, { format, sourceLabel: label });
    const { batch } = ingested;
    const report = {
      mode: 'import',
      written: true,
      format,
      sourceSystem: ingested.sourceSystem,
      contentSha256: ingested.contentSha256,
      summary: ingested.summary,
      batch: { id: batch.id, status: batch.status },
      scanRows: ingested.rows.length,
      rows: countBy(ingested.results, 'resolutionStatus'),
      derive: null,
    };
    if (!auth) return { exitCode: EXIT.OK, report };

    const facescanAttendance = createFacescanAttendanceIngestionService({
      repositories,
      recordService: createAttendanceRecordService({ repositories }),
    });
    const outcomes = [];
    for (const target of deriveTargets(ingested)) {
      try {
        await facescanAttendance.deriveDay(auth, target.employeeUid, target.date);
        outcomes.push({ outcome: 'recorded' });
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        outcomes.push({ outcome: error.code });
      }
    }
    report.derive = { employeeDays: outcomes.length, outcomes: countBy(outcomes, 'outcome') };
    const incomplete = outcomes.some((entry) => entry.outcome !== 'recorded');
    return { exitCode: incomplete ? EXIT.DERIVE_INCOMPLETE : EXIT.OK, report };
  } catch (error) {
    if (error instanceof CliError) {
      return { exitCode: error.exitCode, report: { refused: error.message } };
    }
    if (error instanceof HttpError && error.code === 'FACESCAN_FILE_INVALID') {
      // Issues carry line numbers and a reason only, never the offending value.
      return { exitCode: EXIT.FILE_REFUSED, report: { refused: error.message, issues: error.details?.issues ?? [] } };
    }
    if (error instanceof HttpError) {
      return { exitCode: EXIT.FILE_REFUSED, report: { refused: error.message, code: error.code } };
    }
    throw error;
  }
}

/** `-` reads the file from stdin, so `docker exec -i <backend> node src/imports/facescanImportCli.js - …` needs no copy. */
async function readInput(file) {
  if (file !== '-') return require('node:fs/promises').readFile(file);
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

module.exports = { runFacescanImport, parseArgs, operatorAuth, EXIT };

if (require.main === module) {
  // The image ships only backend/src, so the operator entry point lives here rather than in scripts/.
  const { createContainer } = require('../container');
  const { closePool } = require('../db/pool');
  (async () => {
    let exitCode = 1;
    try {
      const container = createContainer();
      const result = await runFacescanImport(process.argv.slice(2), { container, readFile: readInput });
      exitCode = result.exitCode;
      (exitCode === 0 ? console.log : console.error)(JSON.stringify(result.report, null, 2));
    } catch (error) {
      // Unexpected failure: class and code only; a driver message can echo SQL values.
      console.error(JSON.stringify({ failed: error?.name ?? 'Error', code: error?.code ?? null }));
    } finally {
      await closePool();
    }
    process.exit(exitCode);
  })();
}
