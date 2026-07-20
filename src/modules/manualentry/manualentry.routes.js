'use strict';

const express = require('express');
const c = require('./manualentry.controller');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

// Nhập tay đơn hàng → đợt vải (thay ERP). Quyền ERP_SYNC (như đồng bộ dữ liệu ERP).
const router = express.Router();
router.use(auth);

router.get('/khach-hang', rbac('ERP_SYNC'), c.khach);
router.get('/don-hang', rbac('ERP_SYNC'), c.don);
router.get('/ma-hang', rbac('ERP_SYNC'), c.maHang);
router.get('/phan-in', rbac('ERP_SYNC'), c.phanIn);
router.get('/loai-dot-vai', rbac('ERP_SYNC'), c.loaiDotVai);
router.post('/', rbac('ERP_SYNC'), c.create);

// Cập nhật SL nhận vải / SL release (sửa số liệu). ĐẶT TRƯỚC để không đụng '/'.
router.get('/vai-ve', rbac('ERP_SYNC'), c.vaiVe);
router.patch('/vai-ve/:id', rbac('ERP_SYNC'), c.updateVaiVe);
router.patch('/release', rbac('ERP_SYNC'), c.updateRelease);

module.exports = router;
