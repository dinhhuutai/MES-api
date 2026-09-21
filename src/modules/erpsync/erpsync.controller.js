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

const history = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  return ok(res, await service.history({ date: req.query.date || null, page, limit, offset }));
});

const rawData = asyncHandler(async (req, res) =>
  ok(res, await service.rawData(req.params.id)));

// Cập nhật lại theo code phần + ngày (21/09/2026) — 2 bước: xem trước (chỉ đọc) → cập nhật.
const xemTruocCodePhan = asyncHandler(async (req, res) =>
  ok(res, await service.xemTruocCodePhan(req.body || {}, req.user.id)));
const capNhatCodePhan = asyncHandler(async (req, res) => {
  const r = await service.capNhatCodePhan(req.body || {}, req.user.id);
  const soDoi = (r.ghi_de || []).filter((x) => x && x.doi).length;
  return ok(res, r, `Đã cập nhật: ${r.soMoi} đợt mới, ${r.soCapNhat} cập nhật, gán lại đơn/mã hàng ${soDoi} phần in`);
});

module.exports = { syncPhieuNhanVai, history, rawData, xemTruocCodePhan, capNhatCodePhan };
