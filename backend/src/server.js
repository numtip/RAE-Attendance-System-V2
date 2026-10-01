const { createApp } = require('./app');
const config = require('./config');

function start(port = config.app.port) {
  const app = createApp();
  const server = app.listen(port, '127.0.0.1');
  server.on('listening', () => {
    console.log(`${config.app.name} listening on 127.0.0.1:${port}`);
  });
  return server;
}

if (require.main === module) {
  start();
}

module.exports = { start };
