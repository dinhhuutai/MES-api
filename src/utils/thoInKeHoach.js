'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// THỢ IN KẾ HOẠCH (mig 111, 07/10/2026) — danh sách thợ in chọn lúc XÁC NHẬN RELEASE 1, lưu ở
// `lenh_san_xuat.tho_in_kh` (lệnh) và `ke_hoach_tam.tho_in_kh` (đợt chưa Ready → kế hoạch tạm, chép sang
// lệnh khi xác nhận). Cùng định dạng với `phan_cong_san_xuat.tho_in`: 1 CHUỖI tên ngăn dấu phẩy.
//
// ⚠ Đây là KẾ HOẠCH, không thay phân công thật: phân công lúc chạy (RunPanel › Phân công) vẫn là nguồn gửi
//   ERP (`dsthoin`) và thắng khi hiển thị; thợ in kế hoạch chỉ là giá trị GỢI Ý / hiện khi chưa phân công.
// ⚠ Dò cột trước khi ghi/đọc (khuôn `phieuCoCotToIn`) — các hàm ghi chạy TRONG transaction, lỗi 42703 sẽ
//   abort cả transaction. Có cột ⇒ nhớ mãi; CHƯA có ⇒ nhớ 60 s rồi dò lại (`getLenhBasic` của Sản xuất nằm
//   trên nhiều đường nóng — dò mỗi lần là thêm 1 round-trip) ⇒ chạy migration xong tối đa 1 phút là nhận,
//   không cần restart BE. Dò lỗi ⇒ coi như chưa có cột (fail-open: tính năng phụ, không chặn thao tác chính).
// ─────────────────────────────────────────────────────────────────────────────
const { query } = require('../config/db');

const NHO_CHUA_CO_MS = 60 * 1000;
let coCot = false;
let doLuc = 0;
async function coCotThoInKh() {
  if (coCot) return true;
  if (Date.now() - doLuc < NHO_CHUA_CO_MS) return false;
  try {
    const { rows } = await query(
      "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND column_name='tho_in_kh' AND table_name IN ('lenh_san_xuat','ke_hoach_tam')"
    );
    coCot = Number(rows[0] && rows[0].n) === 2;
  } catch (e) {
    coCot = false;
  }
  doLuc = Date.now();
  return coCot;
}

// Chuẩn hóa chuỗi thợ in: tách dấu phẩy · bỏ khoảng trắng thừa · bỏ tên trùng (không phân biệt hoa thường)
// · rỗng ⇒ null. Nhận cả mảng tên.
function chuanHoaThoIn(v) {
  const ds = (Array.isArray(v) ? v : String(v == null ? '' : v).split(','))
    .map((s) => String(s || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const daCo = new Set();
  const out = ds.filter((t) => {
    const k = t.toLowerCase();
    if (daCo.has(k)) return false;
    daCo.add(k);
    return true;
  });
  return out.length ? out.join(', ') : null;
}

module.exports = { coCotThoInKh, chuanHoaThoIn };
