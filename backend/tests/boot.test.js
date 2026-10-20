const assert = require('node:assert/strict');
const test = require('node:test');

process.env.JWT_SECRET = 'test-only-secret';
process.env.DATA_SOURCE = 'fixture';
// Explicit: the suite must not inherit NODE_ENV=production from an outer shell,
// because start() would then correctly reject a fixture data source.
process.env.NODE_ENV = 'test';

const { start } = require('../src/server');

test('backend boots and health contract responds', async () => {
  const server = start(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.status, 'healthy');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
