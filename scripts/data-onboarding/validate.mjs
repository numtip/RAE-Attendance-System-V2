import { readFile } from 'node:fs/promises';
import { validateSource } from './lib.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/data-onboarding/validate.mjs <source.json>');
  process.exit(2);
}
const bundle = JSON.parse(await readFile(file, 'utf8'));
const result = validateSource(bundle);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
