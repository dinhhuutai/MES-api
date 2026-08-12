const service = require('./phaninadmin.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');

const traCuu = asyncHandler(async (req, res) =>
  ok(res, await service.traCuu(req.query.q || req.query.search || '')));

const chiTiet = asyncHandler(async (req, res) =>
  ok(res, await service.chiTiet(req.params.phanInId)));

const suaPhanIn = asyncHandler(async (req, res) =>
  ok(res, await service.suaPhanIn(req.params.phanInId, req.body, req.user.id), 'Đã cập nhật phần in'));

const suaDotVai = asyncHandler(async (req, res) =>
  ok(res, await service.suaDotVai(req.params.dotVaiId, req.body, req.user.id), 'Đã cập nhật đợt vải'));

const datGiaiDoan = asyncHandler(async (req, res) => {
  const r = await service.datGiaiDoan(req.params.dotVaiId, req.body, req.user.id);
  return ok(res, r, `Đã đưa đợt vải về ${r.nhan}`);
});

const huyDotVai = asyncHandler(async (req, res) =>
  ok(res, await service.huyDotVai(req.body.dotVaiIds, req.body.lyDo, req.user.id), 'Đã hủy đợt vải'));

const moDotVai = asyncHandler(async (req, res) =>
  ok(res, await service.moDotVai(req.body.dotVaiIds, req.user.id), 'Đã mở lại đợt vải'));

const huyMucReady = asyncHandler(async (req, res) =>
  ok(res, await service.huyMucReady(req.params.phanInId, req.body.muc, req.user.id), 'Đã hủy xác nhận READY'));

module.exports = { traCuu, chiTiet, suaPhanIn, suaDotVai, datGiaiDoan, huyDotVai, moDotVai, huyMucReady };
