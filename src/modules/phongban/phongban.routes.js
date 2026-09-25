'use strict';

const express = require('express');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const s = require('./phongban.service');

// PHÒNG BAN & TỔ (mig 104). Quyền dùng lại của trang Người dùng — KHÔNG quyền mới.
// ⚠ Route TĨNH `/to/:id` đặt TRƯỚC `/:id`.
const router = express.Router();
router.use(auth);

router.get('/', rbac('USER_VIEW', 'USER_MANAGE'), asyncHandler(async (req, res) => ok(res, await s.danhSach())));
router.patch('/to/:id', rbac('USER_MANAGE'),
  asyncHandler(async (req, res) => ok(res, await s.suaTo(req.params.id, req.body, req.user.id), 'Đã lưu tên tổ')));
router.patch('/:id', rbac('USER_MANAGE'),
  asyncHandler(async (req, res) => ok(res, await s.suaPhong(req.params.id, req.body, req.user.id), 'Đã lưu tên phòng ban')));

module.exports = router;
