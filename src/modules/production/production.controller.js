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

// `req.body` mang thêm ngày ca / giờ SX từ→đến / cờ BTP của LƯỢT IN này (mig 066).
const printTem = asyncHandler(async (req, res) =>
  ok(res, await service.printTem(req.params.phieuId, req.body.soLuong, req.user.id, req.body), 'Đã in tem'));

// In tem NHIỀU phần in 1 lượt (lệnh gom set): body { items: [{ dotVaiId, soLuong }] }.
const printTemBatch = asyncHandler(async (req, res) => {
  const data = await service.printTemBatch(req.params.phieuId, req.body?.items, req.user.id, req.body);
  return ok(res, data, `Đã in ${data.tems_in.length} tem`);
});

const finish = asyncHandler(async (req, res) =>
  ok(res, await service.finishRun(req.params.phieuId, req.user.id), 'Đã hoàn tất chạy'));

const reprintTem = asyncHandler(async (req, res) =>
  ok(res, await service.reprintTem(req.params.temId, req.body.lyDo, req.user.id), 'Đã in lại tem'));

// ?dotVaiId= → nhãn lấy đúng phần in của đợt vải đó (in tem lệnh gom set).
const temLabel = asyncHandler(async (req, res) =>
  ok(res, await service.temLabel(req.params.temId, req.query.dotVaiId || null)));

const temLogs = asyncHandler(async (req, res) => ok(res, await service.temLogs(req.params.phieuId)));

const addVaiHuy = asyncHandler(async (req, res) =>
  ok(res, await service.addVaiHuy(req.params.phieuId, req.body, req.user.id),
    req.body?.loai === 'THIEU' ? 'Đã ghi vải thiếu' : 'Đã ghi vải hủy'));

// Phân công sản xuất: body { caTruongId, chuyenTruong, items: [{ dotVaiId, thoIn, soLuongHuy, soLuongThieu }] }
const savePhanCong = asyncHandler(async (req, res) =>
  ok(res, await service.savePhanCong(req.params.phieuId, req.body || {}, req.user.id), 'Đã lưu phân công'));

const stopLine = asyncHandler(async (req, res) =>
  ok(res, await service.stopLine(req.params.phieuId, req.body.lyDo, req.user.id, req.body.gioBd || null,
    req.body.lyDoId || null), 'Đã ngừng chuyền'));

// ─── Danh mục lý do ngừng chuyền (mig 076) ───────────────────────────────────
const lyDoNgungList = asyncHandler(async (req, res) =>
  ok(res, await service.dsLyDoNgung({ search: req.query.search || '', all: req.query.all === '1' })));
const lyDoNgungCreate = asyncHandler(async (req, res) =>
  ok(res, await service.taoLyDoNgung(req.body, req.user.id), 'Đã thêm lý do'));
const lyDoNgungUpdate = asyncHandler(async (req, res) => {
  await service.suaLyDoNgung(req.params.id, req.body, req.user.id); ok(res, null, 'Đã cập nhật');
});
const lyDoNgungToggle = asyncHandler(async (req, res) => {
  await service.doiTrangThaiLyDoNgung(req.params.id, req.body.active !== false, req.user.id);
  ok(res, null, 'Đã cập nhật');
});

// ─── Danh mục TỔ IN (mig 084) ────────────────────────────────────────────────
const toInList = asyncHandler(async (req, res) =>
  ok(res, await service.dsToIn({ search: req.query.search || '', all: req.query.all === '1' })));
const toInCreate = asyncHandler(async (req, res) =>
  ok(res, await service.taoToIn(req.body, req.user.id), 'Đã thêm tổ in'));
const toInUpdate = asyncHandler(async (req, res) => {
  await service.suaToIn(req.params.id, req.body, req.user.id); ok(res, null, 'Đã cập nhật');
});
const toInToggle = asyncHandler(async (req, res) => {
  await service.doiTrangThaiToIn(req.params.id, req.body.active !== false, req.user.id);
  ok(res, null, 'Đã cập nhật');
});

// ─── Danh mục lý do bổ sung + ghi cho đợt vải (mig 077) ──────────────────────
const lyDoBoSungList = asyncHandler(async (req, res) =>
  ok(res, await service.dsLyDoBoSung({ search: req.query.search || '', all: req.query.all === '1' })));
const lyDoBoSungCreate = asyncHandler(async (req, res) =>
  ok(res, await service.taoLyDoBoSung(req.body, req.user.id), 'Đã thêm lý do'));
const lyDoBoSungUpdate = asyncHandler(async (req, res) => {
  await service.suaLyDoBoSung(req.params.id, req.body, req.user.id); ok(res, null, 'Đã cập nhật');
});
const lyDoBoSungToggle = asyncHandler(async (req, res) => {
  await service.doiTrangThaiLyDoBoSung(req.params.id, req.body.active !== false, req.user.id);
  ok(res, null, 'Đã cập nhật');
});
const luuLyDoBoSungDotVai = asyncHandler(async (req, res) =>
  ok(res, await service.luuLyDoBoSungDotVai(req.params.dotVaiId, req.body, req.user.id), 'Đã lưu lý do bổ sung'));

const resumeLine = asyncHandler(async (req, res) =>
  ok(res, await service.resumeLine(req.params.phieuId, req.user.id, req.body?.gioKt || null), 'Chuyền hoạt động lại'));

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

// Đổi chuyền của lượt chạy (máy hỏng / dồn tải) — đổi cả phiếu lẫn lệnh.
const doiChuyen = asyncHandler(async (req, res) =>
  ok(res, await service.doiChuyen(req.params.phieuId, req.body || {}, req.user.id), 'Đã đổi chuyền'));

// Hủy lệnh đang chạy (bấm nhầm Xác nhận chạy) → về chờ chạy
const undoStartCandidates = asyncHandler(async (req, res) => ok(res, await service.listUndoStartCandidates()));

const undoStartProduction = asyncHandler(async (req, res) =>
  ok(res, await service.undoStartProduction(req.params.phieuId, req.user.id), 'Đã hủy lệnh đang chạy — đưa về chờ chạy'));

// Trả về Kỹ thuật từ màn Xác nhận chạy (chờ chạy / đang chạy) → hủy lệnh + phần in quay lại READY
const traVeKyThuat = asyncHandler(async (req, res) =>
  ok(res, await service.traVeKyThuat(req.params.lenhId, req.body || {}, req.user.id),
    'Đã trả về Kỹ thuật — phần in quay lại READY'));

const vuotSanXuat = asyncHandler(async (req, res) =>
  ok(res, await service.vuotSanXuat(req.params.phieuId, req.body?.soLuong, req.user.id), 'Đã ghi nhận vượt sản xuất'));

module.exports = {
  candidates, getRun, start, chayDacBietCandidates, chayDacBiet, printTem, printTemBatch, reprintTem, temLabel, temLogs, finish, monitor,
  xePhoi, temChoPhoi, themTem, adjustPhoi, drying, confirmDry, redry,
  stopLine, resumeLine, addVaiHuy, savePhanCong, vuotSanXuat,
  lyDoNgungList, lyDoNgungCreate, lyDoNgungUpdate, lyDoNgungToggle,
  toInList, toInCreate, toInUpdate, toInToggle,
  lyDoBoSungList, lyDoBoSungCreate, lyDoBoSungUpdate, lyDoBoSungToggle, luuLyDoBoSungDotVai,
  cancelableTem, cancelPrintTem,
  closeCandidates, closeProduction,
  reopenCandidates, reopenProduction, pauseLenhChay, doiChuyen,
  undoStartCandidates, undoStartProduction,
  traVeKyThuat,
};
