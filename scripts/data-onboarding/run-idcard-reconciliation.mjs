/**
 * End-to-end local reconciliation (READ-ONLY DB export if configured).
 * Writes summary to database/local/idcard-reconciliation-summary.json (gitignored).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildControlledOnboardingDryRun,
  loadIdCardCsv,
  loadIdentifierKeys,
} from './idcardCsvLib.mjs';

const csvPath = process.argv[2] || 'database/IDCardRaecsv2027.csv';
const bundlePath = process.argv[3] || 'database/local/employee-reconciliation-bundle.json';
const outDir = path.join('database', 'local');
const summaryPath = path.join(outDir, 'idcard-reconciliation-summary.json');

let bundleExists = false;
try {
  await readFile(bundlePath, 'utf8');
  bundleExists = true;
} catch {
  const exportRun = spawnSync(process.execPath, ['scripts/data-onboarding/export-employee-bundle.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (exportRun.status === 0) bundleExists = true;
}

const { rows } = await loadIdCardCsv(csvPath);

let employees = [];
let identifiers = [];
if (bundleExists) {
  const bundle = JSON.parse(await readFile(bundlePath, 'utf8'));
  employees = bundle.employees || [];
  identifiers = bundle.employee_identifier || [];
}

let keys = null;
try {
  keys = loadIdentifierKeys();
} catch (error) {
  if (
    process.env.EMPLOYEE_IDENTIFIER_HMAC_KEY
    || process.env.EMPLOYEE_IDENTIFIER_ENCRYPTION_KEY
    || process.env.EMPLOYEE_IDENTIFIER_ENCRYPTION_KEY_ID
  ) {
    throw error;
  }
  // Validation/classification can still run against legacy raw-value bundles.
}
const dryRun = buildControlledOnboardingDryRun(rows, { employees, identifiers }, keys);

const summary = {
  csvPath,
  bundlePath: bundleExists ? bundlePath : null,
  writesDatabase: false,
  sourceRows: dryRun.sourceRows,
  stagedRows: dryRun.stagedRows,
  validationIssueCount: dryRun.validationIssues.length,
  classification: dryRun.classification,
  secureMaterialPrepared: dryRun.secureMaterialPrepared,
  readyForApprovedImport: Boolean(
    bundleExists
    && keys
    && dryRun.validationIssues.length === 0
    && dryRun.classification.HARD_CONFLICT === 0
    && dryRun.classification.CREATE_CANDIDATE === 0
    && dryRun.classification.ATTACH_REVIEW === 0
  ),
};

await mkdir(outDir, { recursive: true });
await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
console.log(JSON.stringify(summary, null, 2));
