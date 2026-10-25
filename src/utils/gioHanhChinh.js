'use strict';

// GIỜ HÀNH CHÍNH 07:30 → 16:30 giờ VN (25/10/2026, người dùng chốt — Test Run): NGOÀI giờ này QA xác nhận đạt /
// In không đạt thì Release 2 LUÔN (không chờ Kế hoạch duyệt). Chỉ xét GIỜ trong ngày, không xét thứ.
// Gương FE `frontend/src/utils/gioHanhChinh.js` — sửa cả hai.
const BD_PHUT = 7 * 60 + 30;
const KT_PHUT = 16 * 60 + 30;

function phutTrongNgayVN(d = new Date()) {
  const vn = new Date(new Date(d).getTime() + 7 * 3600 * 1000);
  return vn.getUTCHours() * 60 + vn.getUTCMinutes();
}

const trongGioHanhChinh = (d = new Date()) => {
  const p = phutTrongNgayVN(d);
  return p >= BD_PHUT && p < KT_PHUT;
};

module.exports = { trongGioHanhChinh, phutTrongNgayVN, BD_PHUT, KT_PHUT };
