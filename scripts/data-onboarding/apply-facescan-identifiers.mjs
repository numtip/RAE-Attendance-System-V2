#!/usr/bin/env node
/**
 * Link verified HIP device codes to existing employees (`employee_identifier.facescan_id`).
 *
 *   DATA_SOURCE=mariadb DB_HOST=... DB_NAME=... DB_USER=... DB_PASSWORD=... \
 *     node scripts/data-onboarding/apply-facescan-identifiers.mjs <mapping.csv>                 # dry run
 *     ... <mapping.csv> --evidence "<where the pairs were verified>" --confirm [--re-resolve]
 *
 * `<mapping.csv>` has the columns `employee_id,facescan_id`. Rules and statuses: `facescanIdentifiers.mjs`.
 * The dry run reads the database and writes nothing. `--confirm` needs `--evidence` and a plan with no
 * conflicts. `--re-resolve` then promotes quarantined (`unmapped`) staging rows through the existing
 * `reResolveUnmapped`. Output is aggregates and line numbers only.
 *
 * Exit codes: 0 ok · 2 usage · 3 file refused · 4 conflicts (nothing written) · 5 some links failed.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  parseMappingFile, planMappings, summarize, applyMappings, validateEvidence, MappingFileError,
} from './facescanIdentifiers.mjs';

const require = createRequire(import.meta.url);
const EXIT = Object.freeze({ OK: 0, USAGE: 2, FILE_REFUSED: 3, CONFLICTS: 4, LINK_FAILED: 5 });

function parseArgs(argv) {
  const options = { file: null, evidence: null, confirm: false, reResolve: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--confirm') options.confirm = true;
    else if (arg === '--re-resolve') options.reResolve = true;
    else if (arg === '--evidence') {
      options.evidence = argv[index + 1] ?? '';
      index += 1;
    } else if (arg.startsWith('--')) return { error: `unknown option ${arg}` };
    else if (options.file) return { error: 'exactly one mapping file' };
    else options.file = arg;
  }
  if (!options.file) return { error: 'usage: apply-facescan-identifiers.mjs <mapping.csv> [--evidence <ref> --confirm [--re-resolve]]' };
  if (options.reResolve && !options.confirm) return { error: '--re-resolve writes and needs --confirm' };
  if (options.confirm) {
    const problem = validateEvidence(options.evidence);
    if (problem) return { error: problem };
  }
  return { options };
}

/**
 * @param {string[]} argv
 * @param {{ container: { dataSource, repositories, nationalIdProtector? }, readFile: (file) => Promise<Buffer> }} deps
 */
export async function runFacescanIdentifiers(argv, { container, readFile: read }) {
  const parsed = parseArgs(argv);
  if (parsed.error) return { exitCode: EXIT.USAGE, report: { refused: parsed.error } };
  const { options } = parsed;
  if (container.dataSource !== 'mariadb') {
    return { exitCode: EXIT.USAGE, report: { refused: 'needs DATA_SOURCE=mariadb and DB_*: a plan against fixtures proves nothing' } };
  }

  let mapping;
  try {
    mapping = parseMappingFile(await read(options.file));
  } catch (error) {
    if (!(error instanceof MappingFileError)) throw error;
    return { exitCode: EXIT.FILE_REFUSED, report: { refused: error.message, issues: error.issues } };
  }

  const { repositories } = container;
  const planned = await planMappings(mapping.pairs, repositories);
  const plan = summarize(planned);
  const report = { mode: options.confirm ? 'apply' : 'dry-run', mappingSha256: mapping.contentSha256, plan, written: false };
  if (plan.conflicts.length > 0) return { exitCode: EXIT.CONFLICTS, report };
  if (!options.confirm) return { exitCode: EXIT.OK, report };

  const { createEmployeeIdentityService } = require('../../backend/src/services/employeeIdentityService.js');
  const identity = createEmployeeIdentityService({ repositories, nationalIdProtector: container.nationalIdProtector ?? null });
  report.evidence = options.evidence.trim();
  report.outcomes = await applyMappings(planned, { identity, evidence: options.evidence });
  report.written = Boolean(report.outcomes.linked);

  if (options.reResolve) {
    const { createFacescanRawIngestionService } = require('../../backend/src/services/facescanRawIngestionService.js');
    const ingestion = createFacescanRawIngestionService({ repositories });
    const { resolved, stillUnmapped } = await ingestion.reResolveUnmapped({});
    report.reResolve = { resolved, stillUnmapped };
  }
  const failed = Object.keys(report.outcomes).some((outcome) => outcome !== 'linked');
  return { exitCode: failed ? EXIT.LINK_FAILED : EXIT.OK, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { createContainer } = require('../../backend/src/container.js');
  const { closePool } = require('../../backend/src/db/pool.js');
  let exitCode = 1;
  try {
    const container = createContainer();
    const result = await runFacescanIdentifiers(process.argv.slice(2), { container, readFile });
    exitCode = result.exitCode;
    (exitCode === 0 ? console.log : console.error)(JSON.stringify(result.report, null, 2));
  } catch (error) {
    // Class and code only: a driver message can echo SQL values.
    console.error(JSON.stringify({ failed: error?.name ?? 'Error', code: error?.code ?? null }));
  } finally {
    await closePool();
  }
  process.exit(exitCode);
}
