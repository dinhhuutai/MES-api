'use strict';

const express = require('express');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');
const c = require('./suathongtin.controller');

const router = express.Router();
router.use(auth);

// PHẦN IN CHỜ SỬA THÔNG TIN — READY trả về Giao nhận (25/09/2026, mig 105). Xem `utils/traVeGn.js`.
// ⚠ 2 nhóm quyền:
//   · BÊN TRẢ VỀ: READY Kỹ thuật / QC (`READY_KHUON/FILM/MUC/QC`) + từ 06/10/2026 Release 1 (`RELEASE1`) ·
//     Test Run (`TESTRUN_QA`) · Release 2 (`RELEASE2`) · Chờ chạy (`PROD_RUN`) — gửi yêu cầu + đọc danh mục.
//   · BÊN SỬA (Giao nhận): `GN_SUA_THONG_TIN` — xem danh sách, sửa, gửi lại lệnh hủy ERP, xác nhận dự phòng.
// ⚠⚠ 07/10/2026 (người dùng chốt): BỎ "Hủy vải" · "Xác nhận lại" hàng loạt · "Lấy từ ERP". Trả về GN hủy đợt
//   READY bên ERP ngay; GN xác nhận lại TRÊN ERP ⇒ đồng bộ ERP tự trả phần in về đúng màn (`gnErp.js`).
// ⚠ Route TĨNH (`danh-muc`, `tra-ve`, `phan-in/:id`, `dot-vai/:id`) đặt TRƯỚC `/:phanInId`.
const BEN_TRA = ['READY_KHUON', 'READY_FILM', 'READY_MUC', 'READY_QC', 'RELEASE1', 'TESTRUN_QA', 'RELEASE2', 'PROD_RUN'];
const BEN_SUA = ['GN_SUA_THONG_TIN'];

router.get('/danh-muc', rbac(...BEN_TRA, ...BEN_SUA), c.danhMuc);
router.post('/tra-ve', rbac(...BEN_TRA), c.traVe);
router.patch('/phan-in/:id', rbac(...BEN_SUA), c.suaPhanIn);
router.patch('/dot-vai/:id', rbac(...BEN_SUA), c.suaDotVai);
// ĐỌC mở rộng cho Đơn hàng + bên trả về (theo dõi phần in mình đã trả đi) — SỬA/XÁC NHẬN chỉ GN.
const BEN_XEM = [...BEN_SUA, 'ORDER_VIEW', 'READY_VIEW', 'READY_QC'];
router.get('/', rbac(...BEN_XEM), c.danhSach);
router.get('/:phanInId', rbac(...BEN_XEM), c.chiTiet);
// Gửi (lại) lệnh hủy đợt READY sang ERP — lượt chưa tới được ERP (chưa gửi / API tắt / ERP lỗi).
router.post('/:phanInId/gui-huy-erp', rbac(...BEN_SUA), c.guiHuyErp);
// Dự phòng: chỉ khi lệnh hủy CHƯA tới được ERP (ERP đã nhận ⇒ 409 CHO_ERP).
router.post('/:phanInId/xac-nhan', rbac(...BEN_SUA), c.xacNhanLai);

module.exports = router;
