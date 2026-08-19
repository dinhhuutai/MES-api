'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const service = require('./caidattinhnang.service');

const list = asyncHandler(async (req, res) => ok(res, { items: await service.danhSach() }));

const save = asyncHandler(async (req, res) =>
  ok(res, await service.luu(req.body?.items, req.user.id), 'Đã lưu cài đặt tính năng'));

// Trạng thái rút gọn `{ma: bool}` — mọi người đăng nhập đều đọc được (FE cần để hiện đúng chữ và
// biết có phải nhập lý do hay không). Chốt chặn thật vẫn ở backend.
const trangThai = asyncHandler(async (req, res) => ok(res, await service.trangThai()));

module.exports = { list, save, trangThai };
