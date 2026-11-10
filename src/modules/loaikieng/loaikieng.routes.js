'use strict';

const express = require('express');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');
const c = require('./loaikieng.controller');

const router = express.Router();
router.use(auth);

// Danh mục kiếng (mig 126). Đọc chỉ cần đăng nhập (ô "Loại kiếng" lúc in tem ở Sản xuất); sửa = quyền cấu hình hệ thống
// (như Tính chất in) — không thêm quyền mới.
router.get('/', c.list);
router.post('/', rbac('WORKFLOW_MANAGE'), c.add);
router.put('/:id', rbac('WORKFLOW_MANAGE'), c.update);

module.exports = router;
