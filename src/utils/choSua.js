'use strict';

// ─── SỬA: PHÂN LOẠI LỖI → CHỜ NHẬN SỬA → NHẬN SỬA → SỬA (14/11/2026, người dùng chốt) ─────────────────
// Nguồn luật DUY NHẤT của "hàng hư đi tới màn Sửa".
//   1. KCS nhập hư ⇒ sổ cái dồn hư vào `sl_kcs_sua` nhưng hàng CHƯA vào Sửa: phải qua PHÂN LOẠI LỖI (chia sửa / hủy).
//      `vaoSuaDuocSql` = tem có phiếu `phan_loai_loi` (kể cả phiếu không dòng của script hệ thống) HOẶC đã có lượt Sửa.
//   2. Phân loại xong ⇒ phần sửa nằm ở *Hệ thống › Chờ nhận sửa* (mig 132). Tổ sửa bấm "Nhận sửa" ở màn Sửa, nhập SL nhận
//      hôm nay ⇒ chỉ phần ĐÃ NHẬN lên màn Sửa và mới xác nhận sửa được (1 tem sửa nhiều ngày ⇒ không tồn ảo).
//      Sổ cái (tem):  xử lý = sl_sua_dat + sl_sua_huy
//                     đã nhận (hiệu lực) = LEAST(GREATEST(sl_nhan_sua, xử lý), sl_kcs_sua)
//                     ĐANG SỬA (màn Sửa) = đã nhận − xử lý      CHỜ NHẬN = sl_kcs_sua − đã nhận
//                     ⇒ đang sửa + chờ nhận = con_sua (tổng còn phải sửa, như cũ).
//      Kẹp GREATEST/LEAST giữ đúng khi sổ cái đổi từ đường khác: OQC trả về Sửa / hủy xác nhận Sửa (xử lý giảm ⇒ hàng quay
//      lại ĐANG SỬA vì đã nhận rồi) · hủy tem sửa (`sl_kcs_sua` giảm ⇒ kẹp; service còn hạ `sl_nhan_sua` để hư mới sau này
//      không lọt thẳng vào Sửa).
//   3. CHƯA CHẠY mig 132 (`coNhanSua()` false) ⇒ đã nhận = `sl_kcs_sua` ⇒ đang sửa = con_sua, chờ nhận = 0 = luật trước đó.
//   Câu SQL tĩnh không chờ được `coNhanSua()` (siSoTram) ⇒ đọc cột qua `to_jsonb` (bản `…J`) — thiếu cột thì lùi luật cũ.

const { query } = require('../config/db');

const xuLySql = (t = 't') => `(${t}.sl_sua_dat + ${t}.sl_sua_huy)`;

// ── Bản theo cờ `co` (đã có cột — lấy từ `await coNhanSua()`) ──
const nhanCot = (t, co) => (co ? `${t}.sl_nhan_sua` : `${t}.sl_kcs_sua`);
const daNhanSql = (t = 't', co = true) => `LEAST(GREATEST(${nhanCot(t, co)}, ${xuLySql(t)}), ${t}.sl_kcs_sua)`;
const dangSuaSql = (t = 't', co = true) => `GREATEST(${daNhanSql(t, co)} - ${xuLySql(t)}, 0)`;
const choNhanSql = (t = 't', co = true) => `GREATEST(${t}.sl_kcs_sua - ${daNhanSql(t, co)}, 0)`;

// ── Bản TĨNH (to_jsonb) cho câu không async ──
const nhanJ = (t = 't') => `COALESCE((to_jsonb(${t})->>'sl_nhan_sua')::int, ${t}.sl_kcs_sua)`;
const daNhanJ = (t = 't') => `LEAST(GREATEST(${nhanJ(t)}, ${xuLySql(t)}), ${t}.sl_kcs_sua)`;
const dangSuaJ = (t = 't') => `GREATEST(${daNhanJ(t)} - ${xuLySql(t)}, 0)`;
const tgNhanJ = (t = 't') => `(to_jsonb(${t})->>'tg_nhan_sua')::timestamptz`;

const vaoSuaDuocSql = (t = 't') => `(EXISTS (SELECT 1 FROM phan_loai_loi zpl WHERE zpl.tem_id = ${t}.id)
  OR EXISTS (SELECT 1 FROM sua zsu WHERE zsu.tem_id = ${t}.id))`;

// Mốc tem vào Sửa theo LUẬT TRƯỚC mig 132 (= lúc phân loại xong; không sớm hơn KCS đầu có hư; không muộn hơn lượt Sửa đầu)
//   — mig 132 dùng làm mốc lượt nhận 'CU'; sau mig là mốc lùi khi tem chưa có `tg_nhan_sua`.
const mocVaoSuaSql = (t = 't') => `COALESCE(LEAST(
    (SELECT min(zsu1.created_date) FROM sua zsu1 WHERE zsu1.tem_id = ${t}.id),
    GREATEST(
      (SELECT min(zmt2.created_date) FROM kcs zmt2 WHERE zmt2.tem_id = ${t}.id AND COALESCE(zmt2.so_luong_loi,0) > 0),
      (SELECT min(zpl1.created_date) FROM phan_loai_loi zpl1 WHERE zpl1.tem_id = ${t}.id))),
  ${t}.created_date)`;
// Mốc VÀO lô đang sửa (đồng hồ SLA màn Sửa · dải Theo dõi · Báo cáo sửa hàng): lượt nhận mở lô (`tem.tg_nhan_sua`).
const mocVaoLoSuaSql = (t = 't') => `COALESCE(${tgNhanJ(t)}, ${mocVaoSuaSql(t)})`;

// Đã chạy mig 132 chưa (cột tem.sl_nhan_sua + bảng nhan_sua). Chỉ nhớ khi ĐÃ có ⇒ chạy migration xong nhận ngay.
let _co = false;
async function coNhanSua() {
  if (_co) return true;
  const { rows } = await query(`SELECT (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'tem' AND column_name IN ('sl_nhan_sua','tg_nhan_sua'))::int AS c,
    (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'nhan_sua')::int AS b`
    .replace(/\s+/g, ' '));
  _co = rows[0].c === 2 && rows[0].b === 1;
  return _co;
}

module.exports = {
  xuLySql, daNhanSql, dangSuaSql, choNhanSql, nhanJ, dangSuaJ, tgNhanJ,
  vaoSuaDuocSql, mocVaoSuaSql, mocVaoLoSuaSql, coNhanSua,
};
