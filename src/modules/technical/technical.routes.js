'use strict';

const express = require('express');
const c = require('./technical.controller');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

const router = express.Router();
router.use(auth);

router.get('/config', rbac('READY_VIEW'), c.config);
router.get('/candidates', rbac('READY_VIEW'), c.candidates);
// Các route tĩnh — đặt trước route động /:phanInId để không bị nuốt.
router.get('/qc-candidates', rbac('READY_QC'), c.qcCandidates);
router.get('/history', rbac('READY_VIEW', 'READY_QC'), c.history);
router.get('/done', rbac('READY_VIEW', 'READY_QC'), c.done);
// Lịch sử trạng thái (xác nhận READY) cho module Hệ thống — chỉ quản trị (READY_CANCEL) mới xóa mềm.
router.get('/lich-su-xac-nhan', rbac('READY_CANCEL'), c.confirmHistory);
router.post('/qc-confirm-batch', rbac('READY_QC'), c.qcConfirmBatch);
// Bulk 1 mục cho nhiều phần in (theo mã hàng/chọn nhiều). Controller kiểm tra quyền theo mục.
router.post('/confirm-bulk', rbac('READY_KHUON', 'READY_FILM', 'READY_MUC', 'READY_HSKT'), c.confirmBulk);
router.get('/:phanInId', rbac('READY_VIEW'), c.detail);
// Xác nhận từng mục / hàng loạt: cần >=1 quyền tech; controller kiểm tra đúng quyền theo mục.
router.post('/:phanInId/confirm-batch', rbac('READY_KHUON', 'READY_FILM', 'READY_MUC', 'READY_HSKT'), c.confirmItemsBatch);
router.post('/:phanInId/confirm/:ma', rbac('READY_KHUON', 'READY_FILM', 'READY_MUC', 'READY_HSKT'), c.confirmItem);
router.post('/:phanInId/confirm-qc', rbac('READY_QC'), c.confirmQC);
// Hủy xác nhận (Admin/READY_CANCEL) — khi bấm nhầm khuôn/film/mực/HSKT/QC.
router.post('/:phanInId/huy', rbac('READY_CANCEL'), c.cancelItem);

module.exports = router;
