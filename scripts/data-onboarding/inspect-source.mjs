import { readFile } from 'node:fs/promises';
import { inspectSource } from './lib.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/data-onboarding/inspect-source.mjs <source.json>');
  process.exit(2);
}
const bundle = JSON.parse(await readFile(file, 'utf8'));
console.log(JSON.stringify(inspectSource(bundle), null, 2));
