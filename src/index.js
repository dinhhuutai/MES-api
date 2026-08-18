'use strict';

const http = require('http');
const { Server } = require('socket.io');
const app = require('./app');
const env = require('./config/env');
const sockets = require('./sockets');
const { pool } = require('./config/db');
const webPush = require('./utils/webPush'); // trạng thái Web Push (mig 085) — in lúc khởi động
// [ERP TẮT TẠM] vô hiệu hóa job tự kết nối ERP để kiểm tra. Bỏ comment 2 dòng (đây + startErpSyncJob bên dưới) để bật lại.
 const { startErpSyncJob } = require('./jobs/erpSync.job');
const { startCleanupJob } = require('./jobs/cleanup.job');
const { startDryingJob } = require('./jobs/drying.job');

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
    // ⚠⚠ IN 2 URL ERP NGAY LÚC KHỞI ĐỘNG — lỗi 2026-08-11: production chỉ đặt URL nhận vải, URL lấy
    //   mã tem trỏ host khác ⇒ đồng bộ chạy ngon mà KHÔNG IN ĐƯỢC TEM, log đồng bộ vẫn xanh nên rất
    //   khó đoán. Nhìn 2 dòng này là thấy ngay 2 đường có cùng host không.
    console.log(`[erp] Nhận vải : ${env.erp.phieuNhanVaiUrl}`);
    console.log(`[erp] Mã tem   : ${env.erp.barcodeTemUrl}`
      + (process.env.ERP_BARCODE_TEM_URL ? '' : '   ⚠ CHƯA đặt ERP_BARCODE_TEM_URL trong .env — đang suy theo gốc URL nhận vải'));
    console.log(`[erp] Ghi in tem: ${env.erp.ghiInTemUrl}`
      + (env.erp.ghiInTemEnabled ? '' : '   (ĐANG TẮT qua ERP_GHI_IN_TEM_ENABLED=false)')
      + (process.env.ERP_GHI_IN_TEM_URL ? '' : '   ⚠ CHƯA đặt ERP_GHI_IN_TEM_URL trong .env — đang suy theo gốc URL nhận vải'));
    // ⚠ Web Push (mig 085): thiếu VAPID key / chưa cài `web-push` thì TỰ TẮT — chuông và popup khi
    //   app đang mở vẫn chạy, chỉ mất phần "báo cả khi đóng app". In ra để khỏi phải đi dò vì sao.
    const tt = webPush.trangThai();
    console.log(`[push] Web Push : ${tt.san_sang ? 'sẵn sàng' : `TẮT — ${tt.ly_do}`}`);
    // [ERP TẮT TẠM] không tự đồng bộ ERP. Bỏ comment để bật lại.
     startErpSyncJob();
    startCleanupJob();
    startDryingJob();
  });
}

start();
