'use strict';

// Theo dõi người dùng ONLINE thời gian thực + ghi LỊCH SỬ ĐIỀU HƯỚNG.
// Trạng thái online giữ trong bộ nhớ (Map theo socket); lịch sử điều hướng ghi DB.

const { verify } = require('../utils/jwt');
const repo = require('../modules/presence/presence.repository');

// socketId -> { userId, hoTen, username, page, title, ip, since, lastSeen }
const sockets = new Map();

function clientIp(socket) {
  const xf = socket.handshake.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return socket.handshake.address || null;
}

// Danh sách online gộp theo user (1 user có thể mở nhiều tab).
function getOnline() {
  const byUser = new Map();
  for (const s of sockets.values()) {
    const cur = byUser.get(s.userId);
    if (!cur) {
      byUser.set(s.userId, {
        userId: s.userId, hoTen: s.hoTen, username: s.username,
        page: s.page, title: s.title, ip: s.ip,
        since: s.since, lastSeen: s.lastSeen, soTab: 1,
      });
    } else {
      cur.soTab += 1;
      if (s.lastSeen > cur.lastSeen) { cur.lastSeen = s.lastSeen; cur.page = s.page; cur.title = s.title; }
      if (s.since < cur.since) cur.since = s.since;
    }
  }
  return Array.from(byUser.values()).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}

function register(io, socket) {
  // Client gửi token + trang hiện tại để xác thực và bật theo dõi.
  socket.on('presence:hello', async ({ token, path, title, hoTen } = {}) => {
    let payload;
    try { payload = verify(token); } catch { return; } // token sai → bỏ qua, không theo dõi
    const now = Date.now();
    sockets.set(socket.id, {
      userId: payload.sub,
      hoTen: hoTen || payload.username, // danh tính lấy từ token; tên hiển thị do client gửi
      username: payload.username,
      page: path || null, title: title || null, ip: clientIp(socket),
      since: now, lastSeen: now,
    });
    io.emit('presence:updated', {});
    if (path) {
      try { await repo.insertNav({ userId: payload.sub, duongDan: path, tieuDe: title, ip: clientIp(socket) }); }
      catch (e) { console.error('[presence] ghi nav lỗi:', e.message); }
    }
  });

  // Client báo đổi trang.
  socket.on('presence:page', async ({ path, title } = {}) => {
    const s = sockets.get(socket.id);
    if (!s) return; // chưa hello (chưa xác thực)
    s.page = path || s.page; s.title = title || null; s.lastSeen = Date.now();
    io.emit('presence:updated', {});
    if (path) {
      try { await repo.insertNav({ userId: s.userId, duongDan: path, tieuDe: title, ip: s.ip }); }
      catch (e) { console.error('[presence] ghi nav lỗi:', e.message); }
    }
  });

  socket.on('disconnect', () => {
    if (sockets.delete(socket.id)) io.emit('presence:updated', {});
  });
}

module.exports = { register, getOnline };
