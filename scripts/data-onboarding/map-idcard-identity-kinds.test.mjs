import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './map-idcard-identity-kinds.mjs';

const cli = fileURLToPath(new URL('./map-idcard-identity-kinds.mjs', import.meta.url));

function synthetic(n) {
  const prefix = `9${String(n).padStart(11, '0')}`;
  const sum = [...prefix].reduce((acc, digit, index) => acc + Number(digit) * (13 - index), 0);
  return `${prefix}${(11 - (sum % 11)) % 10}`;
}

function run(args, env = {}) {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) if (key.startsWith('EMPLOYEE_IDENTIFIER_')) delete clean[key];
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...clean, ...env } });
}

test('parseCsv handles quotes, embedded commas and CRLF', () => {
  const rows = parseCsv('a,b,c\r\n"1,1",2,"x ""y"""\r\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1,1', '2', 'x "y"']]);
});

test('CLI: masked counts, CSV untouched, nothing written, fails closed without a key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rae-idkind-'));
  try {
    const csv = join(dir, 'synthetic.csv');
    // 3 unique people + 1 exact duplicate row; header has non-ASCII bytes like the real file
    const body = ['ID card Code,Facescan Code,name,unit']
      .concat([1, 2, 3].map((n) => `${synthetic(n)},HX${n}000,Synthetic Person ${n},Unit`))
      .concat([`${synthetic(1)},HX1000,Synthetic Person 1,Unit`])
      .join('\n');
    writeFileSync(csv, body, 'latin1');
    const before = createHash('sha256').update(readFileSync(csv)).digest('hex');

    const denied = run(['--csv', csv, '--summary']);
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /HMAC key is not configured/);
    assert.equal(denied.stdout, '');

    const result = run(['--csv', csv, '--ephemeral-key', '--hip-approval-ref', 'APPROVAL-SYNTHETIC', '--accept-unverified-mju-absence']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.keySource, 'ephemeral-in-memory');
    assert.equal(report.input.rows, 4);
    assert.equal(report.input.uniqueRows, 3);
    assert.equal(report.input.duplicateRowsCollapsed, 1);
    assert.deepEqual(report.counts, { MJU: 0, HIP: 3, UNRESOLVED: 0 });
    for (const n of [1, 2, 3]) {
      assert.equal(result.stdout.includes(synthetic(n)), false);
      assert.equal(result.stdout.includes(`HX${n}000`), false);
    }

    const unapproved = JSON.parse(run(['--csv', csv, '--ephemeral-key', '--summary']).stdout);
    assert.deepEqual(unapproved.counts, { MJU: 0, HIP: 0, UNRESOLVED: 3 });
    assert.equal(unapproved.hipEligibleStructural, 3);
    assert.equal(unapproved.items, undefined);

    assert.equal(createHash('sha256').update(readFileSync(csv)).digest('hex'), before, 'source CSV must stay unmodified');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
