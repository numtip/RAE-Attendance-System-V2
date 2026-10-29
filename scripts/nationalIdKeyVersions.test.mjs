/**
 * N-2 — the key-version audit classifies stored digests correctly, and it is not vacuous.
 *
 * Pure test: no database, no key material. The rows fed in are synthetic shapes of what the SELECT
 * returns, so the assertion is about the classification rule rather than about MariaDB.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { classifyKeyVersions } = await import('./national-id-key-versions.mjs');

test('N-2: a stored version that is still accepted is reported accepted', () => {
  const result = classifyKeyVersions([{ lookup_key_version: 1, rows: 3 }], [1, 2]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.orphaned, []);
  assert.deepEqual(result.rows, [{ version: 1, rows: 3, status: 'accepted' }]);
});

test('N-2: dropping the only version an employee was written under is reported ORPHANED', () => {
  const result = classifyKeyVersions([{ lookup_key_version: 1, rows: 2 }], [2]);
  assert.equal(result.ok, false);
  assert.equal(result.orphaned.length, 1);
  assert.equal(result.orphaned[0].rows, 2);
});

test('N-2: the count is summed per version, so the report is not one row', () => {
  const result = classifyKeyVersions(
    [{ lookup_key_version: 1, rows: 2 }, { lookup_key_version: 9, rows: 5 }],
    [1],
  );
  assert.equal(result.ok, false);
  assert.equal(result.orphaned.reduce((sum, row) => sum + row.rows, 0), 5);
});

test('N-2: a NULL version is ORPHANED, not ignored — the CHECK requires a version', () => {
  const result = classifyKeyVersions([{ lookup_key_version: null, rows: 1 }], [1]);
  assert.equal(result.ok, false);
  assert.equal(result.orphaned[0].version, null);
});

test('N-2: no stored rows is a clean result, not a pass by accident', () => {
  const result = classifyKeyVersions([], [1]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows, []);
});

test('N-2: the non-vacuity guard — the same rows must flip status when the accepted set changes', () => {
  const rows = [{ lookup_key_version: 2, rows: 1 }];
  assert.equal(classifyKeyVersions(rows, [1, 2]).ok, true);
  assert.equal(classifyKeyVersions(rows, [1]).ok, false);
});
