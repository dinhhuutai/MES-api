'use strict';

const express = require('express');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');
const c = require('./mauphieu.controller');

const router = express.Router();
router.use(auth);

// THIẾT KẾ PHIẾU (mig 094) — quyền `PHIEU_DESIGN`, lúc đầu chỉ admin (role ADMIN có '*').
// ⚠ Route TĨNH đặt TRƯỚC route `/:id` (nếu không "danh-muc" sẽ bị nuốt thành id).
router.get('/danh-muc', rbac('PHIEU_DESIGN'), c.danhMuc);

// Mẫu đang gắn cho 1 vị trí in — MỌI người đã đăng nhập gọi được vì đây là đường IN PHIẾU thật
// (tổ giao hàng không có quyền PHIEU_DESIGN nhưng vẫn phải in được).
router.get('/vi-tri/:maViTri', c.mauChoViTri);

router.get('/', rbac('PHIEU_DESIGN'), c.list);
router.post('/', rbac('PHIEU_DESIGN'), c.tao);
router.get('/:id', rbac('PHIEU_DESIGN'), c.chiTiet);
router.put('/:id', rbac('PHIEU_DESIGN'), c.sua);
router.post('/:id/nhan-ban', rbac('PHIEU_DESIGN'), c.nhanBan);
router.delete('/:id', rbac('PHIEU_DESIGN'), c.xoa);

// Gắn mẫu vào nút in phiếu (body `{ mau_phieu_id }`; rỗng = gỡ gắn).
router.put('/gan/:maViTri', rbac('PHIEU_DESIGN'), c.gan);

module.exports = router;
