'use strict';

const service = require('./production.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const { getPaging } = require('../../utils/pagination');

const candidates = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  return ok(res, await service.listCandidates({ search: req.query.search || '', page, limit, offset }));
});

const getRun = asyncHandler(async (req, res) => ok(res, await service.getRun(req.params.lenhId)));

const start = asyncHandler(async (req, res) =>
  ok(res, await service.startProduction(req.params.lenhId, req.user.id), 'Đã xác nhận chạy'));

const printTem = asyncHandler(async (req, res) =>
  ok(res, await service.printTem(req.params.phieuId, req.body.soLuong, req.user.id), 'Đã in tem'));

const finish = asyncHandler(async (req, res) =>
  ok(res, await service.finishRun(req.params.phieuId, req.user.id), 'Đã hoàn tất chạy'));

const reprintTem = asyncHandler(async (req, res) =>
  ok(res, await service.reprintTem(req.params.temId, req.body.lyDo, req.user.id), 'Đã in lại tem'));

const temLogs = asyncHandler(async (req, res) => ok(res, await service.temLogs(req.params.phieuId)));

const stopLine = asyncHandler(async (req, res) =>
  ok(res, await service.stopLine(req.params.phieuId, req.body.lyDo, req.user.id), 'Đã ngừng chuyền'));

const resumeLine = asyncHandler(async (req, res) =>
  ok(res, await service.resumeLine(req.params.phieuId, req.user.id), 'Chuyền hoạt động lại'));

const monitor = asyncHandler(async (req, res) => ok(res, await service.monitor()));

const xePhoi = asyncHandler(async (req, res) => ok(res, await service.getXePhoi()));

const temChoPhoi = asyncHandler(async (req, res) => ok(res, await service.listTemChoPhoi(req.query.search || '')));

const themTem = asyncHandler(async (req, res) =>
  ok(res, await service.addToXe(req.body, req.user.id), 'Đã đưa tem vào xe phơi'));

const adjustPhoi = asyncHandler(async (req, res) =>
  ok(res, await service.adjustPhoi(req.params.id, req.body.phut, req.user.id), 'Đã điều chỉnh thời gian phơi'));

const drying = asyncHandler(async (req, res) => ok(res, await service.listDrying(req.query.search || '')));

const confirmDry = asyncHandler(async (req, res) =>
  ok(res, await service.confirmDry(req.params.temId, req.user.id), 'Đã xác nhận khô'));

module.exports = {
  candidates, getRun, start, printTem, reprintTem, temLogs, finish, monitor,
  xePhoi, temChoPhoi, themTem, adjustPhoi, drying, confirmDry,
  stopLine, resumeLine,
};
