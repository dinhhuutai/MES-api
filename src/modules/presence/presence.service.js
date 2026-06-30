'use strict';

const repo = require('./presence.repository');
const presenceSocket = require('../../sockets/presence');

// Danh sách user đang online (từ bộ nhớ socket).
function getOnline() {
  return presenceSocket.getOnline();
}

// Lịch sử điều hướng theo ngày.
function history({ date, userId, limit }) {
  return repo.listHistory({ date, userId, limit: limit || 500 });
}

module.exports = { getOnline, history };
