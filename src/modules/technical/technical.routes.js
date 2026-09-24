'use strict';

const express = require('express');
const c = require('./technical.controller');
const { ctl: gc } = require('./ghiChu');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

const router = express.Router();
router.use(auth);

router.get('/config', rbac('READY_VIEW'), c.config);
router.get('/candidates', rbac('READY_VIEW'), c.candidates);
router.get('/item-counts', rbac('READY_VIEW'), c.itemCounts);
// Các route tĩnh — đặt trước route động /:phanInId để không bị nuốt.
// Tra cứu mã vừa quét không khớp dòng nào → báo lý do (đã QC xong / đã release / đã hủy).
router.get('/tra-cuu', rbac('READY_VIEW', 'READY_QC'), c.traCuu);
router.get('/qc-candidates', rbac('READY_QC'), c.qcCandidates);
router.get('/history', rbac('READY_VIEW', 'READY_QC'), c.history);
router.get('/done', rbac('READY_VIEW', 'READY_QC'), c.done);
// Lịch sử trạng thái (xác nhận READY) cho module Hệ thống — chỉ quản trị (READY_CANCEL) mới xóa mềm.
router.get('/lich-su-xac-nhan', rbac('READY_CANCEL'), c.confirmHistory);
// "Mở READY" (admin): phần in đi tắt READY (đợt mới tự vào Release 1) → ép về READY.
router.get('/reopen/candidates', rbac('READY_CANCEL'), c.reopenCandidates);
router.post('/reopen/:phanInId', rbac('READY_CANCEL'), c.reopenReady);
router.post('/qc-confirm-batch', rbac('READY_QC'), c.qcConfirmBatch);
// Bulk 1 mục cho nhiều phần in (theo mã hàng/chọn nhiều). Controller kiểm tra quyền theo mục.
router.post('/confirm-bulk', rbac('READY_KHUON', 'READY_FILM', 'READY_MUC', 'READY_HSKT'), c.confirmBulk);
// GHI CHÚ + PHẦN IN BẤT THƯỜNG (mig 103, 24/09/2026). Đọc: ai xem được READY/QC · Ghi: tổ kỹ thuật + QC.
const GHI_CHU_GHI = ['READY_KHUON', 'READY_FILM', 'READY_MUC', 'READY_QC', 'READY_CANCEL'];
router.get('/bat-thuong', rbac('READY_VIEW', 'READY_QC'), gc.dsBatThuong);
router.post('/bat-thuong', rbac(...GHI_CHU_GHI), gc.danhDauBatThuong);
router.post('/bat-thuong/go', rbac(...GHI_CHU_GHI), gc.goBatThuong);
router.get('/:phanInId/ghi-chu', rbac('READY_VIEW', 'READY_QC'), gc.cuaPhanIn);
router.post('/:phanInId/ghi-chu', rbac(...GHI_CHU_GHI), gc.themGhiChu);
router.get('/:phanInId', rbac('READY_VIEW'), c.detail);
// Xác nhận từng mục / hàng loạt: cần >=1 quyền tech; controller kiểm tra đúng quyền theo mục.
router.post('/:phanInId/confirm-batch', rbac('READY_KHUON', 'READY_FILM', 'READY_MUC', 'READY_HSKT'), c.confirmItemsBatch);
router.post('/:phanInId/confirm/:ma', rbac('READY_KHUON', 'READY_FILM', 'READY_MUC', 'READY_HSKT'), c.confirmItem);
router.post('/:phanInId/confirm-qc', rbac('READY_QC'), c.confirmQC);
// QC trả về Ready kỹ thuật (chọn checklist rớt + lý do).
router.post('/:phanInId/tra-ve', rbac('READY_QC'), c.returnToTech);
// Hủy xác nhận (Admin/READY_CANCEL) — khi bấm nhầm khuôn/film/mực/HSKT/QC.
router.post('/:phanInId/huy', rbac('READY_CANCEL'), c.cancelItem);
// Bỏ tích 1 mục kỹ thuật ngay trong luồng Quét/tích — quyền tech tự sửa khi tích lộn.
router.post('/:phanInId/uncheck/:ma', rbac('READY_KHUON', 'READY_FILM', 'READY_MUC'), c.uncheckItem);

module.exports = router;
