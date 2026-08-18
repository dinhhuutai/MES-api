'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const service = require('./thongbao.service');

// Chuông + danh sách + đánh dấu đã đọc: CHỈ CẦN ĐĂNG NHẬP.
// ⚠ Quyền lọc TRONG service (`coQuyenNhan`) chứ không đặt `rbac` ở route: người không có quyền
//   kỹ thuật vẫn gọi được endpoint nhưng nhận danh sách RỖNG + `co_quyen=false` — FE dựa vào cờ đó
//   để ẩn hẳn cái chuông. Đặt `rbac` ở route thì họ ăn 403 và FE phải bắt lỗi để ẩn, rườm rà hơn.
const demChuaDoc = asyncHandler(async (req, res) => ok(res, await service.demChuaDoc(req.user)));
const danhSach = asyncHandler(async (req, res) => ok(res, await service.danhSach(req.user, req.query)));
const danhDauDoc = asyncHandler(async (req, res) =>
  ok(res, await service.danhDauDoc(req.user, req.body && req.body.ids), 'Đã đánh dấu đã đọc'));

// Cấu hình cá nhân.
const cuaToi = asyncHandler(async (req, res) => ok(res, await service.layCaiDatCuaToi(req.user)));
const luuCuaToi = asyncHandler(async (req, res) =>
  ok(res, await service.luuCaiDatCuaToi(req.user, req.body.ma_loai, req.body.bat), 'Đã lưu'));

// Cấu hình hệ thống (rbac ở route).
const heThong = asyncHandler(async (req, res) => ok(res, await service.layCaiDatHeThong()));
const luuHeThong = asyncHandler(async (req, res) =>
  ok(res, await service.luuCaiDatHeThong(req.body.items, req.user.id), 'Đã lưu cài đặt thông báo'));

// Web Push.
const khoaPush = asyncHandler(async (req, res) => ok(res, service.khoaCongKhaiPush()));
const dangKyPush = asyncHandler(async (req, res) =>
  ok(res, await service.dangKyPush(req.user, req.body), 'Đã bật thông báo trên thiết bị này'));
const huyPush = asyncHandler(async (req, res) =>
  ok(res, await service.huyPush(req.body && req.body.endpoint), 'Đã tắt thông báo trên thiết bị này'));

module.exports = {
  demChuaDoc, danhSach, danhDauDoc, cuaToi, luuCuaToi, heThong, luuHeThong,
  khoaPush, dangKyPush, huyPush,
};
