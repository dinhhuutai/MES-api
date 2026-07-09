'use strict';

const service = require('./quality.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');

const kcsCandidates = asyncHandler(async (req, res) =>
  ok(res, await service.listKcsCandidates({ search: req.query.search || '', filters: { ngay: req.query.ngay } })));
const recordKcs = asyncHandler(async (req, res) =>
  ok(res, await service.recordKcs(req.params.temId, req.body, req.user.id), 'Đã ghi nhận KCS'));

const suaCandidates = asyncHandler(async (req, res) => {
  const { search, khach, don, maHang, mauVai, kichVai, kichPhim, ngay } = req.query;
  return ok(res, await service.listSuaCandidates({
    search: search || '',
    filters: { khach, don, maHang, mauVai, kichVai, kichPhim, ngay },
  }));
});
const recordSua = asyncHandler(async (req, res) =>
  ok(res, await service.recordSua(req.params.temId, req.body, req.user.id), 'Đã ghi nhận sửa'));

const oqcCandidates = asyncHandler(async (req, res) =>
  ok(res, await service.listOqcCandidates({ search: req.query.search || '', filters: { ngay: req.query.ngay } })));
const recordOqc = asyncHandler(async (req, res) =>
  ok(res, await service.recordOqc(req.params.temId, req.body, req.user.id), 'Đã ghi nhận OQC'));
const oqcReturn = asyncHandler(async (req, res) =>
  ok(res, await service.returnOqcToKcs(req.params.temId, req.body, req.user.id), 'Đã trả tem về KCS'));

// Hủy xác nhận KCS / Sửa / OQC (lỡ xác nhận lộn / nhập sai số) — trang Hủy lệnh xác nhận
const todayD = () => new Date().toISOString().slice(0, 10);
const cancelKcsList = asyncHandler(async (req, res) => ok(res, await service.listCancelKcs(req.query.date || todayD())));
const cancelSuaList = asyncHandler(async (req, res) => ok(res, await service.listCancelSua(req.query.date || todayD())));
const cancelOqcList = asyncHandler(async (req, res) => ok(res, await service.listCancelOqc(req.query.date || todayD())));
const cancelKcs = asyncHandler(async (req, res) =>
  ok(res, await service.cancelKcs(req.params.id, (req.body.lyDo || '').trim() || null, req.user.id), 'Đã hủy xác nhận KCS'));
const cancelSua = asyncHandler(async (req, res) =>
  ok(res, await service.cancelSua(req.params.id, (req.body.lyDo || '').trim() || null, req.user.id), 'Đã hủy xác nhận Sửa'));
const cancelOqc = asyncHandler(async (req, res) =>
  ok(res, await service.cancelOqc(req.params.id, (req.body.lyDo || '').trim() || null, req.user.id), 'Đã hủy xác nhận OQC'));

// Lịch sử QC trả về (toggle 3 loại)
const qcTraVeHistory = asyncHandler(async (req, res) =>
  ok(res, await service.qcTraVeHistory(req.query.loai || 'READY', req.query.date || new Date().toISOString().slice(0, 10))));

const today = () => new Date().toISOString().slice(0, 10);
const temHanhTrinh = asyncHandler(async (req, res) => ok(res, await service.temHanhTrinh(req.params.temId)));
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

// Danh mục trường hợp giao đặc biệt
const giaoDacBietActive = asyncHandler(async (req, res) => ok(res, await service.listGiaoDacBiet()));
const giaoDacBietList = asyncHandler(async (req, res) => ok(res, await service.listGiaoDacBietAll(req.query.search || '')));
const giaoDacBietCreate = asyncHandler(async (req, res) => ok(res, await service.createGiaoDacBiet(req.body, req.user.id), 'Đã thêm trường hợp'));
const giaoDacBietUpdate = asyncHandler(async (req, res) => ok(res, await service.updateGiaoDacBiet(req.params.id, req.body, req.user.id), 'Đã cập nhật trường hợp'));
const giaoDacBietToggle = asyncHandler(async (req, res) => ok(res, await service.toggleGiaoDacBiet(req.params.id, req.body.active, req.user.id), 'Đã đổi trạng thái'));

module.exports = {
  kcsCandidates, recordKcs, suaCandidates, recordSua, oqcCandidates, recordOqc,
  kcsHistory, suaHistory, oqcHistory,
  kcsDone, suaDone, oqcDone, inlineDone,
  inlineCandidates, inlineLoaiLoi, inlineHistory, recordInline,
  loaiLoiList, loaiLoiCreate, loaiLoiUpdate, loaiLoiToggle,
  giaoDacBietActive, giaoDacBietList, giaoDacBietCreate, giaoDacBietUpdate, giaoDacBietToggle,
  oqcReturn, qcTraVeHistory, temHanhTrinh,
  cancelKcsList, cancelSuaList, cancelOqcList, cancelKcs, cancelSua, cancelOqc,
};
