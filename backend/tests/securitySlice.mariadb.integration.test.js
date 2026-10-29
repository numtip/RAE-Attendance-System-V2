const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const enabled = process.env.RUN_SECURITY_MARIADB === '1';
const backendRoot = path.resolve(path.dirname(require.resolve('../src/app.js')), '..');
const repoRoot = path.join(backendRoot, '..');

function databaseFromEnv() {
  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    name: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  };
}

function safe(text) {
  const secret = process.env.DB_PASSWORD || '';
  return String(text || '').split(secret).join('[redacted]');
}

test('MariaDB security integration', { skip: enabled ? false : 'RUN_SECURITY_MARIADB is not set' }, async (t) => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'ci-fixture-only-secret';
  const database = databaseFromEnv();
  assert.equal(database.name, 'attendance_security_main_test');
  assert.equal(database.host, '127.0.0.1');
  assert.equal(database.port, 3306);

  const mysql = require('mysql2/promise');
  const bcrypt = require('bcryptjs');
  const { createApp } = require('../src/app');
  const config = require('../src/config');
  const { createMariaDbRepositories } = require('../src/repositories/mariadbRepositories');
  const { closePool } = require('../src/db/pool');

  const pool = mysql.createPool({
    host: database.host,
    port: database.port,
    database: database.name,
    user: database.user,
    password: database.password,
    waitForConnections: true,
    connectionLimit: 8,
    timezone: 'Z',
    // Rollback files are multi-statement (the DDL plus the ledger row that has to disappear with
    // it), and scripts/migrate.mjs already runs SQL files with multipleStatements: true (:143).
    // Without the flag here the harness was stricter than the runner, so a legitimate rollback
    // file failed with a syntax error at its second statement.
    multipleStatements: true,
  });
  const uid = '44444444-4444-4444-4444-444444444444';
  const email = 'security.slice@example.test';
  const repositories = createMariaDbRepositories(database);

  function listen(app) {
    const server = http.createServer(app);
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
  }
  function close(server) {
    return new Promise((resolve) => server.close(resolve));
  }
  async function api(port, method, route, { token, body } = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  }
  async function scalar(sql, params = []) {
    const [rows] = await pool.query(sql, params);
    return rows;
  }

  try {
    const version = await scalar('SELECT VERSION() AS version, DATABASE() AS db');
    assert.match(version[0].version, /^10\.11\.14/);
    assert.equal(version[0].db, 'attendance_security_main_test');

    await t.test('migration ledger keeps 018 and 019 reserved and records 025', async () => {
      const files = fs.readdirSync(path.join(repoRoot, 'database', 'migrations'))
        .filter((name) => name.endsWith('.sql'))
        .sort();
      assert.equal(files.some((name) => name.startsWith('018_')), false);
      assert.equal(files.some((name) => name.startsWith('019_')), false);
      assert.ok(files.includes('025_revoked_access_tokens.sql'));
      const applied = (await scalar('SELECT version FROM schema_migrations ORDER BY version')).map((row) => row.version);
      assert.deepEqual(applied, files);
      assert.equal(applied.includes('018_sso_consumed_code.sql'), false);
      assert.equal(applied.includes('019_sso_shared_claim.sql'), false);
    });

    await t.test('025 rolls down and back up on this database only', async () => {
      const down = fs.readFileSync(path.join(repoRoot, 'database', 'rollbacks', '025_revoked_access_tokens.down.sql'), 'utf8');
      const up = fs.readFileSync(path.join(repoRoot, 'database', 'migrations', '025_revoked_access_tokens.sql'), 'utf8');
      await pool.query(down);
      await pool.query('DELETE FROM schema_migrations WHERE version = ?', ['025_revoked_access_tokens.sql']);
      const missing = await scalar(
        `SELECT COUNT(*) AS n FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_name = 'revoked_access_tokens'`,
      );
      assert.equal(Number(missing[0].n), 0);
      await pool.query(up);
      await pool.query('INSERT INTO schema_migrations (version) VALUES (?)', ['025_revoked_access_tokens.sql']);
      const present = await scalar(
        `SELECT COUNT(*) AS n FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_name = 'revoked_access_tokens'`,
      );
      assert.equal(Number(present[0].n), 1);
    });

    await scalar('DELETE FROM refresh_tokens WHERE employee_uid = ?', [uid]);
    await scalar('DELETE FROM employees WHERE employee_uid = ?', [uid]);
    const passwordHash = bcrypt.hashSync('valid-pass', 8);
    await scalar(
      `INSERT INTO employees (
         employee_uid, employee_id, first_name_th, last_name_th, email, password_hash,
         department, employee_type, status, role, login_attempts, created_at, updated_at
       ) VALUES (?, 'E-SEC-TEST', 'ทดสอบ', 'ระบบ', ?, ?, 'สำนักงาน', 'university', 'active', 'user', 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [uid, email, passwordHash],
    );

    await t.test('concurrent failures persist and a rolled-back update does not', async () => {
      await scalar('UPDATE employees SET login_attempts = 0, locked_until = NULL WHERE employee_uid = ?', [uid]);
      const policy = { maxAttempts: 5, lockMs: 60_000 };
      await Promise.all([
        repositories.employees.recordFailedLogin(uid, policy),
        repositories.employees.recordFailedLogin(uid, policy),
      ]);
      const after = await scalar('SELECT login_attempts AS n FROM employees WHERE employee_uid = ?', [uid]);
      assert.equal(Number(after[0].n), 2);

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.query('UPDATE employees SET login_attempts = 9 WHERE employee_uid = ?', [uid]);
        await connection.rollback();
      } finally {
        connection.release();
      }
      const rolled = await scalar('SELECT login_attempts AS n FROM employees WHERE employee_uid = ?', [uid]);
      assert.equal(Number(rolled[0].n), 2);
    });

    await t.test('threshold locks, expiry clears, and the counter resets', async () => {
      await scalar('UPDATE employees SET login_attempts = 0, locked_until = NULL WHERE employee_uid = ?', [uid]);
      const policy = { maxAttempts: 2, lockMs: 60_000 };
      await repositories.employees.recordFailedLogin(uid, policy);
      await repositories.employees.recordFailedLogin(uid, policy);
      assert.equal(await repositories.employees.clearLoginAttempts(uid), false);
      await scalar(
        'UPDATE employees SET locked_until = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE employee_uid = ?',
        [uid],
      );
      assert.equal(await repositories.employees.clearLoginAttempts(uid), true);
      const row = await scalar('SELECT login_attempts AS n, locked_until AS lockedUntil FROM employees WHERE employee_uid = ?', [uid]);
      assert.equal(Number(row[0].n), 0);
      assert.equal(row[0].lockedUntil, null);
    });

    await t.test('logout revocation survives a new process and a second process', async () => {
      const app = createApp({
        container: {
          config: { ...config, database },
          dataSource: 'mariadb',
          repositories,
        },
      });
      const running = await listen(app);
      let token;
      try {
        const session = await api(running.port, 'POST', '/api/v1/auth/login', {
          body: { email, password: 'valid-pass' },
        });
        assert.equal(session.status, 200, safe(JSON.stringify(session.body)));
        token = session.body.data.accessToken;
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
        assert.equal(typeof payload.jti, 'string');
        const me = await api(running.port, 'GET', '/api/v1/auth/me', { token });
        assert.equal(me.status, 200);
        const loggedOut = await api(running.port, 'POST', '/api/v1/auth/logout', {
          token,
          body: { refreshToken: session.body.data.refreshToken },
        });
        assert.equal(loggedOut.status, 200);
        const replay = await api(running.port, 'GET', '/api/v1/auth/me', { token });
        assert.equal(replay.status, 401);
        assert.equal(replay.body.error.code, 'ACCESS_TOKEN_REVOKED');

        const child = spawnSync(process.execPath, ['-e', `
          const mysql = require('mysql2/promise');
          (async () => {
            const pool = mysql.createPool({
              host: process.env.DB_HOST,
              port: Number(process.env.DB_PORT),
              database: process.env.DB_NAME,
              user: process.env.DB_USER,
              password: process.env.DB_PASSWORD,
              timezone: 'Z',
            });
            if (process.env.DB_NAME !== 'attendance_security_main_test') process.exit(2);
            const [rows] = await pool.query('SELECT jti FROM revoked_access_tokens WHERE jti = ?', [process.env.CHECK_JTI]);
            console.log(rows.length === 1 ? 'REVOKED' : 'ABSENT');
            await pool.end();
          })().catch((error) => { console.error(error.code || 'ERR'); process.exit(1); });
        `], {
          cwd: backendRoot,
          env: { ...process.env, CHECK_JTI: payload.jti },
          encoding: 'utf8',
        });
        assert.equal(child.status, 0, safe(child.stderr));
        assert.equal(child.stdout.trim(), 'REVOKED');
      } finally {
        await close(running.server);
      }
    });

    await t.test('a missing revocation table fails closed', async () => {
      const up = fs.readFileSync(path.join(repoRoot, 'database', 'migrations', '025_revoked_access_tokens.sql'), 'utf8');
      await pool.query('DROP TABLE revoked_access_tokens');
      const app = createApp({
        container: {
          config: { ...config, database },
          dataSource: 'mariadb',
          repositories,
        },
      });
      const running = await listen(app);
      try {
        const session = await api(running.port, 'POST', '/api/v1/auth/login', {
          body: { email, password: 'valid-pass' },
        });
        assert.equal(session.status, 200, safe(JSON.stringify(session.body)));
        const denied = await api(running.port, 'GET', '/api/v1/auth/me', { token: session.body.data.accessToken });
        assert.equal(denied.status, 503);
        assert.equal(denied.body.error.code, 'REVOCATION_STORE_UNAVAILABLE');
      } finally {
        await pool.query(up);
        await close(running.server);
      }
    });
  } finally {
    await scalar('DELETE FROM refresh_tokens WHERE employee_uid = ?', [uid]).catch(() => {});
    await scalar('DELETE FROM employees WHERE employee_uid = ?', [uid]).catch(() => {});
    await pool.end();
    await closePool();
  }
});
