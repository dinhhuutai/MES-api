'use strict';

const service = require('./planning.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok, created } = require('../../utils/response');
const { getPaging } = require('../../utils/pagination');

const release1Candidates = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  return ok(res, await service.listRelease1Candidates({ search: req.query.search || '', page, limit, offset }));
});

const autoPlanCandidates = asyncHandler(async (req, res) =>
  ok(res, await service.autoPlanCandidates({ search: req.query.search || '' })));

const createRelease1 = asyncHandler(async (req, res) =>
  created(res, await service.createRelease1(req.body, req.user.id), 'Đã Release 1 — tạo lệnh sản xuất'));

// Tạo Đợt sản xuất (gộp/tách nhiều đợt vải + SL từng đợt vào 1 đợt SX)
const createDotSanXuat = asyncHandler(async (req, res) =>
  created(res, await service.createDotSanXuat(req.body, req.user.id), 'Đã tạo đợt sản xuất'));

const release1History = asyncHandler(async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  return ok(res, await service.release1History(date));
});

const releaseList = asyncHandler(async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  return ok(res, await service.releaseList(date));
});

const releaseSets = asyncHandler(async (req, res) =>
  ok(res, await service.listReleaseSets(req.query.search || '')));

// Gộp số lượng đợt vải
const gopCandidates = asyncHandler(async (req, res) =>
  ok(res, await service.listGopCandidates({ search: req.query.search || '' })));

const gopDotVai = asyncHandler(async (req, res) =>
  ok(res, await service.gopDotVai(req.body, req.user.id), 'Đã gộp số lượng đợt vải'));

const gopHistory = asyncHandler(async (req, res) =>
  ok(res, await service.gopHistory(req.query.date || null)));

const releaseSet = asyncHandler(async (req, res) =>
  created(res, await service.releaseSet(req.params.setId, req.body, req.user.id), 'Đã release set — tạo lệnh sản xuất chung'));

const testRunCandidates = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  return ok(res, await service.listTestRunCandidates({ search: req.query.search || '', page, limit, offset }));
});

const lenhDetail = asyncHandler(async (req, res) => ok(res, await service.getLenhDetail(req.params.lenhId)));

const recordTestRun = asyncHandler(async (req, res) =>
  ok(res, await service.recordTestRun(req.params.lenhId, req.body, req.user.id), 'Đã ghi nhận lần test'));

const confirmCNSP = asyncHandler(async (req, res) =>
  ok(res, await service.confirmTest(req.params.lenhId, 'cnsp', req.user.id), 'CNSP đã xác nhận'));

const confirmQA = asyncHandler(async (req, res) =>
  ok(res, await service.confirmTest(req.params.lenhId, 'qa', req.user.id, {
    soLuong: req.body?.soLuong ?? null,
    nguoiTest: req.body?.nguoiTest ?? null,
    ghiChu: req.body?.ghiChu ?? null,
    loaiTest: req.body?.loaiTest ?? null,
  }), 'QA đã xác nhận test'));

const cancelCNSP = asyncHandler(async (req, res) =>
  ok(res, await service.cancelTest(req.params.lenhId, 'cnsp', req.user.id), 'Đã hủy xác nhận CNSP'));

const cancelQA = asyncHandler(async (req, res) =>
  ok(res, await service.cancelTest(req.params.lenhId, 'qa', req.user.id), 'Đã hủy xác nhận QA'));

const confirmCNSPBatch = asyncHandler(async (req, res) =>
  ok(res, await service.confirmTestBatch(req.body.lenhIds, 'cnsp', req.user.id), 'CNSP xác nhận hàng loạt'));

const confirmQABatch = asyncHandler(async (req, res) =>
  ok(res, await service.confirmTestBatch(req.body.lenhIds, 'qa', req.user.id, {
    nguoiTest: req.body?.nguoiTest ?? null,
    loaiTest: req.body?.loaiTest ?? null,
    ghiChu: req.body?.ghiChu ?? null,
  }), 'QA xác nhận hàng loạt'));

const release2Candidates = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  return ok(res, await service.listRelease2Candidates({ search: req.query.search || '', page, limit, offset }));
});

const approveRelease2 = asyncHandler(async (req, res) =>
  ok(res, await service.approveRelease2(req.params.lenhId, req.user.id), 'Đã Release 2 — sẵn sàng sản xuất'));

const skipTestRun = asyncHandler(async (req, res) =>
  ok(res, await service.skipTestRun(req.params.lenhId, req.user.id), 'Đã bỏ Test Run — đợt sản xuất vào chờ sản xuất'));

const testRunHistory = asyncHandler(async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  return ok(res, await service.testRunHistory(date));
});

const replanCandidates = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  return ok(res, await service.listReplanCandidates({ search: req.query.search || '', page, limit, offset }));
});

const approveRelease2Batch = asyncHandler(async (req, res) =>
  ok(res, await service.approveRelease2Batch(req.body.lenhIds, req.user.id), 'Duyệt Release 2 hàng loạt'));

const replan = asyncHandler(async (req, res) =>
  ok(res, await service.replan(req.params.lenhId, req.body, req.user.id), 'Đã lập lại kế hoạch'));

const replanBatch = asyncHandler(async (req, res) =>
  ok(res, await service.replanBatch(req.body.lenhIds, req.body, req.user.id), 'Lập lại kế hoạch hàng loạt'));

const planHistory = asyncHandler(async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  return ok(res, await service.planHistory(date));
});

const cancelableLenh = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  return ok(res, await service.listCancelableLenh({ search: req.query.search || '', page, limit, offset }));
});

const cancelLenh = asyncHandler(async (req, res) =>
  ok(res, await service.rollbackLenh(req.params.lenhId, req.body, req.user.id), 'Đã hoàn tác chuyển trạm'));

// Test Run QC trả về Release 1 (hủy lệnh + lý do).
const returnTestRun = asyncHandler(async (req, res) =>
  ok(res, await service.returnTestRunToRelease1(req.params.lenhId, req.body, req.user.id), 'Đã trả về Release 1'));

const today = () => new Date().toISOString().slice(0, 10);
const release1Done = asyncHandler(async (req, res) => ok(res, await service.release1Done(req.query.date || today())));
const release2Done = asyncHandler(async (req, res) => ok(res, await service.release2Done(req.query.date || today())));
const replanDone = asyncHandler(async (req, res) => ok(res, await service.replanDone(req.query.date || today())));
const testCnspDone = asyncHandler(async (req, res) => ok(res, await service.testCnspDone(req.query.date || today())));
const testQaDone = asyncHandler(async (req, res) => ok(res, await service.testQaDone(req.query.date || today())));

const listCaTuan = asyncHandler(async (req, res) => ok(res, await service.listCaTuan()));
const upsertCaTuan = asyncHandler(async (req, res) =>
  ok(res, await service.upsertCaTuan(req.body, req.user.id), 'Đã lưu cài đặt ca tuần'));

module.exports = {
  listCaTuan, upsertCaTuan,
  release1Candidates, autoPlanCandidates, createRelease1, createDotSanXuat, release1History, releaseList, releaseSets, releaseSet,
  gopCandidates, gopDotVai, gopHistory,
  testRunCandidates, lenhDetail, recordTestRun,
  confirmCNSP, confirmQA, cancelCNSP, cancelQA, confirmCNSPBatch, confirmQABatch,
  release2Candidates, approveRelease2, approveRelease2Batch, skipTestRun, testRunHistory,
  replanCandidates, replan, replanBatch, planHistory,
  cancelableLenh, cancelLenh, returnTestRun,
  release1Done, release2Done, replanDone, testCnspDone, testQaDone,
};
