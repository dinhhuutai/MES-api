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

const updateProfile = asyncHandler(async (req, res) => {
  const data = await service.updateProfile(req.user.id, req.body);
  return ok(res, data, 'Đã cập nhật thông tin cá nhân');
});

const uploadAvatar = asyncHandler(async (req, res) => {
  const data = await service.uploadAvatar(req.user.id, req.file);
  return ok(res, data, 'Đã cập nhật ảnh đại diện');
});

const resetAvatar = asyncHandler(async (req, res) => {
  const data = await service.resetAvatar(req.user.id);
  return ok(res, data, 'Đã đặt lại ảnh mặc định');
});

const changePassword = asyncHandler(async (req, res) => {
  const data = await service.changePassword(req.user.id, req.body.matKhauCu, req.body.matKhauMoi);
  return ok(res, data, 'Đã đổi mật khẩu');
});

// JWT stateless: logout xử lý phía client (xóa token). Endpoint để client gọi cho nhất quán.
const logout = asyncHandler(async (req, res) => {
  return ok(res, {}, 'Đã đăng xuất');
});

module.exports = { login, me, updateProfile, uploadAvatar, resetAvatar, changePassword, logout };
