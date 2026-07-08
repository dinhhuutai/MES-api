'use strict';

// Suy CA SẢN XUẤT từ giờ (0-23, giờ VN) + loại ca của tuần.
//   NGAN: Ca 1 06-14 · Ca 2 14-22 · Ca 3 22-06
//   DAI : Ca 1 06-18 · Ca 2 18-06
// Tuần chưa cài → coi như NGAN.
function caFromHour(gio, loaiCa) {
  const h = Number(gio);
  if (!Number.isFinite(h)) return '';
  if (loaiCa === 'DAI') return (h >= 6 && h < 18) ? 'Ca 1' : 'Ca 2';
  if (h >= 6 && h < 14) return 'Ca 1';
  if (h >= 14 && h < 22) return 'Ca 2';
  return 'Ca 3';
}

// Suy ca từ 3 giá trị đã EXTRACT ở SQL (giờ/năm/tuần theo VN) + map cấu hình tuần.
function caFromParts(gio, nam, tuan, modeMap) {
  const mode = (modeMap && modeMap.get(`${nam}-${tuan}`)) || 'NGAN';
  return caFromHour(gio, mode);
}

module.exports = { caFromHour, caFromParts };
