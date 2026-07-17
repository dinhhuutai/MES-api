'use strict';

const express = require('express');
const c = require('./quality.controller');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

const router = express.Router();
router.use(auth);

// Hành trình 1 tem (gộp KCS/Sửa/OQC/Giao) — cho panel "Hành trình theo tem"
router.get('/tem/:temId/hanh-trinh', rbac('KCS', 'SUA', 'OQC', 'DELIVERY_VIEW', 'DELIVERY_MANAGE'), c.temHanhTrinh);

router.get('/kcs/candidates', rbac('KCS'), c.kcsCandidates);
router.get('/kcs/history', rbac('KCS'), c.kcsHistory);
router.get('/kcs/done', rbac('KCS'), c.kcsDone);
router.post('/kcs/gop-tem', rbac('KCS'), c.gopTem);
router.post('/kcs/:temId', rbac('KCS'), c.recordKcs);

router.get('/sua/candidates', rbac('SUA'), c.suaCandidates);
router.get('/sua/history', rbac('SUA'), c.suaHistory);
router.get('/sua/done', rbac('SUA'), c.suaDone);
router.post('/sua/:temId', rbac('SUA'), c.recordSua);

router.get('/oqc/candidates', rbac('OQC'), c.oqcCandidates);
router.get('/oqc/history', rbac('OQC'), c.oqcHistory);
router.get('/oqc/done', rbac('OQC'), c.oqcDone);
router.post('/oqc/:temId/tra-ve', rbac('OQC'), c.oqcReturn);
router.post('/oqc/:temId', rbac('OQC'), c.recordOqc);

// Hủy / mở lại TEM SỬA (nhãn 16-) — xóa SL sửa khỏi sổ cái; xem quality.service.
// ⚠ PHẢI đặt TRƯỚC `/sua/:id/huy`: '/sua/tem-sua/huy' cũng có 3 đoạn nên route động sẽ nuốt
// với id='tem-sua' → lỗi 'invalid input syntax for type uuid'.
router.get('/sua/tem-sua/cancelable', rbac('SUA'), c.temSuaList);
router.get('/sua/tem-sua/deleted', rbac('SUA'), c.temSuaDeletedList);
router.post('/sua/tem-sua/huy', rbac('SUA'), c.temSuaHuy);
router.post('/sua/tem-sua/mo', rbac('SUA'), c.temSuaMo);

// Hủy xác nhận KCS / Sửa / OQC (lỡ xác nhận lộn / nhập sai số) — trang Hủy lệnh xác nhận
router.get('/kcs/cancelable', rbac('KCS'), c.cancelKcsList);
router.post('/kcs/:id/huy', rbac('KCS'), c.cancelKcs);
router.get('/sua/cancelable', rbac('SUA'), c.cancelSuaList);
router.post('/sua/:id/huy', rbac('SUA'), c.cancelSua);
router.get('/oqc/cancelable', rbac('OQC'), c.cancelOqcList);
router.post('/oqc/:id/huy', rbac('OQC'), c.cancelOqc);

// Lịch sử QC trả về (toggle READY/TEST_RUN/OQC)
router.get('/qc-tra-ve', rbac('QC_TRAVE_VIEW'), c.qcTraVeHistory);

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

// Danh mục trường hợp giao đặc biệt (OQC dropdown dùng OQC; quản lý dùng GIAODB_MANAGE)
router.get('/giao-dac-biet', rbac('OQC', 'GIAODB_MANAGE'), c.giaoDacBietActive);
router.get('/giao-dac-biet/all', rbac('GIAODB_MANAGE'), c.giaoDacBietList);
router.post('/giao-dac-biet', rbac('GIAODB_MANAGE'), c.giaoDacBietCreate);
router.patch('/giao-dac-biet/:id/active', rbac('GIAODB_MANAGE'), c.giaoDacBietToggle);
router.patch('/giao-dac-biet/:id', rbac('GIAODB_MANAGE'), c.giaoDacBietUpdate);

module.exports = router;
