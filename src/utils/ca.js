'use strict';

// Suy CA SẢN XUẤT từ giờ:phút (giờ VN) + loại ca của tuần.
//   NGAN: Ca 1 06-14 · Ca 2 14-22 · Ca 3 22-06
//   DAI : Ca 1 06-18 · Ca 2 18-06
//   HANH_CHINH: Hành chính 07:30-16:30 · tăng ca 16:30-20:00 (Hành chính (TC))
// Tuần chưa cài → coi như NGAN.
function caFromHour(gio, phut, loaiCa) {
  const h = Number(gio);
  const m = Number.isFinite(Number(phut)) ? Number(phut) : 0;
  if (!Number.isFinite(h)) return '';
  if (loaiCa === 'HANH_CHINH') {
    const t = h * 60 + m; // số phút kể từ 00:00
    if (t >= 16 * 60 + 30 && t < 20 * 60) return 'Hành chính (TC)'; // 16:30–20:00 tăng ca
    return 'Hành chính'; // 07:30–16:30 (và ngoài giờ vẫn coi là hành chính)
  }
  if (loaiCa === 'DAI') return (h >= 6 && h < 18) ? 'Ca 1' : 'Ca 2';
  if (h >= 6 && h < 14) return 'Ca 1';
  if (h >= 14 && h < 22) return 'Ca 2';
  return 'Ca 3';
}

// ----- LOẠI CA THEO TUẦN × LOẠI CHUYỀN (mig 112, 07/10/2026) -----
// `modeMap` (`planning.repository.caModeMap`): khóa `nam-tuan` = dòng CHUNG (mọi chuyền), `nam-tuan|MAY` =
// dòng RIÊNG của loại chuyền. Luật: đúng loại chuyền ⇒ CHUNG ⇒ NGAN. Chỉ Máy / Bàn / Robot cài riêng được —
// loại khác (Máy tròn, Logo, Ép, Gia công) luôn theo CHUNG. ⚠ Mọi chỗ suy ca PHẢI đi qua hàm này.
const LOAI_CHUYEN_CA = ['MAY', 'BAN', 'ROBOT'];
function loaiCaCua(modeMap, khoaTuan, loaiChuyen) {
  if (!modeMap) return 'NGAN';
  const lc = String(loaiChuyen || '').toUpperCase();
  return (lc && modeMap.get(`${khoaTuan}|${lc}`)) || modeMap.get(khoaTuan) || 'NGAN';
}

// Suy ca từ các giá trị đã EXTRACT ở SQL (giờ/phút/năm/tuần theo VN) + map cấu hình tuần (+ loại chuyền).
function caFromParts(gio, phut, nam, tuan, modeMap, loaiChuyen = null) {
  return caFromHour(gio, phut, loaiCaCua(modeMap, `${nam}-${tuan}`, loaiChuyen));
}

// ----- MÃ NGÀY CA (mig 068) — chuỗi gợi ý sẵn ở màn Sản xuất, người dùng sửa được -----
// Dạng: YYMMDD + mã ca → `260805D2` (05/08/2026, ca Dài 2) · `260805C2` (ca Ngắn 2) · `260805HC`.
// Mốc giờ của từng ca lấy CHUNG từ `caFromHour` (đừng chép lại boundary ở đây — lệch là sai ca).
const CA_SO = { 'Ca 1': '1', 'Ca 2': '2', 'Ca 3': '3' };
function maCa(gio, phut, loaiCa) {
  const label = caFromHour(gio, phut, loaiCa);
  if (!label) return '';
  if (label.startsWith('Hành chính')) return 'HC'; // gộp cả ca tăng ca 16:30–20:00
  const so = CA_SO[label];
  return so ? (loaiCa === 'DAI' ? 'D' : 'C') + so : '';
}

// `ymd` = 'YYMMDD' (backend lấy sẵn từ SQL theo giờ VN — đừng tự new Date() ở JS vì server có thể
// không chạy múi giờ VN). Trả '' nếu thiếu ngày.
function maNgayCa(ymd, gio, phut, loaiCa) {
  if (!ymd) return '';
  return `${ymd}${maCa(gio, phut, loaiCa)}`;
}

// Tách phần NGÀY của mã ngày ca → 'YYYY-MM-DD' để ghi vào cột `tem.ngay_ca` (DATE, mig 066).
// Người dùng gõ sai định dạng → null (vẫn lưu nguyên chuỗi vào `ma_ngay_ca`, KHÔNG bịa ngày).
function ngayTuMaNgayCa(ma) {
  const s = String(ma || '').trim();
  const m = /^(\d{2})(\d{2})(\d{2})/.exec(s);
  if (!m) return null;
  const [, yy, mm, dd] = m;
  const thang = Number(mm); const ngay = Number(dd);
  if (thang < 1 || thang > 12 || ngay < 1 || ngay > 31) return null;
  return `20${yy}-${mm}-${dd}`;
}

// GIỜ BẮT ĐẦU của ca chứa (gio, phut) — 'HH:MM'. Dùng làm gợi ý "Từ giờ" khi hôm nay chưa có mốc nào
// (30/09/2026). Ca 3 / Ca Dài 2 bắt đầu TỐI HÔM TRƯỚC khi giờ hiện tại đã qua nửa đêm — vẫn trả giờ
// bắt đầu (22:00 / 18:00); luật cộng ngày cho ca đêm ở `production.repository.duLieuGhiInTem`.
const BAT_DAU = { NGAN: { 'Ca 1': '06:00', 'Ca 2': '14:00', 'Ca 3': '22:00' }, DAI: { 'Ca 1': '06:00', 'Ca 2': '18:00' } };
function gioBatDauCa(gio, phut, loaiCa) {
  const label = caFromHour(gio, phut, loaiCa);
  if (label === 'Hành chính (TC)') return '16:30';
  if (label === 'Hành chính') return '07:30';
  return (BAT_DAU[loaiCa === 'DAI' ? 'DAI' : 'NGAN'] || {})[label] || '';
}

// Tuần ISO của 1 ngày 'YYYY-MM-DD' → khóa `nam-tuan` của `cai_dat_ca_tuan` (dùng chung Báo cáo SX / dừng chuyền
// / ngày ca kế hoạch). Tính bằng Date.UTC ⇒ không phụ thuộc múi giờ máy chủ.
function khoaTuanIso(ngay) {
  const [y, m, d] = String(ngay).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const thu = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - thu);
  const dauNam = Date.UTC(t.getUTCFullYear(), 0, 1);
  const tuan = Math.ceil(((t.getTime() - dauNam) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-${tuan}`;
}

// ----- NGÀY CA CỦA KẾ HOẠCH LỆNH (07/10/2026 — `@pNgayca` của proc `MES_spr_MES21X0`, API Release 1) -----
// Cùng định dạng mã ngày ca của tem: YYMMDD + mã ca (C1/C2/C3 ca Ngắn · D1/D2 ca Dài · HC hành chính), vd ca
// Ngắn 2 ngày 20/09/2026 ⇒ `260920C2`. Ca suy từ GIỜ BẮT ĐẦU kế hoạch (`Tugio`) theo loại ca của TUẦN ISO
// (Kế hoạch › Cài đặt ca sản xuất; tuần chưa cài ⇒ Ngắn) — dùng chung `maCa`, không chép mốc giờ.
// ⚠ NGÀY SX = ca BẮT ĐẦU trong ngày: 06:00 D → 06:00 D+1 (cùng quy ước Báo cáo sản xuất + luật `Dengio` +1
//   ngày của ca đêm) ⇒ kế hoạch bắt đầu 02:00 ngày 21/09 (ca 3 / ca Dài 2 qua nửa đêm) là `260920C3`.
// Thiếu giờ bắt đầu ⇒ `YYMMDD` trần của ngày kế hoạch (không bịa ca); thiếu cả ngày ⇒ ''.
// `tuGio` / `ngayKeHoach`: chuỗi GIỜ VN 'YYYY/MM/DD HH:mm:ss' | 'YYYY-MM-DD[ T]HH:mm[:ss]' (chỉ đọc chữ số,
//   không qua Date của máy chủ). `modeMap` = `planning.repository.caModeMap` · `loaiChuyen` = mã loại chuyền
//   của lệnh (mig 112 — tuần có cài riêng cho Máy/Bàn/Robot).
function ngayCaKeHoach(tuGio, ngayKeHoach, modeMap, loaiChuyen = null) {
  const tach = (v) => /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2}))?/.exec(String(v || '').trim());
  const p2 = (n) => String(n).padStart(2, '0');
  const ymd = (y, m, d) => `${String(y).slice(2)}${p2(m)}${p2(d)}`;
  const g = tach(tuGio);
  if (g && g[4] != null) {
    const gio = Number(g[4]); const phut = Number(g[5]);
    // Lùi 6 giờ để ra NGÀY SX (giờ 00:00–05:59 thuộc ca đêm của hôm trước).
    const t = new Date(Date.UTC(+g[1], +g[2] - 1, +g[3], gio, phut) - 6 * 3600 * 1000);
    const ngaySx = `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}`;
    const loai = loaiCaCua(modeMap, khoaTuanIso(ngaySx), loaiChuyen);
    return `${ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())}${maCa(gio, phut, loai)}`;
  }
  const n = tach(ngayKeHoach) || g;
  return n ? ymd(n[1], n[2], n[3]) : '';
}

module.exports = {
  caFromHour, caFromParts, maCa, maNgayCa, ngayTuMaNgayCa, gioBatDauCa, khoaTuanIso, ngayCaKeHoach,
  loaiCaCua, LOAI_CHUYEN_CA,
};
