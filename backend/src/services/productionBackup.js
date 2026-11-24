const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { createGzip } = require('node:zlib');
const { randomUUID } = require('node:crypto');
const { HttpError } = require('../utils/httpError');

// The directory must be a private persistent volume configured by the deploy operator.
// Failure to make a complete dump must prevent the first application write.
async function backupBeforeWrite(container) {
  if (container.config.app.env !== 'production') return;
  const dir = process.env.ATTENDANCE_BACKUP_DIR;
  const db = container.config.database;
  if (!dir || !path.isAbsolute(dir) || !db.host || !db.name || !db.user) {
    throw new HttpError(503, 'BACKUP_UNAVAILABLE', 'Production backup is not configured');
  }
  const info = await fs.promises.stat(dir).catch(() => null);
  if (!info?.isDirectory() || (info.mode & 0o077) !== 0) {
    throw new HttpError(503, 'BACKUP_UNAVAILABLE', 'Production backup directory must be private');
  }
  const file = path.join(dir, `attendance-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.sql.gz`);
  const child = spawn('mariadb-dump', ['--single-transaction', '--quick', '--skip-lock-tables',
    '--host', db.host, '--port', String(db.port), '--user', db.user, '--', db.name], {
    env: { PATH: process.env.PATH, MYSQL_PWD: db.password }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error('dump failed')));
  });
  try {
    await Promise.all([pipeline(child.stdout, createGzip(), fs.createWriteStream(file, { flags: 'wx', mode: 0o600 })), completed]);
    const stat = await fs.promises.stat(file);
    if (stat.size < 100) throw new Error('dump is empty');
  } catch {
    child.kill();
    await fs.promises.unlink(file).catch(() => {});
    throw new HttpError(503, 'BACKUP_UNAVAILABLE', 'Production backup failed');
  }
}
module.exports = { backupBeforeWrite };
