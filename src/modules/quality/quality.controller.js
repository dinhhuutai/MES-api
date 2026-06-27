'use strict';

const service = require('./quality.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');

const kcsCandidates = asyncHandler(async (req, res) => ok(res, await service.listKcsCandidates(req.query.search || '')));
const recordKcs = asyncHandler(async (req, res) =>
  ok(res, await service.recordKcs(req.params.temId, req.body, req.user.id), 'Đã ghi nhận KCS'));

const suaCandidates = asyncHandler(async (req, res) => ok(res, await service.listSuaCandidates(req.query.search || '')));
const recordSua = asyncHandler(async (req, res) =>
  ok(res, await service.recordSua(req.params.temId, req.body, req.user.id), 'Đã ghi nhận sửa'));

const oqcCandidates = asyncHandler(async (req, res) => ok(res, await service.listOqcCandidates(req.query.search || '')));
const recordOqc = asyncHandler(async (req, res) =>
  ok(res, await service.recordOqc(req.params.temId, req.body, req.user.id), 'Đã ghi nhận OQC'));

module.exports = { kcsCandidates, recordKcs, suaCandidates, recordSua, oqcCandidates, recordOqc };
