'use strict';

const express = require('express');
const { query } = require('../../config/db');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const auth = require('../../middlewares/auth');

// Các danh mục dùng cho dropdown trên nhiều màn hình (chỉ cần đăng nhập).
const router = express.Router();
router.use(auth);

router.get('/phong-ban', asyncHandler(async (req, res) => {
  const { rows } = await query(
    'SELECT id, ma_phong_ban, ten_phong_ban FROM phong_ban WHERE dang_hoat_dong = true ORDER BY ten_phong_ban'
  );
  return ok(res, rows);
}));

router.get('/roles', asyncHandler(async (req, res) => {
  const { rows } = await query(
    'SELECT id, ma_role, ten_role FROM vai_tro WHERE dang_hoat_dong = true ORDER BY ten_role'
  );
  return ok(res, rows);
}));

router.get('/loai-checkpoint', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT id, ma_loai, ten_loai FROM loai_checkpoint ORDER BY ma_loai');
  return ok(res, rows);
}));

router.get('/chuyen', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT cs.id, cs.ma_chuyen, cs.ten_chuyen, lc.ten_loai AS loai_chuyen
     FROM chuyen_san_xuat cs
     LEFT JOIN loai_chuyen lc ON lc.id = cs.loai_chuyen_id
     WHERE cs.dang_hoat_dong = true ORDER BY cs.ma_chuyen`
  );
  return ok(res, rows);
}));

router.get('/trang-thai', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT id, ma_trang_thai, ten_trang_thai, nhom_trang_thai FROM trang_thai
     WHERE dang_hoat_dong = true ORDER BY nhom_trang_thai, ma_trang_thai`
  );
  return ok(res, rows);
}));

module.exports = router;
