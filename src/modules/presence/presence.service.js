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

// Nhật ký thao tác toàn hệ thống (gộp nhiều nguồn) — phân trang.
function activity({ date, userId, loai, search, page = 1, limit = 50 }) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const pg = Math.max(Number(page) || 1, 1);
  return repo.listActivity({ date, userId, loai, search, limit: lim, offset: (pg - 1) * lim })
    .then((r) => ({ ...r, page: pg, limit: lim }));
}

module.exports = { getOnline, history, activity };
