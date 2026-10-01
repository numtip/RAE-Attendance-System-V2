const express = require('express');
const config = require('../../../config');
const { getPool, isDatabaseConfigured } = require('../../../db/pool');
const { asyncRoute } = require('../../../utils/asyncRoute');
const { failure, success } = require('../../../utils/response');

const router = express.Router();

router.get('/', (_req, res) => {
  success(res, {
    status: 'healthy',
    service: 'rae-attendance-v2',
    version: '0.1.0',
  }, 'API is running');
});

router.get('/db', asyncRoute(async (_req, res) => {
  if (!isDatabaseConfigured()) {
    success(res, {
      status: 'unconfigured',
      database: null,
    }, 'Database env vars are not set');
    return;
  }

  try {
    const pool = getPool();
    await pool.query('SELECT 1 AS ok');
    success(res, {
      status: 'connected',
      database: config.database.name,
      host: config.database.host,
    }, 'Database is reachable');
  } catch (error) {
    failure(res, 503, 'DB_UNAVAILABLE', error.message);
  }
}));

module.exports = router;
