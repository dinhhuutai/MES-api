'use strict';

const http = require('http');
const { Server } = require('socket.io');
const app = require('./app');
const env = require('./config/env');
const sockets = require('./sockets');
const { pool } = require('./config/db');
const { startErpSyncJob } = require('./jobs/erpSync.job');

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:3000",
      "https://mes.thuanhunglongan.com"
    ],
    credentials: true
  }
});
sockets.init(io);

async function start() {
  try {
    // Kiểm tra kết nối DB trước khi mở cổng.
    await pool.query('SELECT 1');
    console.log('[db] Kết nối PostgreSQL OK');
  } catch (err) {
    console.error('[db] KHÔNG kết nối được PostgreSQL:', err.message);
    process.exit(1);
  }
  server.listen(env.port, () => {
    console.log(`[server] THLA MES API chạy tại http://localhost:${env.port} (${env.nodeEnv})`);
    startErpSyncJob();
  });
}

start();
