'use strict';

const express = require('express');
const auth = require('../../middlewares/auth');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const s = require('./lydonghen.service');

// LÝ DO NGHẼN (mig 106). ⚠ KHÔNG khai `rbac`: ai xác nhận được ở màn đó (đã gác quyền ở route xác nhận
// của màn) thì ghi được lý do; đọc thì chỉ là danh sách lý do — cùng mức mở với Dashboard.
// Tài khoản CHỈ XEM tự bị chặn POST ở `middlewares/auth`.
const router = express.Router();
router.use(auth);

router.get('/', asyncHandler(async (req, res) => ok(res, await s.danhSach(req.query || {}))));
router.post('/', asyncHandler(async (req, res) => {
  const kq = await s.ghi(req.body || {}, req.user.id);
  ok(res, kq, kq.thieu_migration ? 'Chưa chạy migration 106 — lý do chưa được lưu' : 'Đã lưu lý do nghẽn');
}));

module.exports = router;
