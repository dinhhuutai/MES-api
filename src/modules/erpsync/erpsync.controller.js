'use strict';

const service = require('./erpsync.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');

// Đồng bộ thủ công. fromDate tùy chọn (mặc định = hiện tại - N ngày trong service).
const syncPhieuNhanVai = asyncHandler(async (req, res) => {
  const fromDate = req.body.fromDate || req.query.fromDate || undefined;
  const result = await service.syncPhieuNhanVai({ fromDate, actorId: req.user.id, tuDong: false });
  return ok(res, result,
    `Đồng bộ ERP xong: ${result.soMoi} mới, ${result.soCapNhat} cập nhật, ${result.soBoQua || 0} bỏ qua (không có code_part), ${result.soLoi} lỗi`);
});

const history = asyncHandler(async (req, res) =>
  ok(res, await service.history(parseInt(req.query.limit || '50', 10))));

const rawData = asyncHandler(async (req, res) =>
  ok(res, await service.rawData(req.params.id)));

module.exports = { syncPhieuNhanVai, history, rawData };
