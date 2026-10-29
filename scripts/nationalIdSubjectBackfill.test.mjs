/**
 * N-6 backfill and duplicate detection — pure logic, no database, synthetic IDs only.
 *
 * The synthetic national IDs below are checksum-valid-looking but belong to nobody: they exist to prove the
 * detection logic, not to seed anything. (The repository's fixture-hygiene test treats a checksum-valid
 * literal as a real person's ID, so these values are deliberately 13 digits that are NOT checksum-valid —
 * the functions under test only need 13 digits, they do not validate the checksum.)
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { subjectKeyFor, findDuplicates, parseCsv } = await import('./national-id-subject-backfill.mjs');

const KEY = 'index-key-for-tests-only-32-bytes-min';
const OTHER_KEY = 'another-index-key-also-32-bytes-long!';

test('the subject key is deterministic and key-dependent', () => {
  const a = subjectKeyFor('1234567890123', KEY);
  const b = subjectKeyFor('1234567890123', KEY);
  const c = subjectKeyFor('1234567890123', OTHER_KEY);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, b);
  assert.notEqual(a, c, 'a different index key must produce a different subject key');
});

test('formatting characters in the source ID do not change the subject key', () => {
  assert.equal(subjectKeyFor('1-2345-67890-12-3', KEY), subjectKeyFor('1234567890123', KEY));
});

test('a short or missing index key is refused, and no unkeyed fallback exists', () => {
  assert.throws(() => subjectKeyFor('1234567890123', 'too-short'), (error) => error.code === 'INDEX_KEY_INVALID');
  assert.throws(() => subjectKeyFor('1234567890123', ''), (error) => error.code === 'INDEX_KEY_INVALID');
});

test('a malformed national ID is refused rather than hashed', () => {
  assert.throws(() => subjectKeyFor('123456789012', KEY), (error) => error.code === 'NATIONAL_ID_INVALID');
  assert.throws(() => subjectKeyFor('', KEY), (error) => error.code === 'NATIONAL_ID_INVALID');
});

test('duplicate detection: one person under two employees is flagged', () => {
  const rows = [
    { employeeUid: 'emp-b', nationalId: '1234567890123' },
    { employeeUid: 'emp-c', nationalId: '1234567890123' },
  ];
  const { duplicates, unique } = findDuplicates(rows, KEY);
  assert.equal(duplicates.length, 1);
  assert.deepEqual(duplicates[0].employees.sort(), ['emp-b', 'emp-c']);
  assert.equal(unique.length, 0);
});

test('duplicate detection: distinct people are not flagged, and the plan keeps one entry each', () => {
  const rows = [
    { employeeUid: 'emp-a', nationalId: '1111111111111' },
    { employeeUid: 'emp-b', nationalId: '2222222222222' },
  ];
  const { duplicates, unique } = findDuplicates(rows, KEY);
  assert.equal(duplicates.length, 0);
  assert.equal(unique.length, 2);
  assert.deepEqual(unique.map((row) => row.employeeUid).sort(), ['emp-a', 'emp-b']);
});

test('the CSV reader is header-driven and refuses a wrong header', () => {
  const rows = parseCsv('employee_uid,national_id,note\nemp-a,1234567890123,x\nemp-b,2222222222222,y\n');
  assert.deepEqual(rows, [
    { employeeUid: 'emp-a', nationalId: '1234567890123' },
    { employeeUid: 'emp-b', nationalId: '2222222222222' },
  ]);
  assert.throws(() => parseCsv('uid,id\nemp-a,1234567890123\n'), (error) => error.code === 'CSV_HEADER_INVALID');
});

test('non-vacuity: swapping the index key changes which rows collide', () => {
  // Two IDs that collide under one key cannot be asserted, so instead assert the key really is an input:
  // the same rows keep their grouping, but the computed keys differ per key.
  const rows = [{ employeeUid: 'emp-a', nationalId: '1111111111111' }];
  const keyA = findDuplicates(rows, KEY).unique[0].subjectKey;
  const keyB = findDuplicates(rows, OTHER_KEY).unique[0].subjectKey;
  assert.notEqual(keyA, keyB);
});
