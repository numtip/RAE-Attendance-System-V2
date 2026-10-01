const mysql = require('mysql2/promise');
const config = require('../config');
const { HttpError } = require('../utils/httpError');

const dbUnavailable = new HttpError(
  503,
  'DB_UNAVAILABLE',
  'MariaDB is not configured. Set DB_HOST, DB_NAME, and DB_USER (and DB_PASSWORD if required).',
);

let pool = null;

function isDatabaseConfigured(database = config.database) {
  return Boolean(database.host && database.name && database.user);
}

function getDbUnavailableError() {
  return dbUnavailable;
}

function getPool(database = config.database) {
  if (!isDatabaseConfigured(database)) {
    throw dbUnavailable;
  }
  if (!pool) {
    pool = mysql.createPool({
      host: database.host,
      port: database.port,
      database: database.name,
      user: database.user,
      password: database.password,
      waitForConnections: true,
      connectionLimit: 10,
      connectTimeout: 10_000,
      timezone: 'Z',
    });
  }
  return pool;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  closePool,
  getDbUnavailableError,
  getPool,
  isDatabaseConfigured,
};
