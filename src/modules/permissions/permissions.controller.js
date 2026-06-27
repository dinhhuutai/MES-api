'use strict';

const repo = require('./permissions.repository');
const AppError = require('../../utils/AppError');
const asyncHandler = require('../../utils/asyncHandler');
const { ok, created } = require('../../utils/response');

const list = asyncHandler(async (req, res) =>
  ok(res, await repo.list({ search: req.query.search || '', module: req.query.module || '' })));

const create = asyncHandler(async (req, res) => {
  if (await repo.existsCode(req.body.maPermission)) {
    throw new AppError('Mã permission đã tồn tại', { status: 409, errorCode: 'DUPLICATE' });
  }
  const id = await repo.create(req.body, req.user.id);
  return created(res, { id });
});

const update = asyncHandler(async (req, res) => {
  await repo.update(req.params.id, req.body, req.user.id);
  return ok(res, {}, 'Đã cập nhật');
});

const setActive = asyncHandler(async (req, res) => {
  await repo.setActive(req.params.id, req.body.dangHoatDong === true, req.user.id);
  return ok(res, {}, 'Đã cập nhật trạng thái');
});

module.exports = { list, create, update, setActive };
