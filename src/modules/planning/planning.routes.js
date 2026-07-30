'use strict';

const express = require('express');
const c = require('./planning.controller');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

const router = express.Router();
router.use(auth);

const TEST_VIEW = ['TESTRUN_CNSP', 'TESTRUN_QA', 'RELEASE1', 'RELEASE2'];

// Cài đặt ca theo tuần (Ngắn/Dài)
router.get('/ca-tuan', rbac('RELEASE1', 'RELEASE2'), c.listCaTuan);
router.post('/ca-tuan', rbac('RELEASE1', 'RELEASE2'), c.upsertCaTuan);

// Kế hoạch tự động (đề xuất chuyền tối ưu theo năng suất — nguồn = candidate Release 1)
router.get('/auto-plan/candidates', rbac('RELEASE1'), c.autoPlanCandidates);

// Gộp số lượng đợt vải (Kế hoạch)
router.get('/gop/candidates', rbac('RELEASE1'), c.gopCandidates);
router.get('/gop/history', rbac('RELEASE1'), c.gopHistory);
router.post('/gop', rbac('RELEASE1'), c.gopDotVai);

// Release 1 (Kế hoạch)
router.get('/release1/candidates', rbac('RELEASE1'), c.release1Candidates);
router.get('/release1/history', rbac('RELEASE1'), c.release1History);
router.get('/release-list', rbac('RELEASE1'), c.releaseList);
router.get('/release1/done', rbac('RELEASE1'), c.release1Done);
router.get('/release1/sets', rbac('RELEASE1'), c.releaseSets);
router.post('/release1/set/:setId', rbac('RELEASE1'), c.releaseSet);
router.post('/release1', rbac('RELEASE1'), c.createRelease1);
// Trả đợt vải ở Release 1 NGƯỢC về Kỹ thuật (mở lại READY: hủy xác nhận Khuôn/Film/Mực/QC + cờ làm lại).
router.post('/release1/tra-ve-ky-thuat', rbac('RELEASE1'), c.release1TraVeKyThuat);

// Tạo Đợt sản xuất (màn "Tạo đợt sản xuất" — gộp/tách nhiều đợt vải + SL từng đợt)
router.post('/dot-san-xuat', rbac('RELEASE1'), c.createDotSanXuat);

// Test Run (CNSP + QA)
router.get('/test-run/candidates', rbac(...TEST_VIEW), c.testRunCandidates);
router.get('/test-run/history', rbac(...TEST_VIEW), c.testRunHistory);
router.get('/test-run/cnsp-done', rbac(...TEST_VIEW), c.testCnspDone);
router.get('/test-run/qa-done', rbac(...TEST_VIEW), c.testQaDone);
router.get('/lenh/:lenhId', rbac(...TEST_VIEW), c.lenhDetail);
router.post('/test-run/cnsp-confirm-batch', rbac('TESTRUN_CNSP'), c.confirmCNSPBatch);
router.post('/test-run/qa-confirm-batch', rbac('TESTRUN_QA'), c.confirmQABatch);
router.post('/test-run/:lenhId/run', rbac('TESTRUN_CNSP', 'TESTRUN_QA'), c.recordTestRun);
router.post('/test-run/:lenhId/confirm-cnsp', rbac('TESTRUN_CNSP'), c.confirmCNSP);
router.post('/test-run/:lenhId/confirm-qa', rbac('TESTRUN_QA'), c.confirmQA);
// "Không test run": bỏ Test Run → duyệt thẳng Release 2 (đợt SX vào chờ sản xuất).
router.post('/test-run/:lenhId/skip', rbac('TESTRUN_QA', 'RELEASE2'), c.skipTestRun);
router.post('/test-run/:lenhId/cancel-cnsp', rbac('TESTRUN_CNSP'), c.cancelCNSP);
router.post('/test-run/:lenhId/cancel-qa', rbac('TESTRUN_QA'), c.cancelQA);
// Test Run QC trả về Release 1 (hủy lệnh, đợt vải về pool) — kèm lý do.
// Test không đạt → trả về KỸ THUẬT (READY) theo mục rớt; lệnh GIỮ NGUYÊN để QC xong nhảy lại Test Run.
router.post('/test-run/:lenhId/tra-ve-ky-thuat', rbac('TESTRUN_QA'), c.returnTestRunToReady);

// Release 2 (Kế hoạch duyệt cuối)
router.get('/release2/candidates', rbac('RELEASE2'), c.release2Candidates);
router.post('/release2/batch', rbac('RELEASE2'), c.approveRelease2Batch);
router.post('/release2/:lenhId', rbac('RELEASE2'), c.approveRelease2);

// Lập kế hoạch lại + lịch sử kế hoạch (Release 2 + lập lại) — dùng chung quyền module Kế hoạch
router.get('/plan-history', rbac('RELEASE1', 'RELEASE2'), c.planHistory);
router.get('/release2/done', rbac('RELEASE2'), c.release2Done);
router.get('/replan/done', rbac('RELEASE1', 'RELEASE2'), c.replanDone);
router.get('/replan/candidates', rbac('RELEASE1', 'RELEASE2'), c.replanCandidates);
router.post('/replan/batch', rbac('RELEASE1', 'RELEASE2'), c.replanBatch);
router.post('/replan/:lenhId', rbac('RELEASE1', 'RELEASE2'), c.replan);

// Gia công: Kế hoạch nhận lại hàng gia công → chuyển OQC
router.get('/gia-cong', rbac('RELEASE1', 'RELEASE2'), c.giaCongList);
router.get('/gia-cong/history', rbac('RELEASE1', 'RELEASE2'), c.giaCongHistory);
router.post('/gia-cong/:lenhId/chuyen-oqc', rbac('RELEASE1', 'RELEASE2'), c.giaCongToOqc);

// Kế hoạch tạm: xác nhận lại Release 1 khi phần in Ready xong
router.get('/ke-hoach-tam', rbac('RELEASE1', 'RELEASE2'), c.keHoachTamList);
// ĐẶT TRƯỚC các route có tham số để 'history'/'done' không bị hiểu thành :id.
router.get('/ke-hoach-tam/history', rbac('RELEASE1', 'RELEASE2'), c.keHoachTamHistory);
router.get('/ke-hoach-tam/done', rbac('RELEASE1', 'RELEASE2'), c.keHoachTamDone);
// Lập kế hoạch tạm cho CẢ GOM SET chưa đủ Ready (đặt trước ':id' để 'set' không bị hiểu thành id).
router.post('/ke-hoach-tam/set/:setId', rbac('RELEASE1', 'RELEASE2'), c.keHoachTamSet);
router.post('/ke-hoach-tam/:id/xac-nhan', rbac('RELEASE1', 'RELEASE2'), c.keHoachTamConfirm);
router.patch('/ke-hoach-tam/:id', rbac('RELEASE1', 'RELEASE2'), c.keHoachTamUpdate);
router.delete('/ke-hoach-tam/:id', rbac('RELEASE1', 'RELEASE2'), c.keHoachTamDelete);

// Hủy lệnh / hoàn tác release (đưa đợt vải về lại Release 1)
router.get('/huy-lenh/candidates', rbac('RELEASE1', 'RELEASE2'), c.cancelableLenh);
router.post('/huy-lenh/:lenhId', rbac('RELEASE1', 'RELEASE2'), c.cancelLenh);

module.exports = router;
