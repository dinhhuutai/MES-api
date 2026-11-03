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
  // Dashboard bắn ~13 query song song (summary 11 + activity + stage-counts); pool nhỏ → query xếp hàng.
  max: 25,
  // Giữ kết nối 5 phút: mở kết nối mới trên Windows tốn một tiến trình Postgres mới.
  idleTimeoutMillis: 5 * 60 * 1000,
  keepAlive: true,
  connectionTimeoutMillis: 15000,
  application_name: 'thla-mes-api',
  // ⚠ Chặn câu chạy mất kiểm soát chiếm hết pool (sự cố 03/11/2026: 24/25 kết nối kẹt nhiều phút ở 1 câu). FE đã bỏ cuộc
  //   sau 45 giây (`axiosClient`), Postgres vẫn chạy tiếp nếu không chặn ở đây. Đổi được bằng biến môi trường.
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS) || 120000,
  idle_in_transaction_session_timeout: Number(process.env.PG_IDLE_TX_TIMEOUT_MS) || 300000,
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
