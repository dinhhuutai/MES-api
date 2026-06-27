'use strict';

const service = require('./auth.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');

const login = asyncHandler(async (req, res) => {
  const { tenDangNhap, matKhau } = req.body;
  const data = await service.login(tenDangNhap, matKhau);
  return ok(res, data, 'Đăng nhập thành công');
});

const me = asyncHandler(async (req, res) => {
  const data = await service.me(req.user.id);
  return ok(res, data, 'OK');
});

// JWT stateless: logout xử lý phía client (xóa token). Endpoint để client gọi cho nhất quán.
const logout = asyncHandler(async (req, res) => {
  return ok(res, {}, 'Đã đăng xuất');
});

module.exports = { login, me, logout };
