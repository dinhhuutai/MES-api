'use strict';

const { Pool } = require('pg');
const env = require('./env');

// Pool kết nối PostgreSQL dùng chung toàn app.
const pool = new Pool({
  host: env.db.host,
  port: env.db.port,
  database: env.db.database,
  user: env.db.user,
  password: env.db.password,
  ssl: env.db.ssl ? { rejectUnauthorized: false } : false,
  // Dashboard bắn ~13 query song song (summary 11 + activity + stage-counts); pool nhỏ → query xếp hàng
  // và có thể timeout khi DB ở xa → trang kẹt "Đang tải". Nới pool để đủ chỗ cho các màn nặng.
  max: 25,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});

pool.on('error', (err) => {
  // Lỗi client nhàn rỗi — log để không crash app.
  console.error('[db] Lỗi pool PostgreSQL:', err.message);
});

/**
 * Chạy 1 query tham số hóa.
 * @param {string} text
 * @param {Array} [params]
 */
function query(text, params) {
  return pool.query(text, params);
}

/**
 * Chạy nhiều thao tác trong 1 transaction.
 * callback nhận client; tự BEGIN/COMMIT/ROLLBACK.
 * @param {(client: import('pg').PoolClient) => Promise<any>} callback
 */
async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
