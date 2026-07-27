'use strict';

const express = require('express');
const c = require('./hskt.controller');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

const router = express.Router();
router.use(auth);

// Xem: dùng chung quyền kỹ thuật READY (không thêm quyền mới → không phải đăng xuất lại).
const VIEW = rbac('READY_KHUON', 'READY_FILM', 'READY_MUC', 'WORKFLOW_VIEW');
const MANAGE = rbac('READY_KHUON', 'READY_FILM', 'READY_MUC');

// Route TĨNH trước route động /:id.
router.get('/by-barcode/:barcode', VIEW, c.byBarcode);
router.get('/phan-in/:phanInId', VIEW, c.byPhanIn);
router.get('/', VIEW, c.list);
router.get('/:id', VIEW, c.detail);
router.patch('/:id/phuong-an-in', MANAGE, c.changePhuongAnIn);

module.exports = router;
