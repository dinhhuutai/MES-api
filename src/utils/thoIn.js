'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// THỢ IN HIỆN Ở BÁO CÁO SẢN XUẤT / KIỂM HÀNG / SỬA HÀNG / PHÂN LOẠI LỖI (11/10/2026, người dùng chốt).
// Gương FE `utils/thoIn.js`.
//   · Chuyền MÁY (MTD) ⇒ lấy tên CHUYỀN TRƯỞNG của phiếu (máy in tự động không phân thợ in từng người);
//     phiếu chưa nhập chuyền trưởng thì lùi về thợ in.
//   · Loại chuyền khác ⇒ thợ in PHÂN CÔNG lúc chạy (`phan_cong_san_xuat.tho_in`) → thợ in KẾ HOẠCH
//     (`lenh_san_xuat.tho_in_kh`, mig 111) → chuyền trưởng.
// Chuỗi thợ in là danh sách tên ngăn dấu phẩy ⇒ báo cáo "theo thợ in" tách từng người (`tachTho`), SL của dòng
// chia ĐỀU cho các thợ (phần lẻ dồn người đầu) để Σ theo thợ = tổng — xem `chiaDeu`.
// ─────────────────────────────────────────────────────────────────────────────

const sach = (v) => String(v == null ? '' : v).trim();
const KHONG_RO = 'Chưa phân công';

const laChuyenMay = (maLoaiChuyen) => sach(maLoaiChuyen).toUpperCase() === 'MAY';

function thoInHienThi({ ma_loai_chuyen: loai, tho_in: thoIn, tho_in_kh: thoKh, chuyen_truong: chuyenTruong } = {}) {
  const tho = sach(thoIn) || sach(thoKh);
  const ct = sach(chuyenTruong);
  return laChuyenMay(loai) ? (ct || tho) : (tho || ct);
}

// "A, B" → ['A', 'B'] (khử trùng không phân biệt hoa thường); rỗng ⇒ [].
function tachTho(v) {
  const daCo = new Set();
  return sach(v).split(',').map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => {
    const k = s.toLowerCase();
    if (!s || daCo.has(k)) return false;
    daCo.add(k);
    return true;
  });
}

// Danh sách thợ của 1 dòng (đã áp luật chuyền Máy); không có ai ⇒ ['Chưa phân công'].
function dsThoCuaDong(r) {
  const ds = tachTho(thoInHienThi(r));
  return ds.length ? ds : [KHONG_RO];
}

// BÁO CÁO SẢN XUẤT (19/10/2026 người dùng chốt): CẢ danh sách thợ in PHÂN CÔNG, mọi loại chuyền (KHÔNG áp luật
// chuyền Máy lấy chuyền trưởng) → thợ in kế hoạch → chuyền trưởng; không ai ⇒ ['Chưa phân công']. Bảng "Theo thợ
// in" chia đều số của dòng cho số người (`chiaDeu`).
function dsThoPhanCong({ tho_in: thoIn, tho_in_kh: thoKh, chuyen_truong: chuyenTruong } = {}) {
  const ds = tachTho(sach(thoIn) || sach(thoKh) || sach(chuyenTruong));
  return ds.length ? ds : [KHONG_RO];
}

// BÁO CÁO SẢN XUẤT — bảng "Theo thợ in" (26/10/2026 người dùng chốt): chuyền MÁY và chuyền BÀN ⇒ CHUYỀN TRƯỞNG của
// phiếu; phiếu chưa nhập chuyền trưởng ⇒ lùi về danh sách thợ in (`dsThoPhanCong`). Loại chuyền khác (Robot · Máy
// tròn · Logo · Ép…) giữ luật 19/10: cả danh sách thợ in phân công.
const LOAI_LAY_CHUYEN_TRUONG = ['MAY', 'BAN'];
function dsThoBaoCaoSanXuat(r = {}) {
  const loai = sach(r.ma_loai_chuyen).toUpperCase();
  const ct = tachTho(r.chuyen_truong);
  if (LOAI_LAY_CHUYEN_TRUONG.includes(loai) && ct.length) return ct;
  return dsThoPhanCong(r);
}

// Chia số nguyên `tong` cho `n` phần gần đều nhau, Σ = tong (phần lẻ dồn các phần đầu). Số thực ⇒ chia thẳng.
function chiaDeu(tong, n) {
  const k = Math.max(1, n | 0);
  const x = Number(tong) || 0;
  if (!Number.isInteger(x)) return Array.from({ length: k }, () => x / k);
  const co = Math.trunc(x / k);
  let du = x - co * k;
  return Array.from({ length: k }, () => { const them = du > 0 ? 1 : du < 0 ? -1 : 0; du -= them; return co + them; });
}

// Câu SQL con dùng chung: thợ in phân công của PHIẾU `psCol` (gộp chuỗi, khử trùng theo dòng phân công).
const thoInPhieuSql = (psCol) => `(SELECT string_agg(DISTINCT zpc.tho_in, ', ') FROM phan_cong_san_xuat zpc
  WHERE zpc.phieu_san_xuat_id = ${psCol} AND COALESCE(zpc.tho_in, '') <> '')`;

module.exports = { thoInHienThi, tachTho, dsThoCuaDong, dsThoPhanCong, dsThoBaoCaoSanXuat, chiaDeu, laChuyenMay, thoInPhieuSql, KHONG_RO };
