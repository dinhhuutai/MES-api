'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const service = require('./suathongtin.service');
const erpCapNhat = require('./erpCapNhat');

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

const xacNhanLaiNhieu = asyncHandler(async (req, res) => {
  const kq = await service.xacNhanLaiNhieu(req.body || {}, req.user.id);
  ok(res, kq, `Đã xác nhận ${kq.so_ok} phần in — quay lại READY`);
});

const huyDotVai = asyncHandler(async (req, res) => {
  const kq = await service.huyDotVai(req.params.phanInId, req.body || {}, req.user.id);
  ok(res, kq, `Đã hủy ${kq.so_dot_huy} đợt vải — phần in không in nữa`);
});

const huyDotVaiNhieu = asyncHandler(async (req, res) => {
  const kq = await service.huyDotVaiNhieu(req.body || {}, req.user.id);
  ok(res, kq, `Đã hủy vải ${kq.so_ok} phần in`);
});

const erpTrangThai =asyncHandler(async (req, res) => ok(res, erpCapNhat.trangThai()));
const erpDongBo = asyncHandler(async (req, res) =>
  ok(res, await erpCapNhat.dongBo({ tuDong: false, actorId: req.user.id }), 'Đã lấy dữ liệu từ ERP'));

module.exports = { danhMuc, danhSach, chiTiet, traVe, suaPhanIn, suaDotVai, xacNhanLai, xacNhanLaiNhieu, huyDotVai, huyDotVaiNhieu, erpTrangThai, erpDongBo };
