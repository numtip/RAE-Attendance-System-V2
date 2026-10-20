const { createApp } = require('./app');
const config = require('./config');
const { assertRuntimeConfig } = require('./config/validate');

function start(port = config.app.port) {
  // Fail closed before listening: a container must never report healthy while
  // its configuration is unusable in production.
  assertRuntimeConfig(config);
  const host = process.env.HOST || '127.0.0.1';
  const app = createApp();
  const server = app.listen(port, host);
  server.on('listening', () => {
    const bound = server.address();
    const label = typeof bound === 'object' && bound ? `${host}:${bound.port}` : `${host}:${port}`;
    console.log(`${config.app.name} listening on ${label}`);
  });
  return server;
}

if (require.main === module) {
  try {
    start();
  } catch (error) {
    // Codes only: never echo configuration values.
    console.error(`startup failed: ${error.code || 'STARTUP_ERROR'} ${error.message || ''}`.trim());
    process.exit(1);
  }
}

module.exports = { start };
