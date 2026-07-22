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

module.exports = { caFromHour, caFromParts };
