'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// ĐƠN GIÁ THEO PHẦN IN (mig 113, 11/10/2026) — ERP gửi kèm mỗi dòng `/phieu-nhan-vai-60`:
//   `GiaIn` → `phan_in.gia_in` · `Giaep` → `gia_ep` · `giainkieng` → `gia_in_kieng` · `Dongia` → `don_gia`
//   (đo raw prod: Dongia = GiaIn + Giaep + giainkieng ở mọi dòng; 1 code phần 1 giá).
// Dùng ở: đồng bộ ERP (ghi) · Kế hoạch › Danh sách release (cột "Đơn giá" + tổng tiền).
//
// ⚠ Dò cột trước khi ghi/đọc (khuôn `utils/thoInKeHoach.js`): có cột ⇒ nhớ mãi; CHƯA có ⇒ nhớ 60 s rồi dò lại
//   ⇒ chạy migration xong tối đa 1 phút là nhận, không cần restart BE. Dò lỗi ⇒ coi như chưa có (fail-open:
//   giá là thông tin phụ, không được chặn đồng bộ đợt vải).
// ─────────────────────────────────────────────────────────────────────────────
const { query } = require('../config/db');

// Cột MES ↔ tên trường ERP (đọc không phân biệt hoa/thường — ERP đặt `GiaIn` · `Giaep` · `giainkieng` · `Dongia`).
const COT_GIA = [
  { cot: 'gia_in', erp: ['GiaIn', 'gia_in'] },
  { cot: 'gia_ep', erp: ['Giaep', 'gia_ep'] },
  { cot: 'gia_in_kieng', erp: ['giainkieng', 'gia_in_kieng'] },
  { cot: 'don_gia', erp: ['Dongia', 'don_gia'] },
];
const TEN_COT = COT_GIA.map((c) => c.cot);

const NHO_CHUA_CO_MS = 60 * 1000;
let coCot = false;
let doLuc = 0;
async function coCotGia() {
  if (coCot) return true;
  if (Date.now() - doLuc < NHO_CHUA_CO_MS) return false;
  try {
    const { rows } = await query(
      "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='phan_in' AND column_name = ANY($1::text[])",
      [TEN_COT]
    );
    coCot = Number(rows[0] && rows[0].n) === TEN_COT.length;
  } catch (e) {
    coCot = false;
  }
  doLuc = Date.now();
  return coCot;
}

// Số ≥ 0 hợp lệ, làm tròn 2 số lẻ (NUMERIC(18,2)); trống / không phải số / âm ⇒ null (= GIỮ giá đang lưu).
function soGia(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(String(v).trim().replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n >= 1e15) return null;
  return Math.round(n * 100) / 100;
}

// Đọc 4 giá từ 1 dòng ERP. Trả `{ gia_in, gia_ep, gia_in_kieng, don_gia }` (mỗi giá số | null) hoặc null khi
// dòng không mang giá nào (payload cũ chưa có trường ⇒ khỏi tốn 1 câu UPDATE).
function docGiaErp(r) {
  if (!r) return null;
  const chuan = (s) => String(s).toLowerCase().replace(/[_\s-]/g, '');
  const theoKhoa = new Map(Object.keys(r).map((k) => [chuan(k), k]));
  const out = {};
  let co = false;
  for (const { cot, erp } of COT_GIA) {
    let gia = null;
    for (const ten of erp) {
      const k = theoKhoa.get(chuan(ten));
      if (k != null) { gia = soGia(r[k]); if (gia != null) break; }
    }
    out[cot] = gia;
    if (gia != null) co = true;
  }
  return co ? out : null;
}

// Cột SELECT cho câu đọc có alias phần in `a` — thiếu cột ⇒ NULL (câu vẫn chạy, FE hiện trống).
async function cotGiaSql(a = 'pin') {
  const co = await coCotGia();
  return TEN_COT.map((c) => (co ? `${a}.${c}` : `NULL::numeric AS ${c}`)).join(', ');
}

module.exports = { coCotGia, docGiaErp, soGia, cotGiaSql, TEN_COT, _datLaiDo: () => { coCot = false; doLuc = 0; } };
