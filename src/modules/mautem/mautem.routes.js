'use strict';

const express = require('express');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');
const c = require('./mautem.controller');

const router = express.Router();
router.use(auth);

// THIẾT KẾ TEM (mig 073) — quyền `TEM_DESIGN`, lúc đầu chỉ admin (role ADMIN có '*').
// ⚠ Route TĨNH đặt TRƯỚC route `/:id` (nếu không "danh-muc" sẽ bị nuốt thành id).
router.get('/danh-muc', rbac('TEM_DESIGN'), c.danhMuc);

// Mẫu đang gắn cho 1 vị trí in — MỌI người đã đăng nhập gọi được vì đây là đường IN TEM thật
// (thợ in không có quyền TEM_DESIGN nhưng vẫn phải in được).
router.get('/vi-tri/:maViTri', c.mauChoViTri);

router.get('/', rbac('TEM_DESIGN'), c.list);
router.post('/', rbac('TEM_DESIGN'), c.tao);
router.get('/:id', rbac('TEM_DESIGN'), c.chiTiet);
router.put('/:id', rbac('TEM_DESIGN'), c.sua);
router.post('/:id/nhan-ban', rbac('TEM_DESIGN'), c.nhanBan);
router.delete('/:id', rbac('TEM_DESIGN'), c.xoa);

// Gắn mẫu vào nút in (body `{ mau_tem_id }`; rỗng = gỡ gắn).
router.put('/gan/:maViTri', rbac('TEM_DESIGN'), c.gan);

module.exports = router;
