import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const converter = join(here, 'roster-csv-to-bundle.mjs');
const importer = join(here, 'apply-import.mjs');

const HEADER = 'ID HIP,name,c_name,email,employee type,ID card,คำอธิบาย';
const ROWS = [
  '1001,สมชาย,ใจดี,somchai@mju.ac.th,university,1234567890123,อาจารย์',
  '1002,สมหญิง,ขยัน,somying@mju.ac.th,contract,9876543210987,เจ้าหน้าที่',
  '1003,สมปอง,ตั้งใจ,sompong@mju.ac.th,department,1111111111111,พนักงาน',
];

function run(script, args, options = {}) {
  try {
    return { code: 0, stdout: execFileSync('node', [script, ...args], { encoding: 'utf8', stdio: 'pipe', ...options }) };
  } catch (error) {
    return { code: error.status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

function workdir(rows = ROWS) {
  const dir = mkdtempSync(join(tmpdir(), 'roster-'));
  const csv = join(dir, 'roster.csv');
  writeFileSync(csv, `${HEADER}\n${rows.join('\n')}\n`);
  return { dir, csv, bundle: join(dir, 'bundle.json') };
}

test('the converter emits one employee per roster row and drops the national ID', () => {
  const { csv, bundle } = workdir();
  const result = run(converter, [csv, '--department', 'RAE-TEST', '--out', bundle]);
  assert.equal(result.code, 0, result.stderr);

  const text = readFileSync(bundle, 'utf8');
  const parsed = JSON.parse(text);
  assert.equal(parsed.employees.length, 3);
  assert.equal(parsed.employees[0].department, 'RAE-TEST');
  assert.equal(parsed.employees[0].employee_type, 'university');
  assert.ok(!text.includes('1234567890123'), 'a national ID must never reach the bundle');
  assert.ok(!text.includes('ID card'));
});

test('the converter refuses a roster without a stated department', () => {
  const { csv } = workdir();
  const result = run(converter, [csv]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--department is required/);
});

test('the converter refuses duplicate roster codes', () => {
  const { csv } = workdir([...ROWS, ROWS[0]]);
  const result = run(converter, [csv, '--department', 'RAE-TEST']);
  assert.equal(result.code, 4);
  assert.match(result.stderr, /duplicate ID HIP/);
});

test('the importer previews without a database and refuses to write unasked', () => {
  const { csv, bundle } = workdir();
  run(converter, [csv, '--department', 'RAE-TEST', '--out', bundle]);

  const preview = run(importer, [bundle, '--dry-run']);
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).employees, 3);

  const unasked = run(importer, [bundle]);
  assert.equal(unasked.code, 2);
  assert.match(unasked.stderr, /REFUSED/);
});
