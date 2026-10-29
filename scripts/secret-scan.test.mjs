import assert from 'node:assert/strict';
import test from 'node:test';
import { isBlockedSqlPath, scanText } from './secret-scan.mjs';

const privateKeyMarker = ['BEGIN ', 'RSA ', 'PRIVATE KEY'].join('');

test('a rollback SQL file is accepted when it has no secret content', () => {
  assert.equal(isBlockedSqlPath('database/rollbacks/025_revoked_access_tokens.down.sql'), false);
  assert.deepEqual(
    scanText('database/rollbacks/025_revoked_access_tokens.down.sql', 'DROP TABLE IF EXISTS revoked_access_tokens;\n'),
    [],
  );
});

test('SQL outside migrations, seeds, and rollbacks is rejected by path', () => {
  for (const file of ['notes/drop.sql', 'database/local/x.sql', 'database/rollbacks-extra/x.sql']) {
    assert.equal(isBlockedSqlPath(file), true);
    assert.deepEqual(scanText(file, 'SELECT 1;\n'), [`${file}: blocked filename`]);
  }
});

test('secret content inside an allowed rollback file is still rejected', () => {
  // The path must match the narrow `NNN_name.sql` rule, otherwise the file is refused for its
  // name and this test would stop testing content scanning at all.
  const failures = scanText(
    'database/rollbacks/999_evil.down.sql',
    `-- ${privateKeyMarker}\nDROP TABLE IF EXISTS revoked_access_tokens;\n`,
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /matched/);
});

test('a rollback SQL file that does not follow NNN_name.sql is refused by path', () => {
  // The stricter rule from migration 015-024 hardening: a bare directory prefix would admit an
  // arbitrary dump, so only numbered reviewed files are exempt.
  assert.equal(isBlockedSqlPath('database/rollbacks/evil.down.sql'), true);
  assert.deepEqual(
    scanText('database/rollbacks/evil.down.sql', 'DROP TABLE IF EXISTS x;\n'),
    ['database/rollbacks/evil.down.sql: blocked filename'],
  );
});
