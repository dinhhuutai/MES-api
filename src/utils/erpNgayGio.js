'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// ĐỊNH DẠNG NGÀY GIỜ GỬI ERP (02/10/2026 — sự cố "MES lưu hôm nay, ERP ra hôm qua").
//
// Nguyên nhân (đã mô phỏng bằng chính `tedious` mà `mssql` dùng, TZ máy ERP = Asia/Ho_Chi_Minh):
//   router ERP nhận chuỗi giờ VN rồi `new Date(chuoi)` (hoặc đưa thẳng chuỗi vào `sql.DateTime` — tedious
//   cũng `new Date(Date.parse(chuoi))`) ⇒ chuỗi bị hiểu là giờ ĐỊA PHƯƠNG máy ERP; `mssql` mặc định
//   `useUTC: true` ⇒ ghi thành phần UTC vào DATETIME ⇒ LÙI 7 TIẾNG:
//     MES gửi '2026/10/01'          → ERP lưu 2026-09-30 17:00  (sang hôm qua)
//     MES gửi '2026/10/01 17:40:00' → ERP lưu 2026-10-01 10:40
//   Gửi dạng ISO đuôi `Z` ('2026-10-01T17:40:00.000Z') thì `new Date` ra đúng mốc UTC 17:40 và `mssql`
//   ghi đúng 17:40 — ĐÚNG BẤT KỂ múi giờ máy ERP (đã thử cả TZ VN lẫn UTC).
//
// ⚠⚠ ĐUÔI `Z` Ở ĐÂY KHÔNG CÓ NGHĨA "GIỜ UTC" — nó là GIỜ VN dán nhãn Z cho khớp cách router ERP chuyển kiểu.
//   Đọc lịch sử API thấy '…T09:30:00.000Z' thì đó là 09:30 giờ VN.
// ⚠⚠ ROUTER NÀO TỰ DỰNG NGÀY bằng `Date.UTC` (hàm `ngayGioVN` của `/gui-erp-oqc`) thì PHẢI gửi dạng VN
//   'YYYY/MM/DD HH:mm:ss' — regex của nó không nhận đuôi `Z` (trả NULL). Kênh nào dùng dạng nào khai ở
//   `utils/erpGhiInTem.js KENH.*.kieuNgay` (mặc định `Z`). ERP đổi router sang `ngayGioVN` ⇒ đổi kênh đó sang `VN`.
// ─────────────────────────────────────────────────────────────────────────────

const LECH_VN_MS = 7 * 3600 * 1000; // Việt Nam không có giờ mùa hè.
const MAU = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\.\d+)?)?Z?$/;

// Tách thành phần GIỜ VN. Nhận: 'YYYY/MM/DD', 'YYYY-MM-DD HH:mm[:ss]', chính dạng đã đổi (đuôi Z ⇒ coi
// thành phần là giờ VN — để "Gửi lại" chạy qua hàm này lần 2 không lệch thêm), hoặc `Date` (mốc thật).
function tach(v) {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const d = new Date(v.getTime() + LECH_VN_MS);
    return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()];
  }
  const m = String(v).trim().match(MAU);
  if (!m) return null;
  return m.slice(1, 7).map((x) => Number(x || 0));
}

const p2 = (n) => String(n).padStart(2, '0');

/**
 * @param {*} v    giá trị ngày giờ (giờ VN)
 * @param {'Z'|'VN'} kieu  'Z' ⇒ '2026-10-01T17:40:00.000Z' · 'VN' ⇒ '2026/10/01 17:40:00'
 * @returns {string|null}  thiếu ⇒ null (router khai `sql.DateTime` — chuỗi rỗng làm hỏng cả lượt gọi);
 *   chuỗi không nhận ra định dạng ⇒ giữ nguyên (không tự bịa ngày).
 */
function ngayGioErp(v, kieu = 'Z') {
  if (v == null || (typeof v === 'string' && !v.trim())) return null;
  const t = tach(v);
  if (!t) return typeof v === 'string' ? v.trim() : null;
  const [y, mo, d, h, mi, s] = t;
  if (kieu === 'VN') return `${y}/${p2(mo)}/${p2(d)} ${p2(h)}:${p2(mi)}:${p2(s)}`;
  return `${y}-${p2(mo)}-${p2(d)}T${p2(h)}:${p2(mi)}:${p2(s)}.000Z`;
}

module.exports = { ngayGioErp };
