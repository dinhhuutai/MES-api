'use strict';

const express = require('express');
const auth = require('../../middlewares/auth');
const c = require('./thoigiantram.controller');

const router = express.Router();
router.use(auth);

// ⚠ Không khai `rbac` — cùng mức với các trang Dashboard khác (Tổng quan · Lịch sử nghẽn · Sơ đồ
//   phần in đều mở cho mọi người đăng nhập). Trang chỉ ĐỌC.
router.get('/', c.duLieu);

module.exports = router;
