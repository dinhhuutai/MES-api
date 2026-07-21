'use strict';

const service = require('./erpsync.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const { getPaging } = require('../../utils/pagination');

// Đồng bộ thủ công. fromDate tùy chọn (mặc định = hiện tại - N ngày trong service).
const syncPhieuNhanVai = asyncHandler(async (req, res) => {
  const fromDate = req.body.fromDate || req.query.fromDate || undefined;
  const result = await service.syncPhieuNhanVai({ fromDate, actorId: req.user.id, tuDong: false });
  return ok(res, result,
    `Đồng bộ ERP xong: ${result.soMoi} mới, ${result.soCapNhat} cập nhật, ${result.soBoQua || 0} bỏ qua (không có code_part), ${result.soLoi} lỗi`);
});

// Đồng bộ API LẤY TRƯỚC (-new): đợt vải chờ chuyển READY (trừ 5I vào READY luôn).
const syncPhieuNhanVaiNew = asyncHandler(async (req, res) => {
  const fromDate = req.body.fromDate || req.query.fromDate || undefined;
  const result = await service.syncPhieuNhanVaiNew({ fromDate, actorId: req.user.id, tuDong: false });
  return ok(res, result,
    `Đồng bộ ERP (lấy trước) xong: ${result.soMoi} mới (${result.soChoChuyen || 0} chờ chuyển READY), ${result.soCapNhat} cập nhật, ${result.soLoi} lỗi`);
});

const history = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  return ok(res, await service.history({ date: req.query.date || null, page, limit, offset }));
});

const rawData = asyncHandler(async (req, res) =>
  ok(res, await service.rawData(req.params.id)));

module.exports = { syncPhieuNhanVai, syncPhieuNhanVaiNew, history, rawData };
