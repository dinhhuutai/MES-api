'use strict';

const { verify } = require('../utils/jwt');
const { fail } = require('../utils/response');

// Xác thực JWT từ header Authorization: Bearer <token>.
// Gắn req.user = { id, username, roles, permissions }.
module.exports = function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return fail(res, 'Chưa đăng nhập', 'UNAUTHENTICATED', [], 401);
  }
  try {
    const payload = verify(token);
    req.user = {
      id: payload.sub,
      username: payload.username,
      roles: payload.roles || [],
      permissions: payload.permissions || [],
    };
    return next();
  } catch (err) {
    return fail(res, 'Token không hợp lệ hoặc đã hết hạn', 'INVALID_TOKEN', [], 401);
  }
};
