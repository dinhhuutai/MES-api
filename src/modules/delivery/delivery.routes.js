'use strict';

const express = require('express');
const c = require('./delivery.controller');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

const router = express.Router();
router.use(auth);

router.get('/tem-san-sang', rbac('DELIVERY_VIEW', 'DELIVERY_MANAGE'), c.temSanSang);

// ─── Chốt chặn "bán hàng tích tem" (mig 092) — trang ở module Hệ thống ──────────────────────
// ⚠⚠ 4 route TĨNH này phải đứng TRƯỚC `/:id` (Express khớp theo thứ tự) — đặt sau là `/tich` bị
//   `/:id` nuốt và trả 404 khó hiểu.
// ⚠ Nhận CẢ `TICH_GIAO` (quyền mới của bán hàng) LẪN `DELIVERY_MANAGE`: quyền mới cần gán vai trò
//   + đăng xuất/đăng nhập lại mới có hiệu lực, nhận thêm quyền cũ để tổ giao hàng dùng được NGAY
//   (bài học mig 086 — `PA_IN_APPROVE` treo nhiều ngày vì chưa ai được gán).
router.get('/tich/cho', rbac('TICH_GIAO', 'DELIVERY_MANAGE', 'DELIVERY_VIEW'), c.temChoTich);
router.get('/tich/tra-cuu', rbac('TICH_GIAO', 'DELIVERY_MANAGE', 'DELIVERY_VIEW'), c.traCuuTich);
router.post('/tich', rbac('TICH_GIAO', 'DELIVERY_MANAGE'), c.tich);
router.post('/tich/bo', rbac('TICH_GIAO', 'DELIVERY_MANAGE'), c.boTich);

// ⚠⚠ 3 route TĨNH này cũng phải đứng TRƯỚC `/:id`, nếu không `/history` bị `/:id` nuốt (404 khó hiểu).
router.get('/history', rbac('DELIVERY_VIEW', 'DELIVERY_MANAGE'), c.history);
router.get('/done', rbac('DELIVERY_VIEW', 'DELIVERY_MANAGE'), c.done);
// Danh sách phiếu hủy được — trang *Hệ thống → Hủy lệnh xác nhận* (tab "Hủy phiếu giao").
router.get('/huy/cancelable', rbac('DELIVERY_VIEW', 'DELIVERY_MANAGE'), c.cancelable);

router.get('/', rbac('DELIVERY_VIEW', 'DELIVERY_MANAGE'), c.list);
router.get('/:id', rbac('DELIVERY_VIEW', 'DELIVERY_MANAGE'), c.detail);
router.post('/', rbac('DELIVERY_MANAGE'), c.create);
router.post('/:id/confirm', rbac('DELIVERY_MANAGE'), c.confirm);
// Hủy phiếu giao = ĐẢO sổ cái đã giao ⇒ đòi quyền quản lý giao hàng, lý do bắt buộc (kiểm ở service).
router.post('/:id/huy', rbac('DELIVERY_MANAGE'), c.huy);

module.exports = router;
