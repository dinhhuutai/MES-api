'use strict';

const express = require('express');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const service = require('./lichsuphanin.service');

// LỊCH SỬ PHẦN IN (16/11/2026) — trang Đơn hàng › Lịch sử phần in: mọi thao tác + thay đổi tự động của 1 phần in. Chỉ đọc.
// Quyền = xem Danh sách phần in (`ORDER_VIEW`) hoặc Quản trị phần in (`PHAN_IN_ADMIN`) — gương FE `constants/modules.js`.
const router = express.Router();
router.use(auth);
router.use(rbac('ORDER_VIEW', 'PHAN_IN_ADMIN'));

router.get('/tim', asyncHandler(async (req, res) => ok(res, await service.timPhanIn(req.query.q || ''))));
router.get('/:phanInId', asyncHandler(async (req, res) => ok(res, await service.lichSu(req.params.phanInId))));

module.exports = router;
