'use strict';

const express = require('express');
const c = require('./phien.controller');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

const router = express.Router();
router.use(auth);

// XEM danh sách dùng `PRESENCE_VIEW` (quyền sẵn có của trang "Người dùng online") — không đẻ thêm
// quyền chỉ để xem.
router.get('/', rbac('PRESENCE_VIEW', 'PHIEN_MANAGE'), c.danhSach);

// ĐĂNG XUẤT TỪ XA: route KHÔNG khai rbac vì còn phải cho người dùng tự đăng xuất thiết bị CỦA CHÍNH
// MÌNH (không cần quyền gì). Quyền `PHIEN_MANAGE` được kiểm TRONG service khi đối tượng là người
// KHÁC (`coQuyenQuanLy` ở controller) — đừng đưa `rbac` ra đây, sẽ chặn luôn ca tự đăng xuất.
router.post('/:id/dang-xuat', c.dangXuatPhien);
router.post('/nguoi-dung/:userId/dang-xuat-tat-ca', c.dangXuatMoiThietBi);

module.exports = router;
