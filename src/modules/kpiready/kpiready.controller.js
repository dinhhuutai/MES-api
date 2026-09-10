'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const service = require('./kpiready.service');

const duLieu = asyncHandler(async (req, res) => ok(res, await service.duLieu(req.query)));

const danhMucCot = asyncHandler(async (req, res) => ok(res, await service.danhMucCot()));

const dsDonHang = asyncHandler(async (req, res) => ok(res, await service.dsDonHangDeChon(req.query)));

const luuDonHang = asyncHandler(async (req, res) => ok(res,
  await service.luuDonHangChon(req.body, req.user && req.user.id), 'Đã lưu danh sách đơn hàng'));

module.exports = { duLieu, danhMucCot, dsDonHang, luuDonHang };
