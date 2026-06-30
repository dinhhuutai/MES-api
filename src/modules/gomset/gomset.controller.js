'use strict';

const service = require('./gomset.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok, created } = require('../../utils/response');
const { getPaging } = require('../../utils/pagination');

const candidates = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  return ok(res, await service.listCandidates({ search: req.query.search || '', page, limit, offset }));
});

const list = asyncHandler(async (req, res) => ok(res, await service.listSets({ search: req.query.search || '' })));

const history = asyncHandler(async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  return ok(res, await service.gomHistory(date));
});

const detail = asyncHandler(async (req, res) => ok(res, await service.getSetDetail(req.params.id)));

const create = asyncHandler(async (req, res) => created(res, await service.createSet(req.body, req.user.id), 'Đã tạo set'));

const addItems = asyncHandler(async (req, res) =>
  ok(res, await service.addToSet(req.params.id, req.body, req.user.id), 'Đã thêm đợt vải vào set'));

const removeItem = asyncHandler(async (req, res) =>
  ok(res, await service.removeFromSet(req.params.id, req.params.dotVaiId, req.user.id), 'Đã gỡ đợt vải khỏi set'));

const cancel = asyncHandler(async (req, res) =>
  ok(res, await service.cancelSet(req.params.id, req.user.id), 'Đã hủy set'));

module.exports = { candidates, list, history, detail, create, addItems, removeItem, cancel };
