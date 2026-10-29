const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const jwt = require('jsonwebtoken');

const enabled = process.env.RUN_SECURITY_MARIADB === '1';
const backendRoot = path.resolve(path.dirname(require.resolve('../src/app.js')), '..');
const repoRoot = path.join(backendRoot, '..');

function safe(text) {
  const secret = process.env.DB_PASSWORD || '';
  return String(text || '').split(secret).join('[redacted]');
}

test('final MariaDB security QA', { skip: enabled ? false : 'RUN_SECURITY_MARIADB is not set' }, async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'ci-fixture-only-secret';
  const database = {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    name: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  };
  assert.equal(database.name, 'attendance_security_main_test');
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
    connectionLimit: 20,
    timezone: 'Z',
    // Same reason as securitySlice.mariadb.integration.test.js: rollback files are
    // multi-statement and scripts/migrate.mjs runs them with this flag (:143).
    multipleStatements: true,
  });
  const repositories = createMariaDbRepositories(database);
  const passwordHash = bcrypt.hashSync('valid-pass', 8);
  const uid = '55555555-5555-5555-5555-555555555555';
  const otherUid = '66666666-6666-6666-6666-666666666666';
  const email = 'final.qa@example.test';
  const otherEmail = 'final.other@example.test';

  function listen(app) {
    const server = http.createServer(app);
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
  }
  const close = (server) => new Promise((resolve) => server.close(resolve));
  async function api(port, method, route, { token, body } = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) : null };
  }
  const app = createApp({
    container: {
      config: { ...config, database },
      dataSource: 'mariadb',
      repositories,
      lockout: { maxAttempts: 10, lockMs: 60_000 },
    },
  });

  async function insert(id, address, code) {
    await pool.query('DELETE FROM refresh_tokens WHERE employee_uid = ?', [id]);
    await pool.query('DELETE FROM employees WHERE employee_uid = ?', [id]);
    await pool.query(
      `INSERT INTO employees (
         employee_uid, employee_id, first_name_th, last_name_th, email, password_hash,
         department, employee_type, status, role, login_attempts, created_at, updated_at
       ) VALUES (?, ?, 'ทดสอบ', 'ระบบ', ?, ?, 'สำนักงาน', 'university', 'active', 'user', 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [id, code, address, passwordHash],
    );
  }

  const running = await listen(app);
  try {
    const [identity] = await pool.query('SELECT VERSION() AS version, DATABASE() AS db');
    assert.match(identity[0].version, /^10\.11\.14/);
    assert.equal(identity[0].db, 'attendance_security_main_test');
    await insert(uid, email, 'E-FINAL');
    await insert(otherUid, otherEmail, 'E-OTHER');

    const burst = await Promise.all(Array.from({ length: 15 }, () => api(running.port, 'POST', '/api/v1/auth/login', {
      body: { email, password: 'wrong-pass' },
    })));
    assert.equal(burst.every((row) => row.status === 401 && row.body.error.code === 'INVALID_CREDENTIALS'), true);
    assert.equal(burst.some((row) => row.text.includes('passwordHash') || row.text.includes('wrong-pass')), false);
    const [counted] = await pool.query('SELECT login_attempts AS n, locked_until AS lockedUntil FROM employees WHERE employee_uid = ?', [uid]);
    assert.equal(Number(counted[0].n), 10);
    assert.ok(counted[0].lockedUntil);
    const locked = await api(running.port, 'POST', '/api/v1/auth/login', {
      body: { email, password: 'valid-pass' },
    });
    assert.equal(locked.status, 403);
    assert.equal(locked.body.error.code, 'ACCOUNT_LOCKED');

    await pool.query('UPDATE employees SET locked_until = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE employee_uid = ?', [uid]);
    const opened = await api(running.port, 'POST', '/api/v1/auth/login', {
      body: { email, password: 'valid-pass' },
    });
    assert.equal(opened.status, 200, safe(opened.text));
    const [reset] = await pool.query('SELECT login_attempts AS n, locked_until AS lockedUntil FROM employees WHERE employee_uid = ?', [uid]);
    assert.equal(Number(reset[0].n), 0);
    assert.equal(reset[0].lockedUntil, null);

    await pool.query('UPDATE employees SET login_attempts = 0, locked_until = NULL WHERE employee_uid = ?', [uid]);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('UPDATE employees SET login_attempts = 40 WHERE employee_uid = ?', [uid]);
      await connection.rollback();
    } finally {
      connection.release();
    }
    const [rolled] = await pool.query('SELECT login_attempts AS n FROM employees WHERE employee_uid = ?', [uid]);
    assert.equal(Number(rolled[0].n), 0);

    const mixed = await Promise.all([
      api(running.port, 'POST', '/api/v1/auth/login', { body: { email, password: 'valid-pass' } }),
      ...Array.from({ length: 8 }, () => api(running.port, 'POST', '/api/v1/auth/login', {
        body: { email, password: 'wrong-pass' },
      })),
    ]);
    const succeeded = mixed.filter((row) => row.status === 200);
    const rejected = mixed.filter((row) => row.status === 401);
    assert.equal(succeeded.length + rejected.length, mixed.length);
    assert.equal(mixed.some((row) => row.text.includes('passwordHash') || row.text.includes(passwordHash)), false);
    if (succeeded.length === 1) {
      const me = await api(running.port, 'GET', '/api/v1/auth/me', { token: succeeded[0].body.data.accessToken });
      assert.equal(me.status, 200);
      assert.equal(me.text.includes('passwordHash'), false);
    }

    const session = succeeded[0] || opened;
    const token = session.body.data.accessToken;
    const refreshToken = session.body.data.refreshToken;
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    const anonymous = await api(running.port, 'GET', '/api/v1/auth/me');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error.code, 'UNAUTHORIZED');
    const other = await api(running.port, 'POST', '/api/v1/auth/login', {
      body: { email: otherEmail, password: 'valid-pass' },
    });
    assert.equal(other.status, 200, safe(other.text));
    const crossed = await api(running.port, 'POST', '/api/v1/auth/logout', {
      token,
      body: { refreshToken: other.body.data.refreshToken },
    });
    assert.equal(crossed.status, 401);
    assert.equal(crossed.body.error.code, 'INVALID_REFRESH_TOKEN');
    const otherStill = await api(running.port, 'POST', '/api/v1/auth/refresh', {
      body: { refreshToken: other.body.data.refreshToken },
    });
    assert.equal(otherStill.status, 200);

    const logouts = await Promise.all([
      api(running.port, 'POST', '/api/v1/auth/logout', { token, body: { refreshToken } }),
      api(running.port, 'POST', '/api/v1/auth/logout', { token, body: { refreshToken } }),
    ]);
    assert.equal(logouts.every((row) => row.status === 200 || row.status === 401), true);
    const replay = await api(running.port, 'GET', '/api/v1/auth/me', { token });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, 'ACCESS_TOKEN_REVOKED');

    const child = spawnSync(process.execPath, ['-e', `
      const mysql = require('mysql2/promise');
      (async () => {
        const pool = mysql.createPool({
          host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
          database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
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

    const expired = jwt.sign(
      { role: 'user', email, authMethod: 'password' },
      process.env.JWT_SECRET,
      { subject: uid, algorithm: 'HS256', jwtid: '77777777-7777-7777-7777-777777777777', expiresIn: -10 },
    );
    const stale = await api(running.port, 'GET', '/api/v1/auth/me', { token: expired });
    assert.equal(stale.status, 401);
    assert.equal(stale.body.error.code, 'UNAUTHORIZED');

    const fresh = await api(running.port, 'POST', '/api/v1/auth/login', {
      body: { email, password: 'valid-pass' },
    });
    assert.equal(fresh.status, 200, safe(fresh.text));
    const rotated = await api(running.port, 'POST', '/api/v1/auth/refresh', {
      body: { refreshToken: fresh.body.data.refreshToken },
    });
    assert.equal(rotated.status, 200);
    const [stored] = await pool.query(
      `SELECT token, token_hash AS tokenHash FROM refresh_tokens
       WHERE employee_uid = ? AND revoked_at IS NULL`,
      [uid],
    );
    assert.ok(stored.length >= 1);
    assert.equal(stored.every((row) => row.token == null && /^[a-f0-9]{64}$/.test(row.tokenHash)), true);
    assert.equal(stored.some((row) => String(row.tokenHash).includes(rotated.body.data.refreshToken)), false);

    const concurrent = await Promise.all([
      api(running.port, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: rotated.body.data.refreshToken } }),
      api(running.port, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: rotated.body.data.refreshToken } }),
    ]);
    const winners = concurrent.filter((row) => row.status === 200);
    assert.equal(winners.length, 1);
    assert.equal(concurrent.filter((row) => row.status === 401).length, 1);
    const stillValid = await api(running.port, 'POST', '/api/v1/auth/refresh', {
      body: { refreshToken: winners[0].body.data.refreshToken },
    });
    assert.equal(stillValid.status, 200, safe(stillValid.text));
    const reused = await api(running.port, 'POST', '/api/v1/auth/refresh', {
      body: { refreshToken: rotated.body.data.refreshToken },
    });
    assert.equal(reused.status, 401);
    assert.equal(reused.body.error.code, 'INVALID_REFRESH_TOKEN');
    const successor = await api(running.port, 'POST', '/api/v1/auth/refresh', {
      body: { refreshToken: stillValid.body.data.refreshToken },
    });
    assert.equal(successor.status, 401);
    assert.equal(successor.body.error.code, 'INVALID_REFRESH_TOKEN');

    await pool.query(
      `INSERT INTO refresh_tokens (employee_uid, token, expires_at, created_at, revoked_at)
       VALUES (?, 'legacy-plain-token', DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY), UTC_TIMESTAMP(), NULL)`,
      [uid],
    );
    const legacy = await api(running.port, 'POST', '/api/v1/auth/refresh', {
      body: { refreshToken: 'legacy-plain-token' },
    });
    assert.equal(legacy.status, 200, safe(legacy.text));
    const [legacyRow] = await pool.query(
      `SELECT token FROM refresh_tokens WHERE employee_uid = ? AND token = 'legacy-plain-token'`,
      [uid],
    );
    assert.equal(legacyRow[0].token, 'legacy-plain-token');

    await pool.query('RENAME TABLE refresh_tokens TO refresh_tokens_hidden');
    try {
      const unavailable = await api(running.port, 'POST', '/api/v1/auth/refresh', {
        body: { refreshToken: legacy.body.data.refreshToken },
      });
      assert.equal(unavailable.status, 503);
      assert.equal(unavailable.body.error.code, 'REFRESH_STORE_UNAVAILABLE');
    } finally {
      await pool.query('RENAME TABLE refresh_tokens_hidden TO refresh_tokens');
    }

    const raced = await api(running.port, 'POST', '/api/v1/auth/login', {
      body: { email, password: 'valid-pass' },
    });
    assert.equal(raced.status, 200, safe(raced.text));
    const [before] = await pool.query(
      'SELECT COUNT(*) AS n FROM refresh_tokens WHERE employee_uid = ? AND revoked_at IS NULL',
      [uid],
    );
    const childSource = `
      const http = require('node:http');
      const body = JSON.stringify({ refreshToken: process.env.REFRESH_TOKEN });
      const req = http.request({
        hostname: '127.0.0.1', port: Number(process.env.APP_PORT), path: '/api/v1/auth/refresh', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          let refreshToken = null;
          try { refreshToken = JSON.parse(text)?.data?.refreshToken ?? null; } catch { refreshToken = null; }
          process.stdout.write(JSON.stringify({ status: res.statusCode, refreshToken }));
          process.exit(0);
        });
      });
      req.on('error', () => process.exit(1));
      req.end(body);
    `;
    function refreshFromNewProcess(refreshToken) {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, ['-e', childSource], {
          cwd: backendRoot,
          env: { ...process.env, REFRESH_TOKEN: refreshToken, APP_PORT: String(running.port) },
        });
        let out = '';
        child.stdout.on('data', (chunk) => { out += chunk; });
        child.on('close', (code) => {
          let parsed = null;
          try { parsed = JSON.parse(out.trim()); } catch { parsed = null; }
          resolve({ code, status: parsed ? String(parsed.status) : '', refreshToken: parsed?.refreshToken ?? null });
        });
      });
    }
    const pair = await Promise.all([
      refreshFromNewProcess(raced.body.data.refreshToken),
      refreshFromNewProcess(raced.body.data.refreshToken),
    ]);
    assert.equal(pair.filter((row) => row.status === '200').length, 1);
    assert.equal(pair.filter((row) => row.status === '401').length, 1);
    const [afterRace] = await pool.query(
      'SELECT COUNT(*) AS n FROM refresh_tokens WHERE employee_uid = ? AND revoked_at IS NULL',
      [uid],
    );
    // TWO CONCURRENT USES OF ONE REFRESH TOKEN ARE, BY DEFINITION, A REUSE — and reuse detection revokes the
    // whole family. So the live count after the race may legitimately DROP (the loser's 401 revokes the family,
    // including the token the winner was just issued) and may stay the same when the loser's request arrives
    // before the winner commits. Asserting equality encoded one of those two orderings and failed ~half the
    // time (`finalqa.mariadb.test.js:329`, expected 3, actual 2 — measured 3/6 locally and in CI). The
    // invariants that hold in every ordering: exactly one success, exactly one rejection (above), and no
    // extra live tokens minted by the race.
    assert.ok(
      Number(afterRace[0].n) <= Number(before[0].n),
      `a race must not mint live tokens (before ${before[0].n}, after ${afterRace[0].n})`,
    );
    const again = await refreshFromNewProcess(raced.body.data.refreshToken);
    assert.equal(again.status, '401');
    // REUSE DETECTION REVOKES THE WHOLE FAMILY, so the exact number of rows that disappear depends on how
    // many tokens the race left live — asserting `before - 1` encoded an accident of the race and failed
    // roughly half the time (`finalqa.mariadb.test.js:319`, expected 3, actual 2). The property that matters
    // is measured instead: the successor the winning child received must no longer be usable.
    const winner = pair.find((row) => row.status === '200');
    assert.ok(winner?.refreshToken, 'the winning rotation must return a token');
    const afterSuccessor = await refreshFromNewProcess(winner.refreshToken);
    assert.equal(afterSuccessor.status, '401');
    const [afterReuse] = await pool.query(
      'SELECT COUNT(*) AS n FROM refresh_tokens WHERE employee_uid = ? AND revoked_at IS NULL',
      [uid],
    );
    // Family revocation removes at least the reused token's whole family; it must never leave the count
    // unchanged, and it must never go negative.
    assert.ok(
      Number(afterReuse[0].n) < Number(before[0].n),
      `reuse detection must revoke live tokens (before ${before[0].n}, after ${afterReuse[0].n})`,
    );

    const [familyIndexes] = await pool.query(
      `SELECT DISTINCT index_name AS name FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = 'refresh_tokens'
         AND index_name IN ('uk_refresh_tokens_token_hash', 'idx_refresh_tokens_family_id')
       ORDER BY index_name`,
    );
    assert.deepEqual(familyIndexes.map((row) => row.name), ['idx_refresh_tokens_family_id', 'uk_refresh_tokens_token_hash']);

    const [indexes] = await pool.query(
      `SELECT index_name AS name, non_unique AS nonUnique
       FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = 'revoked_access_tokens'
       ORDER BY index_name, seq_in_index`,
    );
    assert.deepEqual(indexes.map((row) => row.name), ['idx_revoked_access_tokens_expires_at', 'PRIMARY']);
    const down = fs.readFileSync(path.join(repoRoot, 'database', 'rollbacks', '025_revoked_access_tokens.down.sql'), 'utf8');
    const up = fs.readFileSync(path.join(repoRoot, 'database', 'migrations', '025_revoked_access_tokens.sql'), 'utf8');
    await pool.query(down);
    const [missing] = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'revoked_access_tokens'`,
    );
    assert.equal(Number(missing[0].n), 0);
    const outage = await api(running.port, 'GET', '/api/v1/auth/me', { token: rotated.body.data.accessToken });
    assert.equal(outage.status, 503);
    assert.equal(outage.body.error.code, 'REVOCATION_STORE_UNAVAILABLE');
    await pool.query(up);
    await pool.query(
      `INSERT INTO schema_migrations (version)
       SELECT '025_revoked_access_tokens.sql' FROM DUAL
       WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '025_revoked_access_tokens.sql')`,
    );
  } finally {
    await pool.query('DELETE FROM refresh_tokens WHERE employee_uid IN (?, ?)', [uid, otherUid]).catch(() => {});
    await pool.query('DELETE FROM revoked_access_tokens').catch(() => {});
    await pool.query('DELETE FROM employees WHERE employee_uid IN (?, ?)', [uid, otherUid]).catch(() => {});
    await close(running.server);
    await pool.end();
    await closePool();
  }
});
