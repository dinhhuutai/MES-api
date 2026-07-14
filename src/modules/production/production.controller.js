'use strict';

const service = require('./production.service');
const planningService = require('../planning/planning.service'); // dùng chung candidate Test Run
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const { getPaging } = require('../../utils/pagination');

const candidates = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  return ok(res, await service.listCandidates({ search: req.query.search || '', page, limit, offset }));
});

const getRun = asyncHandler(async (req, res) => ok(res, await service.getRun(req.params.lenhId)));

const start = asyncHandler(async (req, res) =>
  ok(res, await service.startProduction(req.params.lenhId, req.user.id, req.body.chuyenId || null), 'Đã xác nhận chạy'));

// Chạy đặc biệt (bỏ Test Run): danh sách = CÙNG candidate Test Run; hành động = khởi chạy thẳng.
const chayDacBietCandidates = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  return ok(res, await planningService.listTestRunCandidates({ search: req.query.search || '', page, limit, offset }));
});
const chayDacBiet = asyncHandler(async (req, res) =>
  ok(res, await service.startProductionSpecial(req.params.lenhId, req.user.id, req.body.chuyenId || null, req.body.lyDo || null),
    'Đã chạy đặc biệt (bỏ Test Run)'));

const printTem = asyncHandler(async (req, res) =>
  ok(res, await service.printTem(req.params.phieuId, req.body.soLuong, req.user.id), 'Đã in tem'));

const finish = asyncHandler(async (req, res) =>
  ok(res, await service.finishRun(req.params.phieuId, req.user.id), 'Đã hoàn tất chạy'));

const reprintTem = asyncHandler(async (req, res) =>
  ok(res, await service.reprintTem(req.params.temId, req.body.lyDo, req.user.id), 'Đã in lại tem'));

const temLabel = asyncHandler(async (req, res) => ok(res, await service.temLabel(req.params.temId)));

const temLogs = asyncHandler(async (req, res) => ok(res, await service.temLogs(req.params.phieuId)));

const addVaiHuy = asyncHandler(async (req, res) =>
  ok(res, await service.addVaiHuy(req.params.phieuId, req.body, req.user.id), 'Đã ghi vải hủy'));

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

const redry = asyncHandler(async (req, res) =>
  ok(res, await service.redry(req.params.temId, req.body.phut, req.user.id), 'Đã đưa tem phơi lại'));

// Hủy lệnh in tem (tem chưa kiểm)
const cancelableTem = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  return ok(res, await service.listCancelableTem({ search: req.query.search || '', page, limit, offset }));
});

const cancelPrintTem = asyncHandler(async (req, res) =>
  ok(res, await service.cancelPrintTem(req.params.temId, req.body.lyDo, req.user.id), 'Đã hủy lệnh in tem'));

// Đóng lệnh sản xuất (= Chạy hoàn tất)
const closeCandidates = asyncHandler(async (req, res) => ok(res, await service.listCloseCandidates()));

const closeProduction = asyncHandler(async (req, res) =>
  ok(res, await service.closeProduction(req.params.phieuId, req.body.lyDo, req.user.id), 'Đã đóng lệnh sản xuất'));

// Mở lại lệnh sản xuất (đã đóng/hoàn tất, cần in tiếp) — trong 2 ngày
const reopenCandidates = asyncHandler(async (req, res) => ok(res, await service.listReopenCandidates()));

const reopenProduction = asyncHandler(async (req, res) =>
  ok(res, await service.reopenProduction(req.params.phieuId, req.user.id), 'Đã mở lại lệnh sản xuất'));

// Ngừng lệnh chạy (ngừng phần in để in hàng gấp) → lệnh về chờ chạy
const pauseLenhChay = asyncHandler(async (req, res) =>
  ok(res, await service.pauseLenhChay(req.params.phieuId, req.user.id), 'Đã ngừng lệnh chạy — lệnh về chờ chạy'));

// Hủy lệnh đang chạy (bấm nhầm Xác nhận chạy) → về chờ chạy
const undoStartCandidates = asyncHandler(async (req, res) => ok(res, await service.listUndoStartCandidates()));

const undoStartProduction = asyncHandler(async (req, res) =>
  ok(res, await service.undoStartProduction(req.params.phieuId, req.user.id), 'Đã hủy lệnh đang chạy — đưa về chờ chạy'));

const vuotSanXuat = asyncHandler(async (req, res) =>
  ok(res, await service.vuotSanXuat(req.params.phieuId, req.body?.soLuong, req.user.id), 'Đã ghi nhận vượt sản xuất'));

module.exports = {
  candidates, getRun, start, chayDacBietCandidates, chayDacBiet, printTem, reprintTem, temLabel, temLogs, finish, monitor,
  xePhoi, temChoPhoi, themTem, adjustPhoi, drying, confirmDry, redry,
  stopLine, resumeLine, addVaiHuy, vuotSanXuat,
  cancelableTem, cancelPrintTem,
  closeCandidates, closeProduction,
  reopenCandidates, reopenProduction, pauseLenhChay,
  undoStartCandidates, undoStartProduction,
};
