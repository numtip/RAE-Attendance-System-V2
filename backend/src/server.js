const { createApp } = require('./app');
const config = require('./config');

function start(port = config.app.port) {
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
  start();
}

module.exports = { start };
