'use strict';

// Rút gọn dữ liệu trước khi đưa cho model: mảng dài ⇒ giữ đầu + ghi tổng; chuỗi dài ⇒ cắt; tổng JSON ≤ trần.
const TOI_DA_MANG = 40;
const TOI_DA_CHUOI = 400;
const TRAN_JSON = 24000;

function rutGon(v, sau = 0) {
  if (v == null) return v;
  if (typeof v === 'string') return v.length > TOI_DA_CHUOI ? `${v.slice(0, TOI_DA_CHUOI)}…` : v;
  if (typeof v !== 'object') return v;
  if (sau > 6) return '…';
  if (Array.isArray(v)) {
    const dau = v.slice(0, TOI_DA_MANG).map((x) => rutGon(x, sau + 1));
    if (v.length > TOI_DA_MANG) dau.push({ _ghi_chu: `… còn ${v.length - TOI_DA_MANG} dòng nữa (tổng ${v.length})` });
    return dau;
  }
  const ra = {};
  Object.entries(v).forEach(([k, x]) => { ra[k] = rutGon(x, sau + 1); });
  return ra;
}

/** JSON đã rút gọn, không vượt trần ký tự. */
function jsonGon(v) {
  let s = JSON.stringify(rutGon(v));
  if (s && s.length > TRAN_JSON) s = `${s.slice(0, TRAN_JSON)}… [đã cắt bớt — hãy lọc hẹp hơn (ngày, trạm, từ khóa) để xem đủ]`;
  return s;
}

module.exports = { rutGon, jsonGon };
