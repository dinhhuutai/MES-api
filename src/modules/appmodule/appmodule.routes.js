'use strict';

const express = require('express');
const { query } = require('../../config/db');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

// Quản lý bảng `module` (Home Portal).
const router = express.Router();
router.use(auth);

router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await query(
    'SELECT id, ma_module, ten_module, icon, route, mo_ta, thu_tu, dang_hoat_dong FROM module ORDER BY thu_tu, ten_module'
  );
  return ok(res, rows);
}));

router.patch('/:id', rbac('MODULE_MANAGE'), asyncHandler(async (req, res) => {
  const { tenModule, icon, route, moTa, thuTu } = req.body;
  await query(
    `UPDATE module SET ten_module = COALESCE($2, ten_module), icon = $3, route = $4, mo_ta = $5,
       thu_tu = $6, updated_by = $7, updated_date = CURRENT_TIMESTAMP WHERE id = $1`,
    [req.params.id, tenModule ?? null, icon ?? null, route ?? null, moTa ?? null, thuTu ?? null, req.user.id]
  );
  return ok(res, {}, 'Đã cập nhật');
}));

router.patch('/:id/active', rbac('MODULE_MANAGE'), asyncHandler(async (req, res) => {
  await query(
    'UPDATE module SET dang_hoat_dong = $2, updated_by = $3, updated_date = CURRENT_TIMESTAMP WHERE id = $1',
    [req.params.id, req.body.dangHoatDong === true, req.user.id]
  );
  return ok(res, {}, 'Đã cập nhật trạng thái');
}));

module.exports = router;
