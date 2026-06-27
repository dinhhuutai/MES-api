'use strict';

const service = require('./technical.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const { getPaging } = require('../../utils/pagination');

const config = asyncHandler(async (req, res) => ok(res, await service.getConfig()));

const candidates = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  const data = await service.listCandidates({ search: req.query.search || '', page, limit, offset });
  return ok(res, data);
});

const detail = asyncHandler(async (req, res) => ok(res, await service.getDetail(req.params.phanInId)));

const saveDraft = asyncHandler(async (req, res) =>
  ok(res, await service.saveDraft(req.params.phanInId, req.body, req.user.id), 'Đã lưu tạm'));

const confirmTech = asyncHandler(async (req, res) =>
  ok(res, await service.confirmTech(req.params.phanInId, req.user.id), 'Đã xác nhận kỹ thuật'));

const confirmQC = asyncHandler(async (req, res) =>
  ok(res, await service.confirmQC(req.params.phanInId, req.user.id), 'Đã QC xác nhận — READY hoàn thành'));

module.exports = { config, candidates, detail, saveDraft, confirmTech, confirmQC };
