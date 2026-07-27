'use strict';

const service = require('./hskt.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const { getPaging } = require('../../utils/pagination');

const list = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  return ok(res, await service.list({ search: req.query.search || '', page, limit, offset }));
});

const byPhanIn = asyncHandler(async (req, res) => ok(res, await service.byPhanIn(req.params.phanInId)));
const byBarcode = asyncHandler(async (req, res) => ok(res, await service.byBarcode(req.params.barcode)));
const detail = asyncHandler(async (req, res) => ok(res, await service.detail(req.params.id)));

const changePhuongAnIn = asyncHandler(async (req, res) =>
  ok(res, await service.changePhuongAnIn(req.params.id, req.body.phuong_an_in, req.user.id), 'Đã đổi phương án in'));

module.exports = { list, byPhanIn, byBarcode, detail, changePhuongAnIn };
