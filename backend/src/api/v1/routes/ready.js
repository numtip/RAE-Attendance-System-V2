const express = require('express');
const config = require('../../../config');
const { validateRuntimeConfig } = require('../../../config/validate');
const { getPool, isDatabaseConfigured } = require('../../../db/pool');
const { asyncRoute } = require('../../../utils/asyncRoute');
const { failure, success } = require('../../../utils/response');

const router = express.Router();

/**
 * Readiness gate for staging. Deliberately reports no host, database name,
 * driver, credential or version information.
 *
 * - 503 CONFIG_INVALID when the runtime configuration cannot serve requests.
 * - 503 DB_UNAVAILABLE when MariaDB is configured but unreachable.
 * - 200 with checked subsystems only.
 */
router.get('/', asyncRoute(async (_req, res) => {
  const dataSource = process.env.DATA_SOURCE || 'fixture';
  const validation = validateRuntimeConfig(config, { env: process.env, dataSource });
  if (!validation.ok) {
    const codes = validation.errors.map((error) => error.code).join(', ');
    failure(res, 503, 'CONFIG_INVALID', `Runtime configuration is invalid: ${codes}`);
    return;
  }

  if (!isDatabaseConfigured()) {
    success(res, { status: 'ready', checks: { config: 'ok', database: 'not_required' } }, 'Service is ready');
    return;
  }

  try {
    const pool = getPool();
    await pool.query('SELECT 1 AS ok');
  } catch {
    failure(res, 503, 'DB_UNAVAILABLE', 'Database is not reachable');
    return;
  }

  success(res, { status: 'ready', checks: { config: 'ok', database: 'connected' } }, 'Service is ready');
}));

module.exports = router;
