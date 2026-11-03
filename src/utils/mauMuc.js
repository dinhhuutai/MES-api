'use strict';

// MÀU MỰC là một phần định danh PHẦN IN (03/11/2026, người dùng chốt: "2 code phần giống nhau nhưng khác màu mực tức là
// 2 dòng", mig 121): phần in = (`ma_phan`, màu mực đã chuẩn hóa). ERP gửi ở trường `mauin`.
// Gương SQL: cột sinh `phan_in.mau_in_khoa` (mig 121) + `MAU_IN_KHOA_SQL` — sửa phải sửa cả ba.
const chuanMauMuc = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toUpperCase();

const MAU_IN_KHOA_SQL = (bieuThuc) => `upper(btrim(regexp_replace(COALESCE(${bieuThuc}, ''), '\\s+', ' ', 'g')))`;

// 2 màu "cùng 1 phần in": bằng nhau sau chuẩn hóa, hoặc 1 bên chưa có màu (ERP chưa gửi / dữ liệu trước 29/10/2026).
function khopMauMuc(a, b) {
  const x = chuanMauMuc(a);
  const y = chuanMauMuc(b);
  return !x || !y || x === y;
}

const mauMucErp = (r) => (r ? (r.mauin ?? r.mau_in ?? r.MauIn ?? '') : '');

module.exports = { chuanMauMuc, MAU_IN_KHOA_SQL, khopMauMuc, mauMucErp };
