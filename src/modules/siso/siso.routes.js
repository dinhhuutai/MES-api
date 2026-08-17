'use strict';

const express = require('express');
const auth = require('../../middlewares/auth');
const c = require('./siso.controller');

const router = express.Router();
router.use(auth);

// ⚠ KHÔNG khai `rbac(...)` ở route: quyền kiểm THEO MÀN trong controller (mỗi màn một quyền riêng,
//   xem `utils/siSoTram.js`). Đặt rbac cứng ở đây sẽ hoặc chặn oan, hoặc mở quá tay.
// ⚠ Route TĨNH `/danh-muc` phải đứng TRƯỚC `/:maTrang`.
router.get('/danh-muc', c.danhMuc);
router.get('/:maTrang', c.siSo);
router.get('/:maTrang/:o', c.chiTiet);

module.exports = router;
