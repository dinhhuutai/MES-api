'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// TÌM KIẾM THÔNG MINH — dùng CHUNG cho mọi ô tìm kiếm / ô lọc của backend.
//   · Bỏ khoảng trắng đầu–cuối, gộp nhiều khoảng trắng giữa thành 1
//   · KHÔNG phân biệt hoa–thường
//   · KHÔNG phân biệt DẤU tiếng Việt (gõ "thi" ra "THỊ", "duc" ra "Đức", "do" ra "đỏ")
//
// ⚠⚠ VÌ SAO DÙNG REGEX `~*` CHỨ KHÔNG PHẢI `unaccent()`/`translate()` TRÊN CỘT:
//   (a) `unaccent` là EXTENSION chưa cài trên prod ⇒ phải migration + chạy bằng `postgres`, và
//       môi trường nào thiếu extension là **mọi màn danh sách sập** (`42883`).
//   (b) `translate(lower(col),'<67 ký tự>','<67 ký tự>')` nhúng thẳng vào SQL làm **phình ~300 ký tự
//       cho MỖI cột** — màn KCS/Release có 6–8 cột tìm ⇒ +2400 ký tự/câu, đúng thứ hay bị **IPS reset**
//       (§9 CLAUDE.md).
//   Cách này ngược lại: `col ~* $1` **NGẮN HƠN** `col ILIKE '%'||$1||'%'`, không cần migration, và
//   chạy được ngay trên mọi DB (prod · THLA_TEST · máy lẻ).
//
// ⚠ KHÔNG mất index: `ILIKE '%…%'` có ký tự đại diện ở ĐẦU nên vốn đã không dùng được index btree —
//   đổi sang `~*` không đánh đổi gì về index, chỉ thêm chi phí regex trên chính vòng quét đang có.
// ─────────────────────────────────────────────────────────────────────────────

// Nhóm ký tự cùng gốc. `~*` đã không phân biệt hoa–thường nên chỉ cần chữ THƯỜNG.
// Mỗi nhóm gồm cả ký tự KHÔNG DẤU để gõ có dấu vẫn khớp dữ liệu không dấu và ngược lại.
const NHOM = {
  a: 'aàáạảãâầấậẩẫăằắặẳẵ',
  e: 'eèéẹẻẽêềếệểễ',
  i: 'iìíịỉĩ',
  o: 'oòóọỏõôồốộổỗơờớợởỡ',
  u: 'uùúụủũưừứựửữ',
  y: 'yỳýỵỷỹ',
  d: 'dđ',
};

// Ký tự có nghĩa đặc biệt trong regex POSIX của PostgreSQL — phải thoát để người dùng gõ "(6PCS)"
// hay "2.1*1" thì tìm ĐÚNG chuỗi đó, không bị hiểu thành cú pháp regex (và không ném lỗi SQL).
const DAC_BIET = new Set([...'\\^$.[]|()*+?{}-/']);

// Bỏ dấu tiếng Việt của TỪ KHÓA (chỉ dùng cho phía nhập liệu, dữ liệu trong DB giữ nguyên).
const boDau = (s) => String(s == null ? '' : s)
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/đ/g, 'd').replace(/Đ/g, 'D');

// Chuẩn hóa TỪ KHÓA: bỏ khoảng trắng đầu–cuối + gộp khoảng trắng giữa.
// Dùng cả cho ô tìm kiếm lẫn ô lọc từng trường; cũng dùng khi so khớp CHÍNH XÁC.
const chuanTuKhoa = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');

// Dựng MẪU REGEX cho toán tử `~*`: mỗi nguyên âm / chữ d nở thành lớp ký tự phủ mọi biến thể dấu.
//   "do"  → '[dđ][oòóọỏõôồốộổỗơờớợởỡ]'   (khớp "do", "đỏ", "Độ"…)
//   "thi" → '[tT]?…' KHÔNG cần — `~*` đã bỏ qua hoa–thường
// Không có neo ^ $ ⇒ khớp CHỨA, đúng như `ILIKE '%…%'` trước đây.
// Trả '' khi từ khóa rỗng (giữ nguyên hành vi cũ: không lọc / khớp tất cả).
function mauTim(s) {
  const tu = boDau(chuanTuKhoa(s)).toLowerCase();
  if (!tu) return '';
  let out = '';
  for (const ch of tu) {
    if (NHOM[ch]) out += `[${NHOM[ch]}]`;
    else if (DAC_BIET.has(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return out;
}

module.exports = { mauTim, chuanTuKhoa, boDau };
