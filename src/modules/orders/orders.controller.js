'use strict';

const service = require('./orders.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const { getPaging } = require('../../utils/pagination');

const list = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  const data = await service.listPhanIn({
    search: req.query.search || '',
    missingProfit: req.query.missing_profit === '1' || req.query.missing_profit === 'true',
    page, limit, offset,
  });
  return ok(res, data);
});

const FILTER_KEYS = ['khach', 'don', 'maHang', 'codePhan', 'mauVai', 'kichVai', 'kichPhim', 'ngayVaiTu', 'ngayVaiDen'];
const listVaiVe = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  const filters = {};
  for (const k of FILTER_KEYS) {
    const v = (req.query[k] || '').trim();
    if (v) filters[k] = v;
  }
  const data = await service.listVaiVe({
    search: req.query.search || '',
    filters,
    stage: req.query.stage || '',
    page, limit, offset,
  });
  return ok(res, data);
});

const getOne = asyncHandler(async (req, res) => ok(res, await service.getPhanIn(req.params.id)));

const setLoiNhuan = asyncHandler(async (req, res) =>
  ok(res, await service.setLoiNhuan(req.params.id, req.body.loiNhuan, req.user.id), 'Đã cập nhật lợi nhuận')
);

const profitHistory = asyncHandler(async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  return ok(res, await service.profitHistory(date));
});

module.exports = { list, listVaiVe, getOne, setLoiNhuan, profitHistory };
