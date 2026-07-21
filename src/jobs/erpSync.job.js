'use strict';

const env = require('../config/env');
const erpService = require('../modules/erpsync/erpsync.service');

// Tự đồng bộ ERP mỗi N phút (mặc định 60). Truyền thời gian hiện tại làm tham số.
function startErpSyncJob() {
  if (!env.erp.syncEnabled) {
    console.log('[erp-sync] Job tự đồng bộ ĐANG TẮT (ERP_SYNC_ENABLED=false)');
    return;
  }
  const intervalMs = Math.max(5, env.erp.syncIntervalMin) * 60 * 1000;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = async () => {
    // Chạy -new TRƯỚC (lấy dữ liệu chờ chuyển) rồi -60 (chuyển những code phần đã có sang READY + barcode).
    try {
      const rn = await erpService.syncPhieuNhanVaiNew({ tuDong: true });
      console.log(`[erp-sync] (-new) OK: ${rn.soMoi} mới (${rn.soChoChuyen || 0} chờ chuyển), ${rn.soCapNhat} cập nhật, ${rn.soLoi} lỗi (tổng ${rn.tong})`);
    } catch (e) {
      console.error('[erp-sync] (-new) Lỗi đồng bộ:', e.message);
    }
    await sleep(5000); // giãn nhịp để proc ERP nhả khóa trước khi gọi -60 (tránh deadlock chồng nhau)
    try {
      const r = await erpService.syncPhieuNhanVai({ tuDong: true }); // fromDate mặc định = now - N ngày
      console.log(`[erp-sync] (-60) OK: ${r.soMoi} mới, ${r.soCapNhat} cập nhật, ${r.soLoi} lỗi (tổng ${r.tong})`);
    } catch (e) {
      console.error('[erp-sync] (-60) Lỗi đồng bộ:', e.message);
    }
  };

  // Chạy lần đầu sau 30s (chờ server ổn định) rồi lặp mỗi N phút.
  setTimeout(run, 30000);
  setInterval(run, intervalMs);
  console.log(`[erp-sync] Job tự đồng bộ mỗi ${env.erp.syncIntervalMin} phút`);
}

module.exports = { startErpSyncJob };
