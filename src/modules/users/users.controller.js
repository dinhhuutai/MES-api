'use strict';

const service = require('./users.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok, created } = require('../../utils/response');
const { getPaging } = require('../../utils/pagination');

const list = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  const active = req.query.active === undefined ? null : req.query.active === 'true';
  const data = await service.listUsers({ search: req.query.search || '', active, page, limit, offset });
  return ok(res, data);
});

// Chọn người cho combobox (owner...) — chỉ cần đăng nhập, xem users.routes.
const options = asyncHandler(async (req, res) =>
  ok(res, await service.listUserOptions({ search: req.query.search || '', limit: Number(req.query.limit) || 500 })));

const getOne = asyncHandler(async (req, res) => ok(res, await service.getUser(req.params.id)));

const create = asyncHandler(async (req, res) =>
  created(res, await service.createUser(req.body, req.user.id))
);

const update = asyncHandler(async (req, res) =>
  ok(res, await service.updateUser(req.params.id, req.body, req.user.id), 'Đã cập nhật')
);

const setActive = asyncHandler(async (req, res) =>
  ok(res, await service.setActive(req.params.id, req.body.dangHoatDong === true, req.user.id), 'Đã cập nhật trạng thái')
);

const resetPassword = asyncHandler(async (req, res) => {
  await service.resetPassword(req.params.id, req.body.matKhauMoi, req.user.id);
  return ok(res, {}, 'Đã đặt lại mật khẩu');
});

const setRoles = asyncHandler(async (req, res) =>
  ok(res, await service.setRoles(req.params.id, req.body.roleIds || [], req.user.id), 'Đã cập nhật vai trò')
);

module.exports = { list, options, getOne, create, update, setActive, resetPassword, setRoles };
