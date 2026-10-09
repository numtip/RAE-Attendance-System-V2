import { readFile } from 'node:fs/promises';
import {
  buildControlledOnboardingDryRun,
  loadIdCardCsv,
  loadIdentifierKeys,
} from './idcardCsvLib.mjs';

const csvPath = process.argv[2] || 'database/IDCardRaecsv2027.csv';
const bundlePath = process.argv[3] || '';

const { rows } = await loadIdCardCsv(csvPath);

let employees = [];
let identifiers = [];
if (bundlePath) {
  const bundle = JSON.parse(await readFile(bundlePath, 'utf8'));
  employees = bundle.employees || [];
  identifiers = bundle.employee_identifier || bundle.employeeIdentifiers || [];
}

let keys = null;
let keyStatus = 'NOT_CONFIGURED';
try {
  keys = loadIdentifierKeys();
  keyStatus = 'CONFIGURED_SEPARATE_KEYS';
} catch (error) {
  if (
    process.env.EMPLOYEE_IDENTIFIER_HMAC_KEY
    || process.env.EMPLOYEE_IDENTIFIER_ENCRYPTION_KEY
    || process.env.EMPLOYEE_IDENTIFIER_ENCRYPTION_KEY_ID
  ) {
    throw error;
  }
}

const dryRun = buildControlledOnboardingDryRun(rows, { employees, identifiers }, keys);

console.log(JSON.stringify({
  file: csvPath,
  bundle: bundlePath || null,
  writesDatabase: dryRun.writesDatabase,
  keyStatus,
  sourceRows: dryRun.sourceRows,
  stagedRows: dryRun.stagedRows,
  exactDuplicateGroups: dryRun.exactDuplicateGroups,
  validationIssueCount: dryRun.validationIssues.length,
  validationIssues: dryRun.validationIssues,
  classifications: dryRun.classification,
  conflictRowNumbers: dryRun.items
    .filter((item) => item.classification === 'HARD_CONFLICT')
    .map((item) => item.rowNumber),
  secureMaterialPrepared: dryRun.secureMaterialPrepared,
  approvalPlan: {
    createCandidatesRequireEmployeeMasterApproval: true,
    attachCandidatesRequireHumanReview: true,
    hardConflictsBlockImport: true,
    employeeUid: 'GENERATE_UUID_ON_APPROVED_IMPORT_ONLY',
  },
}, null, 2));
