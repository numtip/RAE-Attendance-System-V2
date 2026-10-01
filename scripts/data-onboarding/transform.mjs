import { readFile } from 'node:fs/promises';
import { transformSource, validateSource } from './lib.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/data-onboarding/transform.mjs <source.json>');
  process.exit(2);
}
const bundle = JSON.parse(await readFile(file, 'utf8'));
const validation = validateSource(bundle);
if (!validation.ok) {
  console.error(JSON.stringify(validation, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(transformSource(bundle), null, 2));
