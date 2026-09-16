'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CẤP MÃ `IDMES` — khóa ĐỐI SOÁT MES ↔ ERP cho MỌI chiều đẩy (ghi-in-tem, phân loại lỗi, …).
//
// Dạng: `YMMDD` + 4 số thứ tự trong ngày (vd 31/08/2026 lượt 1 = 608310001).
// ⚠ Chỉ giữ 1 chữ số năm vì `@pIDMES` của proc `MES_spr_MES2SF0` khai kiểu `int` (SQL Server, trần
//   2.147.483.647): `YYMMDD`+4 cho ra 2.608.310.001 là TRÀN. Đổi lại: mã trùng vào 2036 (đã chốt).
// ⚠ 1 CÂU DUY NHẤT nên NGUYÊN TỬ — nhiều người bấm cùng lúc vẫn không nhận trùng số, khỏi khóa bảng.
// ⚠ Lỗi (chưa chạy mig 082 / vượt trần 9999) → trả NULL để bên gọi BỎ QUA lời gọi ERP.
//   Tuyệt đối không ném lỗi: nghiệp vụ trong MES không được phụ thuộc chiều đẩy này.
//
// ⚠⚠ DÙNG CHUNG MỘT DÃY SỐ cho mọi loại chứng từ (in tem · phân loại lỗi): số là duy nhất toàn hệ
//   nên ERP không bao giờ gặp 2 chứng từ khác loại trùng `IDMES`. Đừng tách dãy riêng từng API.
// ⚠ File này là NGUỒN DUY NHẤT — `production.repository.capIdMes` chỉ là lớp bọc để giữ tên cũ.
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../config/db');

async function capIdMes(nhan = 'erp') {
  try {
    const { rows } = await query(
      `INSERT INTO erp_idmes_counter (ngay, so_thu_tu)
       VALUES ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 1)
       ON CONFLICT (ngay) DO UPDATE SET so_thu_tu = erp_idmes_counter.so_thu_tu + 1
       RETURNING so_thu_tu, to_char(ngay, 'YMMDD') AS ymd`.replace(/\s+/g, ' ')
    );
    const r = rows[0];
    if (!r) return null;
    const stt = Number(r.so_thu_tu);
    if (!(stt >= 1 && stt <= 9999)) {
      console.error(`[${nhan}] ✗ Vượt trần 9999 lượt/ngày (số ${stt}) — BỎ QUA lời gọi ERP để không gửi mã trùng`);
      return null;
    }
    return Number(`${r.ymd}${String(stt).padStart(4, '0')}`);
  } catch (e) {
    console.error(`[${nhan}] ✗ Không cấp được IDMES (đã chạy migration 082 chưa?): ${e.message}`);
    return null;
  }
}

module.exports = { capIdMes };
