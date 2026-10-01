const express = require('express');
const v1 = require('./api/v1');
const { notFound } = require('./middleware/notFound');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1', v1);
  app.use(notFound);
  return app;
}

module.exports = { createApp };
