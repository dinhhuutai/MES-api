'use strict';

const express = require('express');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const { getPaging, TRAN_TAI_HET } = require('../../utils/pagination');
const service = require('./filekt.service');

// GHI NHẬN FILE PHẦN IN XUỐNG PHÒNG KỸ THUẬT (17/11/2026, mig 136) — trang *Đơn hàng › Ghi nhận file xuống KT*.
// Xem: `FILE_KT_GHI_NHAN` hoặc `ORDER_VIEW` · Quét / hủy / ghép lại: `FILE_KT_GHI_NHAN` — gương FE `constants/modules.js`.
const XEM = ['FILE_KT_GHI_NHAN', 'ORDER_VIEW'];
const GHI = 'FILE_KT_GHI_NHAN';

const router = express.Router();
router.use(auth);

const phanTrang = (req) => ({ ...req.query, ...getPaging(req.query, { tranToiDa: TRAN_TAI_HET }) });

router.get('/quet', rbac(...XEM), asyncHandler(async (req, res) => ok(res, await service.dsQuet(phanTrang(req)))));
router.get('/phan-in', rbac(...XEM), asyncHandler(async (req, res) => ok(res, await service.dsPhanIn(phanTrang(req)))));
router.post('/quet', rbac(GHI), asyncHandler(async (req, res) => {
  const kq = await service.quet(req.body || {}, req.user.id);
  return ok(res, kq, kq.phan_in.length ? `Đã ghi nhận — khớp ${kq.phan_in.length} phần in` : 'Đã ghi nhận — chưa có phần in khớp, lưu tạm');
}));
router.post('/quet/:id/huy', rbac(GHI), asyncHandler(async (req, res) =>
  ok(res, await service.huy(req.params.id, (req.body || {}).lyDo, req.user.id), 'Đã hủy lượt quét')));
router.post('/ghep-lai', rbac(GHI), asyncHandler(async (req, res) => {
  const kq = await service.ghepLai(req.user.id);
  return ok(res, kq, kq.so_luot_moi_ghep ? `Đã ghép thêm ${kq.so_luot_moi_ghep} lượt quét đang chờ` : 'Không có lượt quét nào ghép thêm được');
}));

module.exports = router;
