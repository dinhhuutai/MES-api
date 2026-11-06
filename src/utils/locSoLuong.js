'use strict';

// ─── LỌC THEO SỐ LƯỢNG (06/11/2026, người dùng: "danh sách tem in cho lọc theo số lượng in, các lịch sử cũng lọc
//   theo số lượng in") — 1 ô chữ, dùng ở Danh sách tem in (`tem.so_luong`) + Cài đặt API › Lịch sử (`gui.Soluong`).
// Nhận: `500` (đúng 500) · `100-500` (từ 100 tới 500, gồm 2 đầu; đảo đầu cũng được) · `500-` (từ 500) ·
//   `>500` · `>=500` · `<500` · `<=500` (cả `≥` `≤`). Dấu chấm / phẩy / khoảng trắng bị bỏ (`1.200` = 1200 — số lượng
//   luôn là số nguyên). Gạch dài `–` `—` và `~` = gạch nối.
// Gương FE: `frontend/src/utils/locSoLuong.js` (FE dùng để báo ô sai, không gửi giá trị sai) — sửa luật thì sửa cả hai.
function docLocSoLuong(v) {
  const s = String(v == null ? '' : v)
    .replace(/[\s.,]/g, '').replace(/[–—~]/g, '-').replace(/≥/g, '>=').replace(/≤/g, '<=');
  if (!s) return null;
  let m = /^(\d{1,9})$/.exec(s);
  if (m) return { tu: Number(m[1]), den: Number(m[1]) };
  m = /^(\d{1,9})-(\d{1,9})$/.exec(s);
  if (m) {
    const a = Number(m[1]); const b = Number(m[2]);
    return { tu: Math.min(a, b), den: Math.max(a, b) };
  }
  m = /^(\d{1,9})-$/.exec(s);
  if (m) return { tu: Number(m[1]), den: null };
  m = /^(>=|>|<=|<)(\d{1,9})$/.exec(s);
  if (m) {
    const n = Number(m[2]);
    if (m[1] === '>') return { tu: n + 1, den: null };
    if (m[1] === '>=') return { tu: n, den: null };
    if (m[1] === '<') return { tu: null, den: n - 1 };
    return { tu: null, den: n };
  }
  return null; // sai dạng ⇒ không lọc (FE đã chặn không gửi)
}

// Điều kiện SQL trên 1 biểu thức số (vd `t.so_luong`). Đẩy tham số vào `p`; không lọc ⇒ ''.
function dkSoLuongSql(bieuThuc, loc, p) {
  if (!loc) return '';
  const dk = [];
  if (loc.tu != null) { p.push(loc.tu); dk.push(`${bieuThuc} >= $${p.length}::numeric`); }
  if (loc.den != null) { p.push(loc.den); dk.push(`${bieuThuc} <= $${p.length}::numeric`); }
  return dk.length ? `(${dk.join(' AND ')})` : '';
}

module.exports = { docLocSoLuong, dkSoLuongSql };
