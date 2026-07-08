'use strict';

const service = require('./delivery.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok, created } = require('../../utils/response');

const temSanSang = asyncHandler(async (req, res) => ok(res, await service.listTemSanSang(req.query.search || '', req.query.ngay || '')));
const list = asyncHandler(async (req, res) => ok(res, await service.listGiaoHang(req.query.search || '')));
const detail = asyncHandler(async (req, res) => ok(res, await service.getDetail(req.params.id)));
const create = asyncHandler(async (req, res) =>
  created(res, await service.createGiaoHang(req.body, req.user.id), 'Đã tạo phiếu giao'));
const confirm = asyncHandler(async (req, res) =>
  ok(res, await service.confirmGiao(req.params.id, req.user.id), 'Đã xác nhận giao — DONE DELIVERY'));

module.exports = { temSanSang, list, detail, create, confirm };
