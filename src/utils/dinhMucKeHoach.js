'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// ĐỊNH MỨC KẾ HOẠCH (mig 129) — số sản phẩm in được trong 1 GIỜ, người làm kế hoạch TỰ NHẬP lúc Release 1 / Kế hoạch tạm /
//   Gom đợt vải / Lập lại kế hoạch. Lưu `lenh_san_xuat.dinh_muc_gio` + `ke_hoach_tam.dinh_muc_gio` (chép sang lệnh khi
//   xác nhận kế hoạch tạm). Chỉ để HIỆN (In lệnh SX, Excel Danh sách release) — không tính giờ, không chặn gì.
// ⚠ Dò cột trước khi ghi/đọc (khuôn `thoInKeHoach.coCotThoInKh`): hàm ghi chạy TRONG transaction, lỗi 42703 abort cả lượt.
//   Có cột ⇒ nhớ mãi; chưa có ⇒ nhớ 60 s rồi dò lại (chạy mig xong ≤ 1 phút là nhận). Dò lỗi ⇒ coi như chưa có (fail-open).
// ─────────────────────────────────────────────────────────────────────────────
const { query } = require('../config/db');
const AppError = require('./AppError');

const NHO_CHUA_CO_MS = 60 * 1000;
const TOI_DA = 1000000;
let coCot = false;
let doLuc = 0;
async function coCotDinhMuc() {
  if (coCot) return true;
  if (Date.now() - doLuc < NHO_CHUA_CO_MS) return false;
  try {
    const { rows } = await query(
      "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND column_name='dinh_muc_gio' AND table_name IN ('lenh_san_xuat','ke_hoach_tam')"
    );
    coCot = Number(rows[0] && rows[0].n) === 2;
  } catch (e) {
    coCot = false;
  }
  doLuc = Date.now();
  return coCot;
}

// `undefined` ⇒ undefined (bên gọi không gửi = GIỮ) · rỗng / null ⇒ null (xóa) · còn lại phải là số nguyên > 0 (422).
function chuanHoaDinhMuc(v) {
  if (v === undefined) return undefined;
  if (v === null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[.,\s]/g, ''));
  if (!Number.isInteger(n) || n <= 0 || n > TOI_DA) {
    throw new AppError('Định mức (SP / giờ) phải là số nguyên dương', { status: 422, errorCode: 'DINH_MUC_SAI' });
  }
  return n;
}

// Đọc cột trong câu SELECT, trả về tên `dinh_muc_kh` (⚠ `chuyen_san_xuat.dinh_muc_gio` = định mức CHUYỀN đã có sẵn trong
//   nhiều câu ⇒ đặt tên khác để khỏi đè): có cột ⇒ `<alias>.dinh_muc_gio`, chưa ⇒ NULL.
async function cotDinhMucSql(alias) {
  return (await coCotDinhMuc()) ? `${alias}.dinh_muc_gio AS dinh_muc_kh` : 'NULL::int AS dinh_muc_kh';
}

module.exports = { coCotDinhMuc, chuanHoaDinhMuc, cotDinhMucSql };
