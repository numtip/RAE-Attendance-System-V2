const express = require('express');
const { createContainer } = require('./container');
const { createV1Router } = require('./api/v1');
const { notFound } = require('./middleware/notFound');
const { errorHandler } = require('./middleware/errorHandler');

function createApp(options = {}) {
  const container = options.container || createContainer(options);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1', createV1Router(container));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
