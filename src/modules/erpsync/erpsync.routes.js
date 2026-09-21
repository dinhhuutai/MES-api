'use strict';

const express = require('express');
const c = require('./erpsync.controller');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

const router = express.Router();
router.use(auth);

router.post('/sync/phieu-nhan-vai', rbac('ERP_SYNC'), c.syncPhieuNhanVai);
router.get('/sync/history', rbac('ERP_SYNC'), c.history);
// ⚠ Route TĨNH đặt TRƯỚC `/sync/:id/raw` (cùng số đoạn khác nhau nên không va, nhưng giữ thói quen).
router.post('/sync/cap-nhat-code-phan/xem-truoc', rbac('ERP_SYNC'), c.xemTruocCodePhan);
router.post('/sync/cap-nhat-code-phan', rbac('ERP_SYNC'), c.capNhatCodePhan);
router.get('/sync/:id/raw', rbac('ERP_SYNC'), c.rawData);

module.exports = router;
