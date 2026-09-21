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
// ⚠ Route TĨNH — phải đứng TRƯỚC `/:maTrang`, để sau thì `maTrang = "bang-theo-doi"` và trả 404.
router.get('/bang-theo-doi', c.bangTheoDoi);
router.get('/:maTrang', c.siSo);
// ⚠ Route 3 đoạn `/:maTrang/:o/ngay-giao` phải đặt TRƯỚC `/:maTrang/:o` — Express khớp theo thứ tự,
//   để sau thì `/:o` sẽ nuốt mất (`o` = "ton_cuoi", phần "ngay-giao" bị bỏ ⇒ trả nhầm danh sách).
router.get('/:maTrang/:o/ngay-giao', c.tomTatNgayGiao);
router.get('/:maTrang/:o', c.chiTiet);

module.exports = router;
