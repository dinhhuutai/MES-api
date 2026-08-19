'use strict';

const express = require('express');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');
const c = require('./caidattinhnang.controller');

const router = express.Router();
router.use(auth);

// ⚠ ROUTE TĨNH `/trang-thai` ĐẶT TRƯỚC — và CỐ Ý KHÔNG khai `rbac`: mọi người đăng nhập phải đọc
//   được trạng thái tính năng thì màn READY/QC mới hiện đúng chữ (có phải chờ duyệt không, có bắt
//   nhập lý do không). Đây chỉ là cờ hiển thị, không lộ dữ liệu gì; chốt chặn thật nằm ở service.
router.get('/trang-thai', c.trangThai);

// Bật/tắt tính năng nghiệp vụ (mig 087). Dùng chung quyền cấu hình hệ thống với trang Cài đặt API:
// xem = WORKFLOW_VIEW, sửa = WORKFLOW_MANAGE (KHÔNG thêm quyền mới ⇒ deploy xong dùng ngay, không
// ai phải đăng xuất–đăng nhập lại).
router.get('/', rbac('WORKFLOW_VIEW'), c.list);
router.put('/', rbac('WORKFLOW_MANAGE'), c.save);

module.exports = router;
