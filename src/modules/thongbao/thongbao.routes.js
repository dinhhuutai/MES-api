'use strict';

const express = require('express');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');
const c = require('./thongbao.controller');

const router = express.Router();
router.use(auth);

// ⚠ THỨ TỰ: mọi route ở đây đều TĨNH nên không đụng nhau; vẫn giữ route cụ thể trước cho dễ đọc.

// Chuông + danh sách (chỉ cần đăng nhập — service tự lọc theo quyền, trả rỗng nếu không thuộc diện).
router.get('/so-chua-doc', c.demChuaDoc);
router.get('/', c.danhSach);
router.post('/doc', c.danhDauDoc);

// Bật/tắt theo TỪNG NGƯỜI (trang Thông tin cá nhân) — ai cũng sửa được cấu hình CỦA CHÍNH MÌNH.
router.get('/cua-toi', c.cuaToi);
router.put('/cua-toi', c.luuCuaToi);

// Web Push: đăng ký / hủy thiết bị. Cũng chỉ cần đăng nhập (thiết bị của chính mình).
router.get('/push/khoa', c.khoaPush);
router.post('/push/dang-ky', c.dangKyPush);
router.post('/push/huy', c.huyPush);

// Bật/tắt Ở MỨC HỆ THỐNG (trang *Hệ thống > Cài đặt thông báo*).
// ⚠ Dùng CHUNG quyền với *Cài đặt API* và *Hiển thị theo phương án in*: xem = WORKFLOW_VIEW,
//   sửa = WORKFLOW_MANAGE. KHÔNG thêm quyền mới ⇒ deploy xong dùng được ngay, không ai phải
//   đăng xuất–đăng nhập lại (JWT nhúng permission, sống 1 năm).
router.get('/he-thong', rbac('WORKFLOW_VIEW'), c.heThong);
router.put('/he-thong', rbac('WORKFLOW_MANAGE'), c.luuHeThong);

module.exports = router;
