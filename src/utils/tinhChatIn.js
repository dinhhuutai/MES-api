'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// DANH MỤC TÍNH CHẤT IN (mig 123, 04/11/2026, người dùng yêu cầu) — trang *Hệ thống › Tính chất in*.
//   · `LUONG`    : các luồng (nguồn duy nhất, không FK). ⚠ `luong` HIỆN CHỈ LÀ PHÂN LOẠI: chưa có chỗ nào đọc nó để đổi cách
//                  chạy. Làm xong luồng nào thì bật `da_lam` của luồng đó — giao diện đọc cờ này để ghi "đang đi luồng gì".
//   · `tapBoQua` : tập tính chất bị BỎ QUA khi đồng bộ ERP, đọc từ bảng mỗi lượt đồng bộ.
//
// ⚠ Hướng an toàn: thiếu bảng (chưa chạy mig) / lỗi đọc / bảng rỗng ⇒ lùi về `BO_QUA_MAC_DINH` (danh sách đã chạy trước đây),
//   KHÔNG coi là "không bỏ qua gì" — nếu không 1 lần lỗi đọc là hàng ép / kiếng / logo tràn vào MES.
// ─────────────────────────────────────────────────────────────────────────────
const { query } = require('../config/db');

const LUONG = [
  { ma: 'THUONG', ten: 'In thường', da_lam: true },
  { ma: 'IN_KIENG', ten: 'In kiếng', da_lam: false },
  { ma: 'IN_EP', ten: 'In + ép', da_lam: false },
  { ma: 'LOGO', ten: 'Logo', da_lam: false },
  { ma: 'CHUA_PHAN_LOAI', ten: 'Chưa phân loại', da_lam: false },
];
const MA_LUONG = new Set(LUONG.map((l) => l.ma));

// Danh sách bỏ qua dự phòng — ĐÚNG hằng `BO_TINH_CHAT_IN` trước mig 123 (cũng là dữ liệu ban đầu `bo_qua = true` của bảng).
const BO_QUA_MAC_DINH_RAW = [
  'C+EP DECAL', 'C+KIENG UI', 'DANKEO', 'DQ+EP DINH', 'DQ+EP KIENG', 'DQ+EP LUN', 'EP DC', 'EP DECAL',
  'EP DIEN', 'EP DINH', 'EP DINH+LS', 'EP DQ', 'EP GAI XU', 'EP KEO', 'EP KIENG', 'EP LUN', 'EP LUN NHUA',
  'EP LUN PHOI', 'EP LUN+EP NOI', 'EP NHIET', 'EP NHUA MAU', 'EP NHUNG', 'EP NOI', 'EP NOI SLC', 'EP NONG',
  'EP NONG+LS', 'EP PET', 'EP PHOI', 'IN EP NHUNG', 'IN EP PHOI', 'KIENG UI', 'KIENG UI BONG', 'KIENG UI DQ',
  'KIENG UI DQ+DQ', 'KIENG UI DQ+EP K', 'KIENG UI+KBONG', 'KIENGUICAO', 'LAZE+EP KIENG', 'LG', 'LG BONG',
  'LG EP', 'LG MO', 'LG+EP NHUA', 'LS', 'LS+EP KIENG', 'RC+REP DC', 'RDQ+EP LUN', 'REP DECAL', 'REP DIEN',
  'REP DINH', 'REP DQ', 'REP GAI XU', 'REP KEO', 'REP KIENG', 'REP LUN', 'REP LUN NHUA', 'REP LUN+EP NOI',
  'REP NHIET', 'REP NHUA MAU', 'REP NHUNG', 'REP NOI', 'REP NOI SLC', 'REP NONG', 'REP PHOI', 'REP UI',
  'RIN EP NHUNG', 'RIN EP PHOI', 'RKIENG UI', 'RKIENG UI BONG', 'RKIENG UI DQ', 'RKIENG UI DQ+EP K',
  'RKIENG UI+KBONG', 'RLAZE+EP KIENG', 'RLG', 'RLG EP', 'RLG+EP NHUA', 'RLS', 'RLS+EP KIENG', 'RT+EP DC',
  'RT+EP DIEN', 'RT+EP DINH', 'RT+EP LUN', 'RT+EP LUN PHOI', 'RT+EP NHUNG', 'RT+EP NOI', 'RT+EP NONG',
  'RT+EP PHOI', 'RT+EP UI', 'RT+KIENG UI', 'RT+KIENG UI DQ', 'RT+LG EP', 'RTB+EP DINH', 'RTB+EP NHIET',
  'T+DQ+EPLUN', 'T+EP DC', 'T+EP DIEN', 'T+EP DINH', 'T+EP KIENG', 'T+EP LUN', 'T+EP LUN PHOI', 'T+EP LUN+LS',
  'T+EP NHUNG', 'T+EP NOI', 'T+EP NONG', 'T+EP PHOI', 'T+EP UI', 'T+KIENG UI', 'T+KIENG UI DQ', 'T+LG EP',
  'T+LS', 'TB+EP DINH', 'TB+EP NHIET', 'TB+KIENGUIBONG', 'IN KIENG DQ',
];

// So khớp sau khi bỏ hết khoảng trắng + viết hoa ⇒ "C + EP DECAL" == "C+EP DECAL". Gương SQL: `MA_TCIN_SQL`.
const normTcin = (v) => String(v == null ? '' : v).toUpperCase().replace(/\s+/g, '');
const MA_TCIN_SQL = (cot) => `upper(regexp_replace(${cot}, '\\s+', '', 'g'))`;
const BO_QUA_MAC_DINH = new Set(BO_QUA_MAC_DINH_RAW.map(normTcin));

// Tập `ma_chuan` đang bỏ qua. KHÔNG bao giờ ném lỗi (đồng bộ ERP gọi đầu mỗi lượt).
async function tapBoQua() {
  try {
    const { rows } = await query('SELECT ma_chuan, bo_qua FROM tinh_chat_in WHERE dang_hoat_dong');
    if (!rows.length) return new Set(BO_QUA_MAC_DINH);
    return new Set(rows.filter((r) => r.bo_qua).map((r) => r.ma_chuan));
  } catch (e) {
    if (e.code !== '42P01') console.error(`[tinh-chat-in] ✗ Đọc danh mục lỗi, dùng danh sách mặc định: ${e.message}`);
    return new Set(BO_QUA_MAC_DINH);
  }
}

module.exports = { LUONG, MA_LUONG, BO_QUA_MAC_DINH_RAW, BO_QUA_MAC_DINH, normTcin, MA_TCIN_SQL, tapBoQua };
