'use strict';

const service = require('./delivery.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok, created } = require('../../utils/response');

const temSanSang = asyncHandler(async (req, res) => ok(res, await service.listTemSanSang(req.query)));
const list = asyncHandler(async (req, res) => ok(res, await service.listGiaoHang(req.query)));

// Sidebar Lịch sử / Đã hoàn thành của màn *Danh sách tem giao* (khuôn chung các màn xác nhận).
const history = asyncHandler(async (req, res) => ok(res, await service.historyGiao(req.query.date)));
const done = asyncHandler(async (req, res) => ok(res, await service.doneGiao(req.query.date)));

// Hủy phiếu giao — tab ở *Hệ thống → Hủy lệnh xác nhận*.
const cancelable = asyncHandler(async (req, res) =>
  ok(res, await service.listPhieuGiaoCancelable(req.query)));
const huy = asyncHandler(async (req, res) => ok(res,
  await service.huyPhieuGiao(req.params.id, req.body && req.body.lyDo, req.user.id),
  'Đã hủy phiếu giao — tem quay lại danh sách tem giao'));
const detail = asyncHandler(async (req, res) => ok(res, await service.getDetail(req.params.id)));
const create = asyncHandler(async (req, res) =>
  created(res, await service.createGiaoHang(req.body, req.user.id), 'Đã tạo phiếu giao'));
const confirm = asyncHandler(async (req, res) =>
  ok(res, await service.confirmGiao(req.params.id, req.user.id), 'Đã xác nhận giao — DONE DELIVERY'));
// Gửi LẠI phiếu sang ERP khi lượt gửi ngầm lúc xác nhận giao bị trượt (ERP lỗi / đang tắt).
const guiLaiErp = asyncHandler(async (req, res) =>
  ok(res, await service.guiLaiErp(req.params.id, req.user.id), 'Đã gửi lại phiếu giao sang ERP'));

// ─── Chốt chặn "bán hàng tích tem" (mig 092) ────────────────────────────────
const temChoTich = asyncHandler(async (req, res) => ok(res, await service.listTemChoTich(req.query)));
const tich = asyncHandler(async (req, res) =>
  ok(res, await service.tichTem(req.body && req.body.temIds, req.user.id), 'Đã tích tem cho chuyến giao'));
const boTich = asyncHandler(async (req, res) =>
  ok(res, await service.boTichTem(req.body && req.body.temIds, req.user.id), 'Đã bỏ tích'));
const traCuuTich = asyncHandler(async (req, res) => ok(res, await service.traCuuTemTich(req.query.code)));

// Đặt "Giao hàng tại" cho phiếu đã lập — modal hỏi trước khi IN LẠI (tab Phiếu giao / 2 sidebar).
// KLG hàng RCS khi IN LẠI phiếu (mig 102). body: { dong: [{ id, klg }] }.
const datKlg = asyncHandler(async (req, res) => ok(res,
  await service.datKlg(req.params.id, req.body && req.body.dong, req.user.id), 'Đã lưu KLG'));

const datGiaoHangTai = asyncHandler(async (req, res) => ok(res,
  await service.datGiaoHangTai(req.params.id, req.body && req.body.giaoHangTai, req.user.id),
  'Đã cập nhật nơi giao hàng'));

module.exports = {
  temSanSang, list, detail, create, confirm, temChoTich, tich, boTich, traCuuTich,
  history, done, cancelable, huy, guiLaiErp, datGiaoHangTai, datKlg,
};
