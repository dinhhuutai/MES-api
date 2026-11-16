'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// DANH MỤC TÍNH CHẤT IN (mig 123, 04/11/2026, người dùng yêu cầu) — trang *Hệ thống › Tính chất in*.
//   · `LUONG`    : các luồng (nguồn duy nhất, không FK). Luồng nào đã làm thì `da_lam` = true — giao diện đọc cờ này để
//                  ghi "đang đi luồng gì". Luồng chạy thật của PHẦN IN nằm ở `phan_in.luong_sx` (`utils/luongSanXuat.js`).
//   · `tapBoQua` : tập tính chất bị BỎ QUA khi đồng bộ ERP, đọc từ bảng mỗi lượt đồng bộ.
//
// ⚠ Hướng an toàn: thiếu bảng (chưa chạy mig) / lỗi đọc / bảng rỗng ⇒ lùi về `BO_QUA_MAC_DINH` (danh sách đã chạy trước đây),
//   KHÔNG coi là "không bỏ qua gì" — nếu không 1 lần lỗi đọc là hàng ép / kiếng / logo tràn vào MES.
// ─────────────────────────────────────────────────────────────────────────────
const { query } = require('../config/db');

// ⚠⚠ 4 CÔNG ĐOẠN **In · In kiếng · Logo · Ép** (16/11/2026, người dùng chốt "tách toggle logo với ép ra lại" — bản 14/11 gộp
//   Ép/Logo 1 công tắc). Mỗi tính chất in = TỔ HỢP công đoạn; số công đoạn của phần in = số công tắc bật. Trang *Tính chất in*
//   bật/tắt 4 công tắc; cột `luong` của bảng LƯU MÃ CỦA TỔ HỢP (bảng dưới — 1–1, không cần migration). Phần in mới nhận
//   `phan_in.luong_sx` theo `luongSxTheoPhanLoai` (`utils/luongSanXuat.js`).
//   · Logo và Ép đều là công đoạn loại ép (`luong_sx` LOGO 1 công đoạn · IN_EP / IN_KIENG phần ép `EP_UI`) — tách công tắc để
//     biết công đoạn là Logo hay Ép (nhãn, đối chiếu loaikd: 2I = đơn logo + ép, kiếng ủi 3I = Ép).
//   · `sx` = luồng chạy của phần in. Tổ hợp CHƯA có luồng sản xuất (In + In kiếng, Logo + Ép, ≥ 3 công đoạn) ⇒ `tam: true`,
//     tạm chạy luồng ghi ở `sx` (trang hiện cảnh báo).
//   · Mã cũ giữ nghĩa: `LOGO` nay = chỉ Logo (bản 14/11 = "Ép/Logo"), `IN_EP` = In + Ép, `IN_KIENG` = In kiếng + Ép (kiếng
//     ủi), `BA_CONG_DOAN` = In + In kiếng + Ép — tính chất ép cũ đang mã `LOGO` phải chuyển sang `EP` bằng script
//     `database/scripts/tinh_chat_in_tach_logo_ep_1611.sql` (luồng sản xuất không đổi).
//   · `KHAC` (cũ, "nhóm khác chưa làm") không còn chọn được — đọc như chưa phân loại.
const CD_KHOA = ['in', 'kieng', 'logo', 'ep'];
const CD_TEN = { in: 'In', kieng: 'In kiếng', logo: 'Logo', ep: 'Ép' };
const cdDu = (cd) => Object.fromEntries(CD_KHOA.map((k) => [k, !!(cd && cd[k])]));
const LUONG_DAT_TEN = [
  { ma: 'THUONG', ten: 'In', cd: { in: true }, sx: 'THUONG' },
  { ma: 'KIENG_KHONG_EP', ten: 'In kiếng', cd: { kieng: true }, sx: 'KIENG_KHONG_EP' },
  { ma: 'LOGO', ten: 'Logo', cd: { logo: true }, sx: 'LOGO' },
  { ma: 'EP', ten: 'Ép', cd: { ep: true }, sx: 'LOGO' },
  { ma: 'IN_EP', ten: 'In + Ép', cd: { in: true, ep: true }, sx: 'IN_EP' },
  { ma: 'IN_LOGO', ten: 'In + Logo', cd: { in: true, logo: true }, sx: 'IN_EP' },
  { ma: 'IN_KIENG', ten: 'In kiếng + Ép (kiếng ủi)', cd: { kieng: true, ep: true }, sx: 'IN_KIENG' },
  { ma: 'KIENG_LOGO', ten: 'In kiếng + Logo', cd: { kieng: true, logo: true }, sx: 'IN_KIENG' },
  { ma: 'LOGO_EP', ten: 'Logo + Ép', cd: { logo: true, ep: true }, sx: 'LOGO', tam: true },
  { ma: 'IN_VA_KIENG', ten: 'In + In kiếng', cd: { in: true, kieng: true }, sx: 'KIENG_KHONG_EP', tam: true },
  { ma: 'BA_CONG_DOAN', ten: 'In + In kiếng + Ép', cd: { in: true, kieng: true, ep: true }, sx: 'IN_KIENG', tam: true },
];
const khoaCd = (cd) => CD_KHOA.map((k) => (cd && cd[k] ? 1 : 0)).join('');
// ⚠⚠ KHÔNG CÓ CÔNG ĐOẠN "IN RỒI ÉP" (17/11/2026, người dùng chốt: "sẽ không có công đoạn in rồi ép, nên không có 3I là ép với
//   in"): tổ hợp bật CẢ In VÀ (Logo hoặc Ép) không dùng — trang Tính chất in chặn lưu (422 `KHONG_IN_ROI_EP`), dòng cũ hiện cảnh
//   báo để người dùng tự chọn lại công tắc. Kiếng ủi = In kiếng + Ép (không bật In). Luồng `IN_EP` còn trong code cho dữ liệu cũ.
const khongInRoiEp = (cd) => !!(cd && cd.in && (cd.logo || cd.ep));
// Luồng sản xuất tạm cho tổ hợp chưa đặt tên (≥ 3 công đoạn…): có kiếng ⇒ kiếng (+ ép nếu có loại ép); có In + loại ép ⇒ IN_EP…
function sxTam(cd) {
  const ep = cd.logo || cd.ep;
  if (cd.kieng) return ep ? 'IN_KIENG' : 'KIENG_KHONG_EP';
  if (cd.in) return ep ? 'IN_EP' : 'THUONG';
  return ep ? 'LOGO' : 'THUONG';
}
const LUONG = (() => {
  const daCo = new Map(LUONG_DAT_TEN.map((l) => [khoaCd(l.cd), l]));
  const out = LUONG_DAT_TEN.map((l) => ({ ...l, cd: cdDu(l.cd), da_lam: true, tam: !!l.tam, khong_dung: khongInRoiEp(l.cd) }));
  for (let n = 1; n < 16; n += 1) { // tổ hợp còn lại (tên ghép, mã `CD_<4 bit>`) — để công tắc nào bật cũng lưu được
    const cd = Object.fromEntries(CD_KHOA.map((k, i) => [k, !!(n & (8 >> i))]));
    if (daCo.has(khoaCd(cd))) continue;
    out.push({ ma: `CD_${khoaCd(cd)}`, ten: CD_KHOA.filter((k) => cd[k]).map((k) => CD_TEN[k]).join(' + '), cd, sx: sxTam(cd), da_lam: true, tam: true,
      khong_dung: khongInRoiEp(cd) });
  }
  out.push({ ma: 'CHUA_PHAN_LOAI', ten: 'Chưa phân loại', cd: cdDu({}), sx: 'THUONG', da_lam: false, tam: false });
  return out;
})();
const MA_LUONG = new Set(LUONG.map((l) => l.ma));
const THEO_MA = new Map(LUONG.map((l) => [l.ma, l]));
const THEO_CD = new Map(LUONG.map((l) => [khoaCd(l.cd), l.ma]));
// Mã luồng phân loại của 1 tổ hợp công đoạn `{ in, kieng, logo, ep }`.
const luongTuCongDoan = (cd) => THEO_CD.get(khoaCd(cdDu(cd)));
// Tổ hợp có công đoạn loại ép (Logo hoặc Ép) — cột "Kỹ thuật Ép/Logo" / "Xác nhận HSKT" chỉ có nghĩa với tổ hợp này.
const coCongDoanEp = (cd) => !!(cd && (cd.ep || cd.logo));
// Tổ hợp công đoạn của 1 mã luồng phân loại (mã lạ / KHAC ⇒ không công đoạn nào).
const congDoanCuaLuong = (ma) => ({ ...(THEO_MA.get(ma) || THEO_MA.get('CHUA_PHAN_LOAI')).cd });
// Luồng SẢN XUẤT của phần in ứng với 1 mã phân loại (chưa phân loại / mã lạ ⇒ in thường).
const luongSxTheoPhanLoai = (ma) => (THEO_MA.get(ma) || THEO_MA.get('CHUA_PHAN_LOAI')).sx;

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

module.exports = {
  LUONG, MA_LUONG, BO_QUA_MAC_DINH_RAW, BO_QUA_MAC_DINH, normTcin, MA_TCIN_SQL, tapBoQua,
  luongTuCongDoan, congDoanCuaLuong, luongSxTheoPhanLoai, coCongDoanEp, CD_KHOA, CD_TEN, khongInRoiEp,
};
