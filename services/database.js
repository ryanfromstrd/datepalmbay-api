/**
 * MySQL Database Service
 * JSON Blob storage for data persistence (replaces JSON file storage)
 */
const mysql = require('mysql2/promise');

let pool = null;

/**
 * Initialize MySQL connection pool
 * Supports Railway auto-injected variables or individual env vars
 */
function getPool() {
  if (pool) return pool;

  const connectionUrl = process.env.MYSQL_URL || process.env.DATABASE_URL;

  if (connectionUrl) {
    pool = mysql.createPool({
      uri: connectionUrl,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      connectTimeout: 10000,
    });
  } else {
    pool = mysql.createPool({
      host: process.env.MYSQLHOST || process.env.MYSQL_HOST || 'localhost',
      port: parseInt(process.env.MYSQLPORT || process.env.MYSQL_PORT || '3306'),
      user: process.env.MYSQLUSER || process.env.MYSQL_USER || 'root',
      password: process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD || '',
      database: process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE || 'datepalmbay',
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      connectTimeout: 10000,
    });
  }

  console.log('🗄️  MySQL connection pool created');
  return pool;
}

/**
 * Initialize data_store table if not exists
 */
async function initTable() {
  const db = getPool();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS data_store (
      data_key VARCHAR(50) PRIMARY KEY,
      data_value LONGTEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  console.log('🗄️  data_store table ready');
}

/**
 * Load all entities from MySQL
 * @returns {Object} Map of { key: parsedValue }
 */
async function loadAll() {
  const db = getPool();
  const [rows] = await db.execute('SELECT data_key, data_value FROM data_store');
  const result = {};
  for (const row of rows) {
    try {
      result[row.data_key] = JSON.parse(row.data_value);
    } catch (e) {
      console.error(`❌ Failed to parse data for key "${row.data_key}":`, e.message);
      result[row.data_key] = null;
    }
  }
  return result;
}

/**
 * Save multiple entities in a single transaction (UPSERT)
 * @param {Object} entities - Map of { key: value }
 */
async function saveAll(entities) {
  const db = getPool();
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    for (const [key, value] of Object.entries(entities)) {
      const jsonStr = JSON.stringify(value);
      await connection.execute(
        `INSERT INTO data_store (data_key, data_value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE data_value = VALUES(data_value)`,
        [key, jsonStr]
      );
    }
    await connection.commit();
  } catch (e) {
    await connection.rollback();
    throw e;
  } finally {
    connection.release();
  }
}

/**
 * Check if MySQL is available
 */
async function isAvailable() {
  try {
    const db = getPool();
    await db.execute('SELECT 1');
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Close pool (for graceful shutdown)
 */
async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  initTable,
  loadAll,
  saveAll,
  isAvailable,
  close,
  getPool,
};
