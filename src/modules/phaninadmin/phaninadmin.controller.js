const service = require('./phaninadmin.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');

const traCuu = asyncHandler(async (req, res) =>
  ok(res, await service.traCuu(req.query.q || req.query.search || '')));

const chiTiet = asyncHandler(async (req, res) =>
  ok(res, await service.chiTiet(req.params.phanInId)));

// Sửa từ TRANG Quản trị phần in ⇒ `khoa: true` — tự khóa đồng bộ ERP của phần in (mig 116).
const suaPhanIn = asyncHandler(async (req, res) =>
  ok(res, await service.suaPhanIn(req.params.phanInId, req.body, req.user.id, { khoa: true }), 'Đã cập nhật phần in'));

const suaDotVai = asyncHandler(async (req, res) =>
  ok(res, await service.suaDotVai(req.params.dotVaiId, req.body, req.user.id, { khoa: true }), 'Đã cập nhật đợt vải'));

const datKhoaErp = asyncHandler(async (req, res) => {
  const khoa = req.body.khoa === true;
  return ok(res, await service.datKhoaErp(req.params.phanInId, khoa, req.user.id),
    khoa ? 'Đã khóa đồng bộ ERP' : 'Đã mở khóa — lượt đồng bộ ERP kế tiếp sẽ cập nhật lại phần in này');
});

const datGiaiDoan = asyncHandler(async (req, res) => {
  const r = await service.datGiaiDoan(req.params.dotVaiId, req.body, req.user.id);
  return ok(res, r, `Đã đưa đợt vải về ${r.nhan}`);
});

const luiVe = asyncHandler(async (req, res) => {
  const r = await service.luiVe(req.params.phanInId, req.params.lenhId, req.body || {}, req.user.id);
  if (r.xem_truoc) return ok(res, r);
  return ok(res, r, r.loi ? `Dừng ở bước ${r.xong.length + 1}/${r.tong}: ${r.loi.message}` : `Đã lùi lệnh về đích (${r.tong} bước)`);
});

const huyLe = asyncHandler(async (req, res) =>
  ok(res, await service.huyLe(req.params.phanInId, req.body || {}, req.user.id), 'Đã thực hiện'));

const luuPhanCong = asyncHandler(async (req, res) =>
  ok(res, await service.luuPhanCong(req.params.phanInId, req.params.phieuId, req.body || {}, req.user.id), 'Đã lưu phân công'));

const huyPhanIn = asyncHandler(async (req, res) =>
  ok(res, await service.huyPhanIn(req.params.phanInId, req.body.lyDo, req.user.id), 'Đã hủy phần in'));

const moPhanIn = asyncHandler(async (req, res) =>
  ok(res, await service.moPhanIn(req.params.phanInId, req.user.id), 'Đã mở lại phần in'));

const huyDotVai = asyncHandler(async (req, res) =>
  ok(res, await service.huyDotVai(req.body.dotVaiIds, req.body.lyDo, req.user.id), 'Đã hủy đợt vải'));

const moDotVai = asyncHandler(async (req, res) =>
  ok(res, await service.moDotVai(req.body.dotVaiIds, req.user.id), 'Đã mở lại đợt vải'));

const huyMucReady = asyncHandler(async (req, res) =>
  ok(res, await service.huyMucReady(req.params.phanInId, req.body.muc, req.user.id), 'Đã hủy xác nhận READY'));

module.exports = {
  traCuu, chiTiet, suaPhanIn, suaDotVai, datKhoaErp, datGiaiDoan, luiVe, huyLe, luuPhanCong, huyPhanIn, moPhanIn,
  huyDotVai, moDotVai, huyMucReady,
};
