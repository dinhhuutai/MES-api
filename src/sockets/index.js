'use strict';

let ioRef = null;

function init(io) {
  ioRef = io;
  io.on('connection', (socket) => {
    console.log(`[socket] client kết nối: ${socket.id}`);
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
