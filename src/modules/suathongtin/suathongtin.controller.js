'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const service = require('./suathongtin.service');

const danhMuc = asyncHandler(async (req, res) => ok(res, service.danhMuc()));
const danhSach = asyncHandler(async (req, res) => ok(res, await service.danhSach(req.query)));
const chiTiet = asyncHandler(async (req, res) => ok(res, await service.chiTiet(req.params.phanInId)));
const traVe = asyncHandler(async (req, res) =>
  ok(res, await service.traVe(req.body || {}, req.user.id), 'Đã trả phần in về Giao nhận'));
const suaPhanIn = asyncHandler(async (req, res) =>
  ok(res, await service.suaPhanIn(req.params.id, req.body || {}, req.user.id), 'Đã lưu thông tin phần in'));
const suaDotVai = asyncHandler(async (req, res) =>
  ok(res, await service.suaDotVai(req.params.id, req.body || {}, req.user.id), 'Đã lưu thông tin đợt vải'));
const xacNhanLai = asyncHandler(async (req, res) =>
  ok(res, await service.xacNhanLai(req.params.phanInId, req.body || {}, req.user.id), 'Đã xác nhận — phần in quay lại READY'));

module.exports = { danhMuc, danhSach, chiTiet, traVe, suaPhanIn, suaDotVai, xacNhanLai };
