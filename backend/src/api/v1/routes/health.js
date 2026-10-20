const express = require('express');
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
    }, 'Database env vars are not set');
    return;
  }

  try {
    const pool = getPool();
    await pool.query('SELECT 1 AS ok');
    // No host or database name: this route is unauthenticated.
    success(res, {
      status: 'connected',
    }, 'Database is reachable');
  } catch {
    // Never echo the driver error: it carries host/port/user detail.
    failure(res, 503, 'DB_UNAVAILABLE', 'Database is not reachable');
  }
}));

module.exports = router;
