'use strict';

const presence = require('./presence');

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
  if (ioRef) ioRef.emit(event, payload);
}

module.exports = { init, emit };
