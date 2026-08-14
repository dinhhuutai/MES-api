'use strict';

const env = require('../config/env');
const erpService = require('../modules/erpsync/erpsync.service');
const { apiBat } = require('../utils/caiDatApi');

// Tự đồng bộ ERP mỗi N phút (mặc định 5). Truyền thời gian hiện tại làm tham số.
//
// ⚠⚠ CỜ BẬT/TẮT KIỂM **MỖI LƯỢT CHẠY**, không kiểm 1 lần lúc khởi động (mig 083):
//   trang Hệ thống > Cài đặt API bật/tắt được lúc đang chạy, mà job thì `setInterval` sống suốt
//   vòng đời tiến trình ⇒ kiểm lúc khởi động là bấm nút xong phải restart BE mới ăn.
//   Vì vậy job LUÔN được dựng; `ERP_SYNC_ENABLED=false` nay chỉ còn là **giá trị mặc định** khi
//   chưa có dòng trong `cai_dat_api` (xem `utils/caiDatApi.js` `macDinh()`).
function startErpSyncJob() {
  const intervalMs = Math.max(5, env.erp.syncIntervalMin) * 60 * 1000;
  let daBaoTat = false; // chỉ log 1 lần mỗi lượt tắt→bật, khỏi spam log mỗi 5 phút

  // MỘT API duy nhất (/phieu-nhan-vai-60): đợt vải vào thẳng READY (KTCankiemtra=0 → đi tiếp Release 1).
  const run = async () => {
    try {
      if (!(await apiBat('ERP_DONG_BO_VAI'))) {
        if (!daBaoTat) {
          console.log('[erp-sync] ⏸ ĐANG TẮT (Hệ thống > Cài đặt API) — bỏ qua lượt đồng bộ');
          daBaoTat = true;
        }
        return;
      }
      daBaoTat = false;
      const r = await erpService.syncPhieuNhanVai({ tuDong: true }); // fromDate mặc định = now - N ngày
      console.log(`[erp-sync] OK: ${r.soMoi} mới, ${r.soCapNhat} cập nhật, ${r.soLoi} lỗi (tổng ${r.tong})`);
    } catch (e) {
      console.error('[erp-sync] Lỗi đồng bộ:', e.message);
    }
  };

  // Chạy lần đầu sau 30s (chờ server ổn định) rồi lặp mỗi N phút.
  setTimeout(run, 30000);
  setInterval(run, intervalMs);
  console.log(`[erp-sync] Job tự đồng bộ mỗi ${env.erp.syncIntervalMin} phút`
    + (env.erp.syncEnabled ? '' : ' (mặc định .env đang TẮT — bật ở Hệ thống > Cài đặt API)'));
}

module.exports = { startErpSyncJob };
