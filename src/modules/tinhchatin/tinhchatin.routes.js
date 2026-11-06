'use strict';

const express = require('express');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');
const c = require('./tinhchatin.controller');

const router = express.Router();
router.use(auth);

// Hệ thống › Tính chất in (mig 123). Dùng chung quyền cấu hình hệ thống với Hiển thị theo PA in · Cài đặt tính năng
// (xem = WORKFLOW_VIEW, sửa = WORKFLOW_MANAGE) ⇒ không thêm quyền mới, không ai phải đăng nhập lại.
router.get('/', rbac('WORKFLOW_VIEW'), c.list);
router.put('/', rbac('WORKFLOW_MANAGE'), c.save);
router.post('/', rbac('WORKFLOW_MANAGE'), c.add);
router.delete('/:id', rbac('WORKFLOW_MANAGE'), c.remove);

module.exports = router;
