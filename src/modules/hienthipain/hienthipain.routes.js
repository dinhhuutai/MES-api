'use strict';

const express = require('express');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');
const c = require('./hienthipain.controller');

const router = express.Router();
router.use(auth);

// Cấu hình hiển thị theo PHƯƠNG ÁN IN cho từng trang có dòng chảy phần in (mig 067).
// Dùng chung quyền cấu hình workflow: xem = WORKFLOW_VIEW, sửa = WORKFLOW_MANAGE.
router.get('/', rbac('WORKFLOW_VIEW'), c.list);
router.put('/', rbac('WORKFLOW_MANAGE'), c.save);

module.exports = router;
