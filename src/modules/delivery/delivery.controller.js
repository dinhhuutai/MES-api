'use strict';

const service = require('./delivery.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok, created } = require('../../utils/response');
const { nhoDoc } = require('../../utils/cacheDoc');
const { thamSoLichSu } = require('../../utils/lichSuTim');

// Tem chờ giao dùng chung kết quả giữa mọi người xem (`utils/cacheDoc.js` — ghi là hết hiệu lực ngay).
const temSanSang = asyncHandler(async (req, res) => {
  const q = { ...req.query };
  return ok(res, await nhoDoc('delivery.temSanSang', q, () => service.listTemSanSang(q)));
});
// Tem tồn từ KCS — đã kiểm phẩm, chưa giao (modal màn Giao hàng, 14/10/2026).
const tonKcs = asyncHandler(async (req, res) => ok(res, await service.listTonKcs()));
const list = asyncHandler(async (req, res) => ok(res, await service.listGiaoHang(req.query)));

// Sidebar Lịch sử / Đã hoàn thành của màn *Danh sách tem giao* (khuôn chung các màn xác nhận).
// Không ngày + `q` ⇒ tìm mọi ngày theo mã phiếu / mã tem / code phần (`utils/lichSuTim`).
const history = asyncHandler(async (req, res) => ok(res, await service.historyGiao(thamSoLichSu(req.query))));
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

// ─── DONE DELIVERY theo phần in (19/11/2026) — `doneDelivery.js` ─────────────────────────────────────────────────────
const doneDelivery = require('./doneDelivery');
const AppError = require('../../utils/AppError');

const NGAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const kiemPhanIn = (id) => {
  if (!UUID_RE.test(String(id || ''))) throw new AppError('Phần in không hợp lệ', { status: 422, errorCode: 'PHAN_IN_SAI' });
  return id;
};
const dsDoneDelivery = asyncHandler(async (req, res) => {
  const { tuNgay, denNgay, cheDo, heThong } = req.query;
  if (!NGAY_RE.test(String(tuNgay || '')) || !NGAY_RE.test(String(denNgay || ''))) {
    throw new AppError('Chọn khoảng ngày', { status: 422, errorCode: 'NO_NGAY' });
  }
  return ok(res, await doneDelivery.danhSachDone(tuNgay, denNgay, cheDo, ['1', 'true'].includes(String(heThong))));
});
const xacNhanDone = asyncHandler(async (req, res) => ok(res,
  await doneDelivery.xacNhanDone(kiemPhanIn(req.params.phanInId), req.body && req.body.ghiChu, req.user.id),
  'Đã xác nhận DONE'));
const huyXacNhanDone = asyncHandler(async (req, res) => ok(res,
  await doneDelivery.huyXacNhanDone(kiemPhanIn(req.params.phanInId), req.body && req.body.lyDo, req.user.id),
  'Đã hủy xác nhận DONE'));

module.exports = {
  temSanSang, tonKcs, list, detail, create, confirm, temChoTich, tich, boTich, traCuuTich,
  history, done, cancelable, huy, guiLaiErp, datGiaoHangTai, datKlg,
  dsDoneDelivery, xacNhanDone, huyXacNhanDone,
};
