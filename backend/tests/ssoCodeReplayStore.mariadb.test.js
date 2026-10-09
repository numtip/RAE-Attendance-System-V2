/**
 * Disposable MariaDB only. GitHub Actions job backend-mariadb publishes the
 * service container on 127.0.0.1:3307. This file does not connect on raeserver
 * and does not use port 3306.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const mysql = require('mysql2/promise');
const { HttpError } = require('../src/utils/httpError');
const { createMariaDbCodeReplayStore, digestHex } = require('../src/services/sso/mariadbCodeReplayStore');

const host = process.env.DB_HOST || '';
const port = Number(process.env.DB_PORT || 0);
const allowed = process.env.CI === 'true'
  && process.env.RUN_MARIADB_TESTS === '1'
  && os.hostname() !== 'raeserver'
  && (host === '127.0.0.1' || host === 'localhost')
  && port === 3307
  && host !== '10.1.245.190'
  && Boolean(process.env.DB_NAME && process.env.DB_USER);

const sqlPath = path.resolve(path.dirname(require.resolve('../package.json')), '../database/migrations/018_sso_consumed_code.sql');
const digests = [];

function remember(code) {
  const digest = digestHex(code);
  digests.push(digest);
  return digest;
}

test.describe('SSO replay store on disposable MariaDB 11.4', { skip: !allowed }, () => {
  let pool;

  test.before(async () => {
    pool = mysql.createPool({
      host,
      port,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD || '',
      connectionLimit: 4,
      multipleStatements: true,
    });
    const [[version]] = await pool.query('SELECT VERSION() AS version');
    assert.match(String(version.version), /11\.4/);
    await pool.query(fs.readFileSync(sqlPath, 'utf8'));
  });

  test.after(async () => {
    if (!pool) return;
    if (digests.length > 0) {
      await pool.query('DELETE FROM sso_consumed_code WHERE code_digest IN (?)', [digests]);
    }
    await pool.end();
  });

  test('atomic insert stores the digest and not the raw ac', async () => {
    const code = 'phase-d-atomic-ac';
    const digest = remember(code);
    const store = createMariaDbCodeReplayStore(pool, { ttlSeconds: 3600 });
    assert.equal(await store.claim(code), true);
    const [rows] = await pool.query(
      'SELECT code_digest, CHAR_LENGTH(code_digest) AS len FROM sso_consumed_code WHERE code_digest = ?',
      [digest],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].len, 64);
    const [raw] = await pool.query(
      'SELECT COUNT(*) AS n FROM sso_consumed_code WHERE code_digest = ?',
      [code],
    );
    assert.equal(Number(raw[0].n), 0);
  });

  test('duplicate insert is errno 1062 and the store returns false', async () => {
    const code = 'phase-d-dup-ac';
    const digest = remember(code);
    const store = createMariaDbCodeReplayStore(pool);
    assert.equal(await store.claim(code), true);
    assert.equal(await store.claim(code), false);
    await assert.rejects(
      () => pool.query(
        `INSERT INTO sso_consumed_code (code_digest, expires_at, claimed_at)
         VALUES (?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 60 SECOND), UTC_TIMESTAMP(3))`,
        [digest],
      ),
      (err) => err.errno === 1062,
    );
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS n FROM sso_consumed_code WHERE code_digest = ?',
      [digest],
    );
    assert.equal(Number(rows[0].n), 1);
  });

  test('parallel claim leaves one row', async () => {
    const code = 'phase-d-parallel-ac';
    const digest = remember(code);
    const left = createMariaDbCodeReplayStore(pool);
    const right = createMariaDbCodeReplayStore(pool);
    const [a, b] = await Promise.all([left.claim(code), right.claim(code)]);
    assert.deepEqual([a, b].sort(), [false, true]);
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS n FROM sso_consumed_code WHERE code_digest = ?',
      [digest],
    );
    assert.equal(Number(rows[0].n), 1);
  });

  test('a new store on the same database still rejects the replay', async () => {
    const code = 'phase-d-persist-ac';
    remember(code);
    assert.equal(await createMariaDbCodeReplayStore(pool).claim(code), true);
    assert.equal(await createMariaDbCodeReplayStore(pool).claim(code), false);
  });

  test('cleanup deletes expired rows and keeps an unexpired digest', async () => {
    const expired = digestHex('phase-d-expired-ac');
    const live = digestHex('phase-d-live-ac');
    const fresh = 'phase-d-fresh-ac';
    digests.push(expired, live, digestHex(fresh));
    await pool.query(
      `INSERT INTO sso_consumed_code (code_digest, expires_at, claimed_at) VALUES
       (?, DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 5 SECOND), UTC_TIMESTAMP(3)),
       (?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 600 SECOND), UTC_TIMESTAMP(3))`,
      [expired, live],
    );
    assert.equal(await createMariaDbCodeReplayStore(pool).claim(fresh), true);
    const [gone] = await pool.query('SELECT COUNT(*) AS n FROM sso_consumed_code WHERE code_digest = ?', [expired]);
    const [kept] = await pool.query('SELECT COUNT(*) AS n FROM sso_consumed_code WHERE code_digest = ?', [live]);
    assert.equal(Number(gone[0].n), 0);
    assert.equal(Number(kept[0].n), 1);
  });

  test('a closed connection fails closed', async () => {
    const dead = await mysql.createConnection({
      host,
      port,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD || '',
    });
    await dead.end();
    const store = createMariaDbCodeReplayStore(dead);
    await assert.rejects(
      () => store.claim('phase-d-down-ac'),
      (err) => err instanceof HttpError && err.status === 503 && err.code === 'SSO_REPLAY_STORE_UNAVAILABLE',
    );
  });
});
