'use strict';

const express = require('express');
const auth = require('../../middlewares/auth');
const c = require('./thoigiantram.controller');

const router = express.Router();
router.use(auth);

// ⚠ Không khai `rbac` — cùng mức với các trang Dashboard khác (Tổng quan · Lịch sử nghẽn · Sơ đồ
//   phần in đều mở cho mọi người đăng nhập). Trang chỉ ĐỌC.
router.get('/', c.duLieu);
// Checklist sổ xuống của 1 trạm — cùng bộ lọc với `/`, chỉ đổi mốc RA sang lúc xác nhận checklist.
router.get('/checklist/:maTram', c.checklist);

module.exports = router;
