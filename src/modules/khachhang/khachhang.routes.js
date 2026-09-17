'use strict';

const express = require('express');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');
const c = require('./khachhang.controller');

const router = express.Router();
router.use(auth);

// THÔNG TIN KHÁCH HÀNG (mig 099) — địa chỉ + địa chỉ giao mặc định, để in lên PHIẾU GIAO.
//
// ⚠ ĐỌC mở thêm cho `DELIVERY_MANAGE`: tổ giao hàng cần tra địa chỉ khách lúc soạn chuyến, nhưng
//   KHÔNG được sửa (sửa là việc của người quản lý danh mục — cùng khuôn với `/production/to-in`).
// ⚠⚠ MES chỉ sửa 3 trường `dia_chi` / `dia_chi_giao` / `ghi_chu`. Mã + tên khách do ERP đẩy sang
//   (`erpsync.upsertKhachHang`), sửa ở đây thì lần sync sau bị ghi đè.
router.get('/', rbac('KHACH_HANG_MANAGE', 'DELIVERY_MANAGE'), c.list);
router.patch('/:id', rbac('KHACH_HANG_MANAGE'), c.update);

module.exports = router;
