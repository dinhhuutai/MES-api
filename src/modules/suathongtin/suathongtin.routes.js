'use strict';

const express = require('express');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');
const c = require('./suathongtin.controller');

const router = express.Router();
router.use(auth);

// PHẦN IN CHỜ SỬA THÔNG TIN — READY trả về Giao nhận (25/09/2026, mig 105). Xem `utils/traVeGn.js`.
// ⚠ 2 nhóm quyền:
//   · BÊN TRẢ VỀ (READY Kỹ thuật / QC): `READY_KHUON/FILM/MUC/QC` — gửi yêu cầu + đọc danh mục.
//   · BÊN SỬA (Giao nhận): `GN_SUA_THONG_TIN` — xem danh sách, sửa, xác nhận lại.
// ⚠ Route TĨNH (`danh-muc`, `tra-ve`, `phan-in/:id`, `dot-vai/:id`) đặt TRƯỚC `/:phanInId`.
const BEN_TRA = ['READY_KHUON', 'READY_FILM', 'READY_MUC', 'READY_QC'];
const BEN_SUA = ['GN_SUA_THONG_TIN'];

router.get('/danh-muc', rbac(...BEN_TRA, ...BEN_SUA), c.danhMuc);
router.post('/tra-ve', rbac(...BEN_TRA), c.traVe);
router.patch('/phan-in/:id', rbac(...BEN_SUA), c.suaPhanIn);
router.patch('/dot-vai/:id', rbac(...BEN_SUA), c.suaDotVai);
// ĐỌC mở rộng cho Đơn hàng + bên trả về (theo dõi phần in mình đã trả đi) — SỬA/XÁC NHẬN chỉ GN.
const BEN_XEM = [...BEN_SUA, 'ORDER_VIEW', 'READY_VIEW', 'READY_QC'];
// Kéo thông tin đã sửa từ ERP (/ds-phan-in-sua-thong-tin) — job 5 phút tự chạy; nút bấm tay chỉ GN.
router.get('/erp/trang-thai', rbac(...BEN_XEM), c.erpTrangThai);
router.post('/erp/dong-bo', rbac(...BEN_SUA), c.erpDongBo);
router.post('/xac-nhan', rbac(...BEN_SUA), c.xacNhanLaiNhieu); // hàng loạt — route TĨNH, trước /:phanInId
router.post('/huy-dot-vai', rbac(...BEN_SUA), c.huyDotVaiNhieu); // hủy vải hàng loạt — route TĨNH
router.get('/', rbac(...BEN_XEM), c.danhSach);
router.get('/:phanInId', rbac(...BEN_XEM), c.chiTiet);
router.post('/:phanInId/xac-nhan', rbac(...BEN_SUA), c.xacNhanLai);
router.post('/:phanInId/huy-dot-vai', rbac(...BEN_SUA), c.huyDotVai); // GN hủy vải — không in nữa

module.exports = router;
