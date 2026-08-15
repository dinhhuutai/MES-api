'use strict';

const express = require('express');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');
const c = require('./caidatapi.controller');

const router = express.Router();
router.use(auth);

// Bật/tắt các API ERP (mig 083). Dùng chung quyền cấu hình hệ thống với trang Hiển thị theo
// phương án in: xem = WORKFLOW_VIEW, sửa = WORKFLOW_MANAGE (không thêm quyền mới ⇒ không phải
// đăng xuất–đăng nhập lại sau khi deploy).
router.get('/', rbac('WORKFLOW_VIEW'), c.list);
router.put('/', rbac('WORKFLOW_MANAGE'), c.save);
// Thử kết nối tới máy chủ ERP — chỉ ping HOST, không gọi endpoint nghiệp vụ (xem service).
router.post('/thu/:ma', rbac('WORKFLOW_VIEW'), c.thu);
// Lịch sử gọi API — xem đã LẤY/GỬI những gì (nguồn `audit_log`). Chỉ cần quyền XEM.
// ⚠ Route TĨNH `/lich-su/...` không đụng route nào khác vì `/` và `/thu/:ma` đã chiếm chỗ riêng.
router.get('/lich-su/:ma', rbac('WORKFLOW_VIEW'), c.lichSu);

module.exports = router;
