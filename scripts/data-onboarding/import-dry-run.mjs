import { readFile } from 'node:fs/promises';
import { dryRun } from './lib.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/data-onboarding/import-dry-run.mjs <source.json> [applied-keys.json]');
  process.exit(2);
}
const sourceText = await readFile(file, 'utf8');
const bundle = JSON.parse(sourceText);
let appliedKeys = [];
if (process.argv[3]) {
  const applied = JSON.parse(await readFile(process.argv[3], 'utf8'));
  appliedKeys = Array.isArray(applied) ? applied : applied.keys ?? [];
}
const report = dryRun(bundle, { appliedKeys, sourceText });
console.log(JSON.stringify(report, null, 2));
process.exit(report.validation.ok ? 0 : 1);
