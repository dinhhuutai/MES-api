'use strict';

const service = require('./quality.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');

const kcsCandidates = asyncHandler(async (req, res) => ok(res, await service.listKcsCandidates(req.query.search || '')));
const recordKcs = asyncHandler(async (req, res) =>
  ok(res, await service.recordKcs(req.params.temId, req.body, req.user.id), 'Đã ghi nhận KCS'));

const suaCandidates = asyncHandler(async (req, res) => ok(res, await service.listSuaCandidates(req.query.search || '')));
const recordSua = asyncHandler(async (req, res) =>
  ok(res, await service.recordSua(req.params.temId, req.body, req.user.id), 'Đã ghi nhận sửa'));

const oqcCandidates = asyncHandler(async (req, res) => ok(res, await service.listOqcCandidates(req.query.search || '')));
const recordOqc = asyncHandler(async (req, res) =>
  ok(res, await service.recordOqc(req.params.temId, req.body, req.user.id), 'Đã ghi nhận OQC'));

const today = () => new Date().toISOString().slice(0, 10);
const kcsHistory = asyncHandler(async (req, res) => ok(res, await service.kcsHistory(req.query.date || today())));
const suaHistory = asyncHandler(async (req, res) => ok(res, await service.suaHistory(req.query.date || today())));
const oqcHistory = asyncHandler(async (req, res) => ok(res, await service.oqcHistory(req.query.date || today())));

const kcsDone = asyncHandler(async (req, res) => ok(res, await service.kcsDone(req.query.date || today())));
const suaDone = asyncHandler(async (req, res) => ok(res, await service.suaDone(req.query.date || today())));
const oqcDone = asyncHandler(async (req, res) => ok(res, await service.oqcDone(req.query.date || today())));
const inlineDone = asyncHandler(async (req, res) => ok(res, await service.inlineDone(req.query.date || today())));

// QC in-line
const inlineCandidates = asyncHandler(async (req, res) => ok(res, await service.listInlineCandidates(req.query.search || '')));
const inlineLoaiLoi = asyncHandler(async (req, res) => ok(res, await service.listLoaiLoi()));
const inlineHistory = asyncHandler(async (req, res) => ok(res, await service.inlineHistory(req.query.date || today())));
const recordInline = asyncHandler(async (req, res) =>
  ok(res, await service.recordQcInline(req.params.phieuId, req.body, req.user.id), 'Đã ghi nhận QC in-line'));

// Danh mục lỗi
const loaiLoiList = asyncHandler(async (req, res) => ok(res, await service.listLoaiLoiAll(req.query.search || '')));
const loaiLoiCreate = asyncHandler(async (req, res) => ok(res, await service.createLoaiLoi(req.body, req.user.id), 'Đã thêm loại lỗi'));
const loaiLoiUpdate = asyncHandler(async (req, res) => ok(res, await service.updateLoaiLoi(req.params.id, req.body, req.user.id), 'Đã cập nhật loại lỗi'));
const loaiLoiToggle = asyncHandler(async (req, res) => ok(res, await service.toggleLoaiLoi(req.params.id, req.body.active, req.user.id), 'Đã đổi trạng thái'));

module.exports = {
  kcsCandidates, recordKcs, suaCandidates, recordSua, oqcCandidates, recordOqc,
  kcsHistory, suaHistory, oqcHistory,
  kcsDone, suaDone, oqcDone, inlineDone,
  inlineCandidates, inlineLoaiLoi, inlineHistory, recordInline,
  loaiLoiList, loaiLoiCreate, loaiLoiUpdate, loaiLoiToggle,
};
