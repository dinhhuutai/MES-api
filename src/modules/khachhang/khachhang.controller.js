'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const { getPaging } = require('../../utils/pagination');
const service = require('./khachhang.service');

const list = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  return ok(res, await service.danhSach({ search: req.query.search || '', page, limit, offset }));
});

const update = asyncHandler(async (req, res) =>
  ok(res, await service.capNhat(req.params.id, req.body, req.user.id), 'Đã lưu thông tin khách hàng'));

module.exports = { list, update };
