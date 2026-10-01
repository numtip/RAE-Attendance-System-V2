import { readFile } from 'node:fs/promises';
import { reconcile } from './lib.mjs';

const reportFile = process.argv[2];
const expectedFile = process.argv[3];
if (!reportFile || !expectedFile) {
  console.error('usage: node scripts/data-onboarding/reconcile.mjs <dry-run.json> <expected.json>');
  process.exit(2);
}
const report = JSON.parse(await readFile(reportFile, 'utf8'));
const expected = JSON.parse(await readFile(expectedFile, 'utf8'));
const result = reconcile(report, expected);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
