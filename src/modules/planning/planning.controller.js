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

const release2Candidates = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  return ok(res, await service.listRelease2Candidates({ search: req.query.search || '', page, limit, offset }));
});

const approveRelease2 = asyncHandler(async (req, res) =>
  ok(res, await service.approveRelease2(req.params.lenhId, req.user.id), 'Đã Release 2 — sẵn sàng sản xuất'));

module.exports = {
  release1Candidates, createRelease1, testRunCandidates, lenhDetail, recordTestRun,
  confirmCNSP, confirmQA, release2Candidates, approveRelease2,
};
