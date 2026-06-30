'use strict';

const service = require('./planning.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok, created } = require('../../utils/response');
const { getPaging } = require('../../utils/pagination');

const release1Candidates = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  return ok(res, await service.listRelease1Candidates({ search: req.query.search || '', page, limit, offset }));
});

const createRelease1 = asyncHandler(async (req, res) =>
  created(res, await service.createRelease1(req.body, req.user.id), 'Đã Release 1 — tạo lệnh sản xuất'));

const release1History = asyncHandler(async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  return ok(res, await service.release1History(date));
});

const releaseSets = asyncHandler(async (req, res) =>
  ok(res, await service.listReleaseSets(req.query.search || '')));

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
  ok(res, await service.confirmTest(req.params.lenhId, 'qa', req.user.id), 'QA đã xác nhận'));

const confirmCNSPBatch = asyncHandler(async (req, res) =>
  ok(res, await service.confirmTestBatch(req.body.lenhIds, 'cnsp', req.user.id), 'CNSP xác nhận hàng loạt'));

const confirmQABatch = asyncHandler(async (req, res) =>
  ok(res, await service.confirmTestBatch(req.body.lenhIds, 'qa', req.user.id), 'QA xác nhận hàng loạt'));

const release2Candidates = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  return ok(res, await service.listRelease2Candidates({ search: req.query.search || '', page, limit, offset }));
});

const approveRelease2 = asyncHandler(async (req, res) =>
  ok(res, await service.approveRelease2(req.params.lenhId, req.user.id), 'Đã Release 2 — sẵn sàng sản xuất'));

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

module.exports = {
  release1Candidates, createRelease1, release1History, releaseSets, releaseSet,
  testRunCandidates, lenhDetail, recordTestRun,
  confirmCNSP, confirmQA, confirmCNSPBatch, confirmQABatch,
  release2Candidates, approveRelease2, approveRelease2Batch, testRunHistory,
  replanCandidates, replan, replanBatch, planHistory,
};
