/**
 * Migration 017 privilege / binary-log compatibility on DISPOSABLE MariaDB servers started WITH binary logging
 * (log_bin_trust_function_creators=0). Opt-in: RAE_QA_BINLOG_PORTS, loopback only, rae_qa_* databases and
 * qa_* users that the test creates and drops itself. It only changes server settings on the disposable
 * instance and restores them. All identifiers are synthetic.
 */
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const mysql = require('mysql2/promise');

const ports = (process.env.RAE_QA_BINLOG_PORTS || '').split(',').map((p) => Number(p.trim())).filter(Boolean);
const host = process.env.RAE_QA_DB_HOST || '127.0.0.1';
const rootUser = process.env.RAE_QA_DB_USER || 'root';
const rootPassword = process.env.RAE_QA_DB_PASSWORD || '';
const skip = ports.length === 0 || !['127.0.0.1', 'localhost', '::1'].includes(host);
const dbRoot = path.resolve(path.dirname(require.resolve('../package.json')), '..', 'database');
const migrationsDir = path.join(dbRoot, 'migrations');
const M017 = '017_identifier_namespace_claim.sql';
const sql017 = () => fs.readFileSync(path.join(migrationsDir, M017), 'utf8');
const USER_PASSWORD = 'qa_synthetic_pw_1';
const triggerCountSql = (db) => `SELECT COUNT(*) c FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='${db}' AND TRIGGER_NAME LIKE 'trg_employee_identifier_ns_%'`;

const connect = (port, options = {}) => mysql.createConnection({ host, port, multipleStatements: true, ...options });

async function withServer(port, fn) {
  const admin = await connect(port, { user: rootUser, password: rootPassword });
  const db = `rae_qa_${randomBytes(4).toString('hex')}`;
  const users = [];
  const makeUser = async (name, grants, global = null) => {
    const full = `qa_${name}_${randomBytes(3).toString('hex')}`;
    users.push(full);
    await admin.query(`CREATE USER '${full}'@'%' IDENTIFIED BY '${USER_PASSWORD}'`);
    if (grants) await admin.query(`GRANT ${grants} ON \`${db}\`.* TO '${full}'@'%'`);
    if (global) await admin.query(`GRANT ${global} ON *.* TO '${full}'@'%'`);
    return full;
  };
  const as = (user) => connect(port, { user, password: USER_PASSWORD, database: db });
  const [[initial]] = await admin.query('SELECT @@log_bin_trust_function_creators AS trust');
  await admin.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4`);
  const setup = await connect(port, { user: rootUser, password: rootPassword, database: db });
  try {
    for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql') && f < M017).sort()) {
      await setup.query(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
    }
    await setup.query(
      `INSERT INTO employees (employee_uid, employee_id, first_name_th, last_name_th, email, department, employee_type, status, created_at, updated_at)
       VALUES ('emp-1','QA-1','ทดสอบ','หนึ่ง','e1@example.test','QA','contract','active',NOW(),NOW()),
              ('emp-2','QA-2','ทดสอบ','สอง','e2@example.test','QA','contract','active',NOW(),NOW())`,
    );
    await fn({ admin, setup, db, makeUser, as });
  } finally {
    await setup.end();
    await admin.query(`SET GLOBAL log_bin_trust_function_creators=${Number(initial.trust)}`);
    await admin.query(`DROP DATABASE IF EXISTS \`${db}\``);
    for (const user of users) await admin.query(`DROP USER IF EXISTS '${user}'@'%'`);
    await admin.end();
  }
}

const insertIdentifier = (conn, uid, type, value) => conn.query(
  `INSERT INTO employee_identifier (employee_uid, id_type, id_value, source_system, status, created_at, updated_at)
   VALUES (?, ?, ?, 'qa', 'active', NOW(), NOW())`,
  [uid, type, value],
);
const triggers = async (admin, db) => Number((await admin.query(triggerCountSql(db)))[0][0].c);

for (const port of ports) {
  const label = `MariaDB(binlog):${port}`;

  test(`${label} server really runs with binary logging and log_bin_trust_function_creators=0`, { skip }, async () => {
    await withServer(port, async ({ admin }) => {
      await admin.query('SET GLOBAL log_bin_trust_function_creators=0');
      const [[row]] = await admin.query('SELECT @@log_bin AS lb, @@log_bin_trust_function_creators AS trust, @@binlog_format AS fmt');
      assert.equal(Number(row.lb), 1);
      assert.equal(Number(row.trust), 0);
    });
  });

  test(`${label} 017: TRIGGER privilege alone is NOT enough under binlog (error 1419); failure leaves no triggers, writes keep working, rerun after the DBA decision succeeds`, { skip }, async () => {
    await withServer(port, async ({ admin, setup, db, makeUser, as }) => {
      await admin.query('SET GLOBAL log_bin_trust_function_creators=0');
      const migrator = await makeUser('mig', 'SELECT,INSERT,UPDATE,DELETE,CREATE,ALTER,DROP,INDEX,REFERENCES,TRIGGER');
      const conn = await as(migrator);
      try {
        // preflight reports the situation before anything is attempted
        const [pre] = await setup.query(fs.readFileSync(path.join(dbRoot, 'preflight', '017_preflight.sql'), 'utf8'));
        const row = (Array.isArray(pre[0]) ? pre[0] : pre)[0];
        assert.equal(Number(row.binlog_enabled), 1);
        assert.equal(Number(row.log_bin_trust_function_creators), 0);
        assert.equal(Number(row.cross_employee_namespace_collisions), 0);

        await assert.rejects(() => conn.query(sql017()), (e) => e.errno === 1419 && /SUPER/.test(e.message));
        assert.equal(await triggers(admin, db), 0, 'no partial trigger set remains');
        // the application is not broken by the failed attempt
        await insertIdentifier(setup, 'emp-1', 'facescan_id', '7001');

        // DBA decision on the disposable server only: trust function creators, then the same user succeeds
        await admin.query('SET GLOBAL log_bin_trust_function_creators=1');
        await conn.query(sql017());
        assert.equal(await triggers(admin, db), 3);
        await assert.rejects(() => insertIdentifier(setup, 'emp-2', 'personnel_id', '7001'), (e) => e.sqlState === '45000' && /IDENTIFIER_NAMESPACE_COLLISION/.test(e.sqlMessage));
        // the pre-existing identifier written before the migration was backfilled into the claim table
        const [[claim]] = await setup.query("SELECT employee_uid FROM employee_identifier_namespace_claim WHERE claim_value='7001'");
        assert.equal(claim.employee_uid, 'emp-1');
        await conn.query(sql017()); // idempotent rerun under binlog
        assert.equal(await triggers(admin, db), 3);
      } finally {
        await conn.end();
      }
    });
  });

  test(`${label} 017: an account holding SUPER applies it with binlog on and trust=0 (no server setting changed)`, { skip }, async () => {
    await withServer(port, async ({ admin, db, makeUser, as }) => {
      await admin.query('SET GLOBAL log_bin_trust_function_creators=0');
      const dba = await makeUser('dba', 'ALL PRIVILEGES', 'SUPER');
      const conn = await as(dba);
      try {
        await conn.query(sql017());
        assert.equal(await triggers(admin, db), 3);
        const [[row]] = await admin.query('SELECT @@log_bin_trust_function_creators AS trust');
        assert.equal(Number(row.trust), 0, 'the migration never changes server variables');
      } finally {
        await conn.end();
      }
    });
  });

  test(`${label} 017: without the TRIGGER privilege it fails (1142) leaving nothing active, and succeeds after the grant`, { skip }, async () => {
    await withServer(port, async ({ admin, db, makeUser, as }) => {
      await admin.query('SET GLOBAL log_bin_trust_function_creators=1');
      const migrator = await makeUser('notrig', 'SELECT,INSERT,UPDATE,DELETE,CREATE,ALTER,DROP,INDEX,REFERENCES');
      const conn = await as(migrator);
      try {
        await assert.rejects(() => conn.query(sql017()), (e) => e.errno === 1142 && /TRIGGER/i.test(e.message));
        assert.equal(await triggers(admin, db), 0);
        await admin.query(`GRANT TRIGGER ON \`${db}\`.* TO '${migrator}'@'%'`);
        const again = await as(migrator);
        try {
          await again.query(sql017());
        } finally {
          await again.end();
        }
        assert.equal(await triggers(admin, db), 3);
      } finally {
        await conn.end();
      }
    });
  });

  test(`${label} 017 runtime: the application account needs no privilege on the claim table; collisions are refused for it; dropping the DEFINER breaks writes (documented risk)`, { skip }, async () => {
    await withServer(port, async ({ admin, db, makeUser, as }) => {
      await admin.query('SET GLOBAL log_bin_trust_function_creators=1');
      const migrator = await makeUser('definer', 'ALL PRIVILEGES');
      // Least privilege: table-level grants only, nothing on the claim table.
      const app = await makeUser('app', null);
      await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON \`${db}\`.employee_identifier TO '${app}'@'%'`);
      const mig = await as(migrator);
      try {
        await mig.query(sql017());
      } finally {
        await mig.end();
      }
      const appConn = await as(app);
      try {
        await insertIdentifier(appConn, 'emp-1', 'facescan_id', '7101');
        await assert.rejects(() => insertIdentifier(appConn, 'emp-2', 'personnel_id', '7101'), (e) => e.sqlState === '45000');
        await insertIdentifier(appConn, 'emp-2', 'personnel_id', '7102');
        // the app account cannot read or tamper with the claim table directly
        await assert.rejects(() => appConn.query('SELECT * FROM employee_identifier_namespace_claim'), (e) => e.errno === 1142);
        await assert.rejects(() => appConn.query("DELETE FROM employee_identifier_namespace_claim WHERE claim_value='7101'"), (e) => e.errno === 1142);

        // Operational risk: triggers run as their DEFINER. Removing the migration account breaks identifier writes.
        await admin.query(`DROP USER '${migrator}'@'%'`);
        await assert.rejects(() => insertIdentifier(appConn, 'emp-1', 'facescan_id', '7103'), (e) => e.errno === 1449);
        // Recovery: recreate the definer (or re-run the migration as a stable service account) restores writes.
        await admin.query(`CREATE USER '${migrator}'@'%' IDENTIFIED BY '${USER_PASSWORD}'`);
        await admin.query(`GRANT ALL PRIVILEGES ON \`${db}\`.* TO '${migrator}'@'%'`);
        await insertIdentifier(appConn, 'emp-1', 'facescan_id', '7103');
      } finally {
        await appConn.end();
      }
    });
  });
}
