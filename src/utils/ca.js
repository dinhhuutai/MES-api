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

// Suy ca từ các giá trị đã EXTRACT ở SQL (giờ/phút/năm/tuần theo VN) + map cấu hình tuần.
function caFromParts(gio, phut, nam, tuan, modeMap) {
  const mode = (modeMap && modeMap.get(`${nam}-${tuan}`)) || 'NGAN';
  return caFromHour(gio, phut, mode);
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

module.exports = { caFromHour, caFromParts, maCa, maNgayCa, ngayTuMaNgayCa };
