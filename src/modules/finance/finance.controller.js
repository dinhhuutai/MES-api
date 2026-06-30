'use strict';

const service = require('./finance.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const { getPaging } = require('../../utils/pagination');

const list = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  const data = await service.listDonHang({
    search: req.query.search || '',
    status: req.query.status || '',
    page, limit, offset,
  });
  return ok(res, data);
});

const getOne = asyncHandler(async (req, res) => ok(res, await service.getCongNo(req.params.id)));

const save = asyncHandler(async (req, res) => ok(res, await service.saveCongNo(req.params.id, {
  tongTien: req.body.tongTien, daThu: req.body.daThu, ghiChu: req.body.ghiChu,
}, req.user.id), 'Đã lưu công nợ'));

const confirm = asyncHandler(async (req, res) =>
  ok(res, await service.confirm(req.params.id, req.user.id), 'Đã đóng tài chính (CLOSED_FINANCE)'));

const history = asyncHandler(async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  return ok(res, await service.history(date));
});

module.exports = { list, getOne, save, confirm, history };
