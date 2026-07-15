'use strict';

const service = require('./manualentry.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');

const khach = asyncHandler(async (req, res) => ok(res, await service.searchKhach(req.query.q)));
const don = asyncHandler(async (req, res) => ok(res, await service.searchDon(req.query.khachId, req.query.q)));
const maHang = asyncHandler(async (req, res) => ok(res, await service.searchMaHang(req.query.donId, req.query.q)));
const loaiDotVai = asyncHandler(async (req, res) => ok(res, await service.listLoaiDotVai()));

const create = asyncHandler(async (req, res) => {
  const data = await service.createChain(req.body, req.user.id);
  return ok(res, data, `Đã tạo phần in ${data.ma_phan} với ${data.dot_vai.length} đợt vải`);
});

module.exports = { khach, don, maHang, loaiDotVai, create };
