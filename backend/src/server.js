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
    const message = `${error.code || 'STARTUP_ERROR'} ${error.message || ''}`.trim();
    console.error(`startup failed: ${message}`);
    if (/JWT_SECRET_(MISSING|PLACEHOLDER|TOO_SHORT)/.test(message)) {
      console.error(
        'startup hint: set JWT_SECRET to a random value of at least 16 characters '
        + '(for example: openssl rand -base64 32). Do not use a repository placeholder.',
      );
    }
    process.exit(1);
  }
}

module.exports = { start };
