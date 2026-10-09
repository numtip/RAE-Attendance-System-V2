const assert = require('node:assert/strict');
const test = require('node:test');
const { HttpError } = require('../src/utils/httpError');
const { createMariaDbCodeReplayStore, digestHex } = require('../src/services/sso/mariadbCodeReplayStore');

function duplicateError() {
  const error = new Error('Duplicate entry');
  error.code = 'ER_DUP_ENTRY';
  error.errno = 1062;
  return error;
}

function memoryPool() {
  const rows = new Map();
  const queries = [];
  return {
    rows,
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.startsWith('DELETE')) {
        return [{ affectedRows: 0 }];
      }
      if (sql.startsWith('INSERT')) {
        const [digest, ttlSeconds] = params;
        if (typeof digest !== 'string' || digest.length !== 64) {
          throw new Error('digest shape');
        }
        if (rows.has(digest)) throw duplicateError();
        rows.set(digest, { ttlSeconds });
        return [{ affectedRows: 1 }];
      }
      const error = new Error('unexpected sql');
      error.code = 'ER_UNEXPECTED';
      throw error;
    },
  };
}

test('replay store: first claim inserts the digest only', async () => {
  const pool = memoryPool();
  const store = createMariaDbCodeReplayStore(pool, { ttlSeconds: 3600 });
  const raw = 'ac-value-not-stored';
  assert.equal(await store.claim(raw), true);
  const insert = pool.queries.find((query) => query.sql.startsWith('INSERT'));
  assert.equal(insert.params[0], digestHex(raw));
  assert.equal(insert.params.includes(raw), false);
  assert.match(insert.sql, /INTERVAL \? SECOND/);
  assert.match(pool.queries[0].sql, /expires_at <= UTC_TIMESTAMP\(3\)/);
  assert.equal(pool.rows.size, 1);
});

test('replay store: concurrent double-use', async () => {
  const pool = memoryPool();
  const store = createMariaDbCodeReplayStore(pool);
  const [first, second] = await Promise.all([store.claim('same-ac'), store.claim('same-ac')]);
  assert.deepEqual([first, second].sort(), [false, true]);
  assert.equal(pool.rows.size, 1);
});

test('replay store: restart keeps the claim', async () => {
  const pool = memoryPool();
  const first = createMariaDbCodeReplayStore(pool);
  assert.equal(await first.claim('again'), true);
  const restarted = createMariaDbCodeReplayStore(pool);
  assert.equal(await restarted.claim('again'), false);
});

test('replay store: two instances share one pool', async () => {
  const pool = memoryPool();
  const left = createMariaDbCodeReplayStore(pool);
  const right = createMariaDbCodeReplayStore(pool);
  assert.equal(await left.claim('shared'), true);
  assert.equal(await right.claim('shared'), false);
});

test('replay store: database error fail-closed', async () => {
  const pool = {
    async query() {
      const error = new Error('down');
      error.code = 'ECONNREFUSED';
      throw error;
    },
  };
  const store = createMariaDbCodeReplayStore(pool);
  await assert.rejects(() => store.claim('ac-1'), (err) => err instanceof HttpError && err.status === 503 && err.code === 'SSO_REPLAY_STORE_UNAVAILABLE');
});
