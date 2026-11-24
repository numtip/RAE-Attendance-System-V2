const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { backupBeforeWrite } = require('../src/services/productionBackup');

function container(env) {
  return {
    config: {
      app: { env },
      database: { host: '127.0.0.1', port: 1, name: 'unused', user: 'unused', password: 'unused' },
    },
  };
}

test('a missing backup directory rejects a production write before any dump', async () => {
  const missing = await fs.mkdtemp(path.join(os.tmpdir(), 'rae-backup-missing-'));
  await fs.rm(missing, { recursive: true });
  const previous = process.env.ATTENDANCE_BACKUP_DIR;
  process.env.ATTENDANCE_BACKUP_DIR = missing;
  try {
    await assert.rejects(
      () => backupBeforeWrite(container('production')),
      (error) => error.status === 503 && error.code === 'BACKUP_UNAVAILABLE'
        && error.message === 'Production backup directory must be private',
    );
  } finally {
    if (previous === undefined) delete process.env.ATTENDANCE_BACKUP_DIR;
    else process.env.ATTENDANCE_BACKUP_DIR = previous;
  }
});
