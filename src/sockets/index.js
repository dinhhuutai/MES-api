'use strict';

const presence = require('./presence');
const { tangPhienBan } = require('../utils/cacheDoc');

// Sự kiện KHÔNG đổi dữ liệu dòng chảy ⇒ không xóa cache đọc. Mọi sự kiện khác (kể cả của job nền ghi không qua
// HTTP: đồng bộ ERP, tem phơi xong…) đều xóa — xem `utils/cacheDoc.js`.
const KHONG_DOI_DU_LIEU = new Set(['presence:updated', 'thong-bao:moi', 'phien:dang-xuat']);

let ioRef = null;

function init(io) {
  ioRef = io;
  io.on('connection', (socket) => {
    // Không log kết nối/ngắt: transport polling kết nối lại liên tục ⇒ chỉ làm nhiễu log PM2.
    presence.register(io, socket); // theo dõi online + lịch sử điều hướng
  });
}

// ⚠⚠ GOM SỰ KIỆN "TẢI LẠI" (19/11/2026, người dùng: "tích ~20 tem là xoay"): mỗi tem lưu bắn 1 `quality:updated` +
//   `dashboard:refresh` ⇒ MỌI máy đang mở KCS / Sửa / OQC / báo cáo / dashboard tải lại danh sách nặng 20 lần liền ⇒ DB
//   nghẽn, chính lượt lưu kế tiếp cũng chậm theo. 2 sự kiện này FE chỉ dùng để TẢI LẠI (không đọc nội dung — đã rà
//   `useSocketReload` / `.on` 19/11) ⇒ gom: bắn ngay lần đầu, trong `GOM_MS` sau đó chỉ bắn thêm ĐÚNG 1 lần ở cuối.
//   Cache đọc (`tangPhienBan`) vẫn xóa NGAY mỗi lần. Sự kiện có nội dung được đọc (vd `production:updated` — RunPanel
//   lọc theo `lenhId`) KHÔNG được thêm vào đây.
const GOM_MS = { 'quality:updated': 1500, 'dashboard:refresh': 1500 };
const gom = {}; // event → { luc, hen, payload }

function phat(event, payload) { if (ioRef) ioRef.emit(event, payload); }

// Emit sự kiện realtime (CLAUDE.md §22). Dùng ở service khi đổi trạng thái.
function emit(event, payload) {
  if (!KHONG_DOI_DU_LIEU.has(event)) tangPhienBan();
  const ms = GOM_MS[event];
  if (!ms) { phat(event, payload); return; }
  const g = gom[event] || (gom[event] = { luc: 0, hen: null, payload: null });
  const bayGio = Date.now();
  if (!g.hen && bayGio - g.luc >= ms) { g.luc = bayGio; phat(event, payload); return; }
  g.payload = payload;
  if (g.hen) return;
  g.hen = setTimeout(() => { g.hen = null; g.luc = Date.now(); phat(event, g.payload); }, Math.max(50, ms - (bayGio - g.luc)));
  if (g.hen.unref) g.hen.unref();
}

module.exports = { init, emit };
