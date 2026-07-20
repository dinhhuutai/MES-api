'use strict';

const service = require('./manualentry.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');

const khach = asyncHandler(async (req, res) => ok(res, await service.searchKhach(req.query.q)));
const don = asyncHandler(async (req, res) => ok(res, await service.searchDon(req.query.khachId, req.query.q)));
const maHang = asyncHandler(async (req, res) => ok(res, await service.searchMaHang(req.query.donId, req.query.q)));
const phanIn = asyncHandler(async (req, res) => ok(res, await service.searchPhanIn(req.query.maHangId, req.query.q)));
const loaiDotVai = asyncHandler(async (req, res) => ok(res, await service.listLoaiDotVai()));

const create = asyncHandler(async (req, res) => {
  const data = await service.createChain(req.body, req.user.id);
  return ok(res, data, `Đã tạo phần in ${data.ma_phan} với ${data.dot_vai.length} đợt vải`);
});

// Cập nhật SL nhận vải / SL release.
const vaiVe = asyncHandler(async (req, res) => ok(res, await service.searchVaiVe(req.query.q)));
const updateVaiVe = asyncHandler(async (req, res) => {
  const data = await service.updateVaiVe(req.params.id, req.body.so_luong_vai_ve, req.user.id);
  return ok(res, data, 'Đã cập nhật SL nhận vải');
});
const updateRelease = asyncHandler(async (req, res) => {
  const { lenh_san_xuat_id, dot_vai_ve_id, so_luong } = req.body || {};
  const data = await service.updateRelease(lenh_san_xuat_id, dot_vai_ve_id, so_luong, req.user.id);
  return ok(res, data, 'Đã cập nhật SL release');
});

module.exports = { khach, don, maHang, phanIn, loaiDotVai, create, vaiVe, updateVaiVe, updateRelease };
