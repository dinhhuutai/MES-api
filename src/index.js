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
    // ⚠ ERP đổi tên endpoint `/barcode-tem` → `/barcode-tem-15` (16/09/2026). Biến `.env` nhận cả tên mới
    //   (`ERP_BARCODE_TEM_15_URL`, ưu tiên) lẫn tên cũ; nhắc ngay ở đây nếu URL vẫn còn đuôi cũ.
    console.log(`[erp] Mã tem 15: ${env.erp.barcodeTemUrl}`
      + (process.env.ERP_BARCODE_TEM_15_URL || process.env.ERP_BARCODE_TEM_URL
        ? '' : '   ⚠ CHƯA đặt ERP_BARCODE_TEM_15_URL trong .env — đang suy theo gốc URL nhận vải')
      + (/\/barcode-tem$/.test(env.erp.barcodeTemUrl)
        ? '   ⚠⚠ URL còn đuôi CŨ /barcode-tem — ERP đã đổi thành /barcode-tem-15, sửa .env đi' : ''));
    // Mã tem 17 (sửa đạt) / 13 (gia công về) xin từ endpoint RIÊNG — thiếu là 2 công đoạn đó lấy
    // nhầm dãy số của tem 15. In cùng chỗ để 1 lần nhìn là thấy đủ mọi đường đi tới ERP.
    console.log(`[erp] Mã tem 17: ${env.erp.barcodeTem17Url}`
      + (process.env.ERP_BARCODE_TEM_17_URL ? '' : '   ⚠ CHƯA đặt ERP_BARCODE_TEM_17_URL — đang suy theo gốc URL nhận vải'));
    console.log(`[erp] Mã tem 13: ${env.erp.barcodeTem13Url}`
      + (process.env.ERP_BARCODE_TEM_13_URL ? '' : '   ⚠ CHƯA đặt ERP_BARCODE_TEM_13_URL — đang suy theo gốc URL nhận vải'));
    console.log(`[erp] Ghi in tem: ${env.erp.ghiInTemUrl}`
      + (env.erp.ghiInTemEnabled ? '' : '   (ĐANG TẮT qua ERP_GHI_IN_TEM_ENABLED=false)')
      + (process.env.ERP_GHI_IN_TEM_URL ? '' : '   ⚠ CHƯA đặt ERP_GHI_IN_TEM_URL trong .env — đang suy theo gốc URL nhận vải'));
    // 3 API thêm 04/09/2026 — in cùng chỗ để vẫn nhìn 1 lần là thấy đủ mọi đường đi tới ERP.
    console.log(`[erp] ID phiếu giao : ${env.erp.layIdPhieuGiaoUrl}`
      + (process.env.ERP_LAY_ID_PHIEU_GIAO_URL ? '' : '   ⚠ CHƯA đặt ERP_LAY_ID_PHIEU_GIAO_URL — đang suy theo gốc URL nhận vải'));
    console.log(`[erp] Gửi phiếu giao: ${env.erp.guiPhieuGiaoUrl}`
      + (env.erp.guiPhieuGiaoEnabled ? '' : '   (ĐANG TẮT qua ERP_GUI_PHIEU_GIAO_ENABLED=false)')
      + (process.env.ERP_GUI_PHIEU_GIAO_URL ? '' : '   ⚠ CHƯA đặt ERP_GUI_PHIEU_GIAO_URL — đang suy theo gốc URL nhận vải'));
    console.log(`[erp] Gửi PL lỗi   : ${env.erp.guiPhanLoaiLoiUrl}`
      + (env.erp.guiPhanLoaiLoiEnabled ? '' : '   (ĐANG TẮT qua ERP_GUI_PHAN_LOAI_LOI_ENABLED=false)')
      + (process.env.ERP_GUI_PHAN_LOAI_LOI_URL ? '' : '   ⚠ CHƯA đặt ERP_GUI_PHAN_LOAI_LOI_URL — đang suy theo gốc URL nhận vải'));
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
