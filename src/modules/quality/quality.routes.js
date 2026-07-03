'use strict';

const express = require('express');
const c = require('./quality.controller');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

const router = express.Router();
router.use(auth);

router.get('/kcs/candidates', rbac('KCS'), c.kcsCandidates);
router.get('/kcs/history', rbac('KCS'), c.kcsHistory);
router.get('/kcs/done', rbac('KCS'), c.kcsDone);
router.post('/kcs/:temId', rbac('KCS'), c.recordKcs);

router.get('/sua/candidates', rbac('SUA'), c.suaCandidates);
router.get('/sua/history', rbac('SUA'), c.suaHistory);
router.get('/sua/done', rbac('SUA'), c.suaDone);
router.post('/sua/:temId', rbac('SUA'), c.recordSua);

router.get('/oqc/candidates', rbac('OQC'), c.oqcCandidates);
router.get('/oqc/history', rbac('OQC'), c.oqcHistory);
router.get('/oqc/done', rbac('OQC'), c.oqcDone);
router.post('/oqc/:temId', rbac('OQC'), c.recordOqc);

// QC in-line (kiểm tại chuyền) — route tĩnh trước route động /:phieuId
router.get('/inline/candidates', rbac('QC_INLINE'), c.inlineCandidates);
router.get('/inline/loai-loi', rbac('QC_INLINE'), c.inlineLoaiLoi);
router.get('/inline/history', rbac('QC_INLINE'), c.inlineHistory);
router.get('/inline/done', rbac('QC_INLINE'), c.inlineDone);
router.post('/inline/:phieuId', rbac('QC_INLINE'), c.recordInline);

// Danh mục lỗi
router.get('/loai-loi', rbac('LOI_MANAGE'), c.loaiLoiList);
router.post('/loai-loi', rbac('LOI_MANAGE'), c.loaiLoiCreate);
router.patch('/loai-loi/:id/active', rbac('LOI_MANAGE'), c.loaiLoiToggle);
router.patch('/loai-loi/:id', rbac('LOI_MANAGE'), c.loaiLoiUpdate);

module.exports = router;
