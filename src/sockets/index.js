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

// Emit sự kiện realtime (CLAUDE.md §22). Dùng ở service khi đổi trạng thái.
function emit(event, payload) {
  if (!KHONG_DOI_DU_LIEU.has(event)) tangPhienBan();
  if (ioRef) ioRef.emit(event, payload);
}

module.exports = { init, emit };
