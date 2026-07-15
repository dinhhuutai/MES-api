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
router.get('/loai-dot-vai', rbac('ERP_SYNC'), c.loaiDotVai);
router.post('/', rbac('ERP_SYNC'), c.create);

module.exports = router;
