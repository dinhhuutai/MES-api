'use strict';

const service = require('./bao-cao.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok, created } = require('../../utils/response');

const listMetrics = asyncHandler(async (req, res) => ok(res, service.listMetrics()));

const list = asyncHandler(async (req, res) =>
  ok(res, await service.listReports({ search: req.query.search, userId: req.user.id, all: false })));

const listAll = asyncHandler(async (req, res) =>
  ok(res, await service.listReports({ search: req.query.search, userId: req.user.id, all: true })));

const getOne = asyncHandler(async (req, res) => ok(res, await service.getReport(req.params.id)));

const create = asyncHandler(async (req, res) =>
  created(res, await service.createReport(req.body, req.user.id)));

const update = asyncHandler(async (req, res) =>
  ok(res, await service.updateReport(req.params.id, req.body, req.user), 'Đã lưu báo cáo'));

const undo = asyncHandler(async (req, res) =>
  ok(res, await service.undoReport(req.params.id, req.user), 'Đã hoàn tác'));

const remove = asyncHandler(async (req, res) =>
  ok(res, await service.deleteReport(req.params.id, req.user), 'Đã xóa báo cáo'));

const render = asyncHandler(async (req, res) =>
  ok(res, await service.renderReport(req.params.id, { tu: req.body.tu, den: req.body.den, noiDung: req.body.noiDung })));

const history = asyncHandler(async (req, res) =>
  ok(res, await service.history(req.params.id, req.query.date)));

// ---- Phòng ban ----
const listPhongBan = asyncHandler(async (req, res) => ok(res, await service.listPhongBan()));

const deXuat = asyncHandler(async (req, res) =>
  created(res, await service.deXuat(req.params.phongBanId, req.body, req.user.id), 'Đã gửi đề xuất, chờ duyệt'));

const duyet = asyncHandler(async (req, res) =>
  ok(res, await service.duyetDeXuat(req.params.id, req.user.id), 'Đã duyệt áp dụng'));

const tuChoi = asyncHandler(async (req, res) =>
  ok(res, await service.tuChoiDeXuat(req.params.id, req.body.lyDo, req.user.id), 'Đã từ chối'));

const hienHanh = asyncHandler(async (req, res) =>
  ok(res, await service.hienHanhPhongBan(req.params.phongBanId, { tu: req.query.tu, den: req.query.den })));

module.exports = {
  listMetrics, list, listAll, getOne, create, update, undo, remove, render, history,
  listPhongBan, deXuat, duyet, tuChoi, hienHanh,
};
