'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const { getPaging } = require('../../utils/pagination');
const service = require('./caidatapi.service');

const list = asyncHandler(async (req, res) => ok(res, { items: await service.danhSach() }));

const save = asyncHandler(async (req, res) =>
  ok(res, { items: await service.luu(req.body?.items, req.user.id) }, 'Đã lưu cài đặt API'));

const thu = asyncHandler(async (req, res) => ok(res, await service.thuKetNoi(req.params.ma)));

// Lịch sử gọi API (lấy mã tem / báo ERP in tem) — lọc ngày + tìm theo IDMES hoặc mã tem.
const lichSu = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  return ok(res, await service.lichSu(req.params.ma, {
    date: req.query.date || '', search: req.query.search || '', page, limit, offset,
  }));
});

module.exports = { list, save, thu, lichSu };
