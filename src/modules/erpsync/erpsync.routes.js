'use strict';

const express = require('express');
const c = require('./erpsync.controller');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

const router = express.Router();
router.use(auth);

router.post('/sync/phieu-nhan-vai', rbac('ERP_SYNC'), c.syncPhieuNhanVai);
router.get('/sync/history', rbac('ERP_SYNC'), c.history);

module.exports = router;
