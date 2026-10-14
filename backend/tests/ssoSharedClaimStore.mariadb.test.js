/* global __dirname */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const mysql = require('mysql2/promise');
const { HttpError } = require('../src/utils/httpError');
const {
  createMariaDbSharedClaimStore,
  SHARED_CLAIM_DDL,
} = require('../src/services/sso/mariadbSharedClaimStore');
const { createOptInSharedStores } = require('../src/services/sso/ssoSharedClaimAdapter');
const { createSsoService } = require('../src/services/ssoService');
const { createMjuPortalGuard } = require('../src/services/sso/mjuPortalGuard');

const host = process.env.SSO_SHARED_DB_HOST || '';
const port = Number(process.env.SSO_SHARED_DB_PORT || 0);
const allowed = process.env.SSO_SHARED_DB_DISPOSABLE === '1'
  && (host === '127.0.0.1' || host === 'localhost')
  && port > 0
  && port !== 3306
  && Boolean(process.env.SSO_SHARED_DB_NAME && process.env.SSO_SHARED_DB_USER && process.env.SSO_SHARED_DB_PASSWORD);

async function poolFor(database) {
  return mysql.createPool({
    host,
    port,
    user: process.env.SSO_SHARED_DB_USER,
    password: process.env.SSO_SHARED_DB_PASSWORD,
    database,
    connectionLimit: 4,
  });
}

test('shared claim store is single-use across two connections and fails closed', { skip: !allowed }, async (t) => {
  const admin = await mysql.createConnection({
    host,
    port,
    user: process.env.SSO_SHARED_DB_USER,
    password: process.env.SSO_SHARED_DB_PASSWORD,
  });
  const database = `sso_shared_${Date.now()}`;
  await admin.query(`CREATE DATABASE \`${database}\``);
  await admin.query(`USE \`${database}\``);
  await admin.query(SHARED_CLAIM_DDL);
  await admin.end();

  const pool = await poolFor(database);
  const other = await poolFor(database);
  t.after(async () => {
    await pool.end();
    await other.end();
    const drop = await mysql.createConnection({
      host,
      port,
      user: process.env.SSO_SHARED_DB_USER,
      password: process.env.SSO_SHARED_DB_PASSWORD,
    });
    await drop.query(`DROP DATABASE \`${database}\``);
    await drop.end();
  });

  const handoff = createMariaDbSharedClaimStore(pool, { kind: 'handoff', ttlSeconds: 45 });
  const handoff2 = createMariaDbSharedClaimStore(other, { kind: 'handoff', ttlSeconds: 45 });
  await handoff.put('synthetic-handoff', { subject: 'synthetic-subject', subjectType: 'candidate:humanID' });
  const peeked = await handoff2.peek('synthetic-handoff');
  assert.equal(peeked.status, 'ok');
  assert.equal(peeked.payload.subject, 'synthetic-subject');
  const [first, second] = await Promise.all([
    handoff.consume('synthetic-handoff'),
    handoff2.consume('synthetic-handoff'),
  ]);
  const wins = [first, second].filter((row) => row.status === 'ok');
  assert.equal(wins.length, 1);
  assert.equal(wins[0].payload.subjectType, 'candidate:humanID');
  assert.equal((await handoff.peek('synthetic-handoff')).status, 'unknown');

  await assert.rejects(
    () => handoff.put('synthetic-handoff', { subject: 'again' }),
    (err) => err instanceof HttpError && err.code === 'SSO_CLAIM_REPLAY',
  );

  const binding = createMariaDbSharedClaimStore(pool, { kind: 'binding', ttlSeconds: 60 });
  await binding.put('synthetic-binding', { bindingDigest: 'abc123' });
  assert.equal((await binding.consume('missing')).status, 'unknown');
  assert.equal((await binding.consume('')).status, 'unknown');

  const short = createMariaDbSharedClaimStore(pool, { kind: 'binding', ttlSeconds: 1 });
  await short.put('synthetic-expired', { bindingDigest: 'expired' });
  await pool.query(
    'UPDATE sso_shared_claim SET expires_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE kind = ?',
    ['binding'],
  );
  assert.equal((await short.peek('synthetic-expired')).status, 'expired');
  assert.equal((await short.consume('synthetic-expired')).status, 'expired');

  const broken = createMariaDbSharedClaimStore(pool, { kind: 'handoff', ttlSeconds: 45 });
  await pool.query('DROP TABLE sso_shared_claim');
  await assert.rejects(
    () => broken.put('after-drop', { subject: 'x' }),
    (err) => err instanceof HttpError && err.code === 'SSO_SHARED_STORE_UNAVAILABLE',
  );
  await assert.rejects(
    () => broken.peek('after-drop'),
    (err) => err instanceof HttpError && err.code === 'SSO_SHARED_STORE_UNAVAILABLE',
  );
});

function consumeInProcess(database, kind, code) {
  const child = spawn(process.execPath, ['-e', `
    const mysql = require('mysql2/promise');
    const { createMariaDbSharedClaimStore } = require(${JSON.stringify(path.join(__dirname, '../src/services/sso/mariadbSharedClaimStore.js'))});
    (async () => {
      const pool = mysql.createPool({
        host: process.env.SSO_SHARED_DB_HOST,
        port: Number(process.env.SSO_SHARED_DB_PORT),
        user: process.env.SSO_SHARED_DB_USER,
        password: process.env.SSO_SHARED_DB_PASSWORD,
        database: process.env.SSO_SHARED_DB_CHILD,
        connectionLimit: 2,
      });
      const store = createMariaDbSharedClaimStore(pool, { kind: process.env.SSO_SHARED_KIND, ttlSeconds: 60 });
      const result = await store.consume(process.env.SSO_SHARED_CODE);
      process.stdout.write(result.status);
      await pool.end();
    })().catch(() => { process.stdout.write('error'); process.exitCode = 1; });
  `], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      SSO_SHARED_DB_CHILD: database,
      SSO_SHARED_KIND: kind,
      SSO_SHARED_CODE: code,
    },
  });
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', reject);
    child.on('close', () => resolve(out));
  });
}

test('two processes consume one binding and one handoff', { skip: !allowed }, async () => {
  const sql = fs.readFileSync(path.join(__dirname, '../../database/migrations/019_sso_shared_claim.sql'), 'utf8');
  const admin = await mysql.createConnection({
    host,
    port,
    user: process.env.SSO_SHARED_DB_USER,
    password: process.env.SSO_SHARED_DB_PASSWORD,
  });
  const database = `sso_proc_${Date.now()}`;
  await admin.query(`CREATE DATABASE \`${database}\``);
  await admin.query(`USE \`${database}\``);
  await admin.query(sql);
  await admin.end();
  const pool = await poolFor(database);
  try {
    const binding = createMariaDbSharedClaimStore(pool, { kind: 'binding', ttlSeconds: 60 });
    const handoff = createMariaDbSharedClaimStore(pool, { kind: 'handoff', ttlSeconds: 60 });
    await binding.put('proc-binding', { bindingDigest: 'synthetic' });
    await handoff.put('proc-handoff', { subject: 'synthetic-subject' });
    const bindingRace = await Promise.all([
      consumeInProcess(database, 'binding', 'proc-binding'),
      consumeInProcess(database, 'binding', 'proc-binding'),
    ]);
    const handoffRace = await Promise.all([
      consumeInProcess(database, 'handoff', 'proc-handoff'),
      consumeInProcess(database, 'handoff', 'proc-handoff'),
    ]);
    assert.deepEqual(bindingRace.filter((status) => status === 'ok').length, 1);
    assert.deepEqual(handoffRace.filter((status) => status === 'ok').length, 1);

    const stores = createOptInSharedStores(pool, { portalGuard: createMjuPortalGuard() });
    const service = createSsoService({
      config: {
        jwt: { secret: 'test-only-secret', expiresIn: '15m', refreshTokenDays: 14 },
        sso: {
          enabled: true,
          callbackConfirmed: true,
          protocolContractConfirmed: true,
          provider: 'mock',
          authorizationUrl: 'https://sso.example.test/oauth/authorize',
          tokenUrl: 'https://sso.example.test/oauth/token',
          userInfoUrl: 'https://sso.example.test/oauth/userinfo',
          clientId: 'synthetic-client',
          clientSecret: 'synthetic-secret',
          callbackUrl: 'https://sso.example.test/callback',
          mjuTokenFlow: false,
        },
      },
      repositories: {},
      stateStore: stores.stateStore,
      loginCodeStore: stores.loginCodeStore,
      identityResolutionService: {
        async issueSessionFromOAuthProfile() {
          throw new HttpError(403, 'IDENTITY_NOT_APPROVED', 'synthetic rejection');
        },
      },
    });
    const code = await service.issueLoginHandoff({
      confirmationRequired: true,
      profile: { synthetic: true },
      rawQuery: {},
      source: 'test',
      subject: 'synthetic-subject',
      subjectType: 'candidate:humanID',
    });
    await assert.rejects(
      () => service.exchangeLoginHandoff({ code, confirm: true }),
      (err) => err instanceof HttpError && err.code === 'IDENTITY_NOT_APPROVED',
    );
    await assert.rejects(
      () => service.exchangeLoginHandoff({ code, confirm: true }),
      (err) => err instanceof HttpError && err.status === 401,
    );
  } finally {
    await pool.end();
    const drop = await mysql.createConnection({
      host,
      port,
      user: process.env.SSO_SHARED_DB_USER,
      password: process.env.SSO_SHARED_DB_PASSWORD,
    });
    await drop.query(`DROP DATABASE \`${database}\``);
    await drop.end();
  }
});
