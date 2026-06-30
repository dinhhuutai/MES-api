'use strict';

const presence = require('./presence');

let ioRef = null;

function init(io) {
  ioRef = io;
  io.on('connection', (socket) => {
    console.log(`[socket] client kết nối: ${socket.id}`);
    presence.register(io, socket); // theo dõi online + lịch sử điều hướng
    socket.on('disconnect', () => {
      console.log(`[socket] client ngắt: ${socket.id}`);
    });
  });
}

// Emit sự kiện realtime (CLAUDE.md §22). Dùng ở service khi đổi trạng thái.
function emit(event, payload) {
  if (ioRef) ioRef.emit(event, payload);
}

module.exports = { init, emit };
