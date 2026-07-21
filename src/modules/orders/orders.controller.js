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
    daChuyen: req.query.daChuyen || '',
    page, limit, offset,
    sortKey: req.query.sortKey || '',
    sortDir: req.query.sortDir || '',
  });
  return ok(res, data);
});

const getOne = asyncHandler(async (req, res) => ok(res, await service.getPhanIn(req.params.id)));

const setLoiNhuan = asyncHandler(async (req, res) =>
  ok(res, await service.setLoiNhuan(req.params.id, req.body.loiNhuan, req.user.id), 'Đã cập nhật lợi nhuận')
);

const setChoKho = asyncHandler(async (req, res) =>
  ok(res, await service.setChoKho(req.params.id, req.body.phut, req.user.id), 'Đã cập nhật thời gian chờ khô')
);

const profitHistory = asyncHandler(async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  return ok(res, await service.profitHistory(date));
});

// Hủy phần in (xóa mềm): tìm kiếm để chọn + hủy nhiều phần in.
const searchCancel = asyncHandler(async (req, res) =>
  ok(res, await service.searchForCancel(req.query.q || '', req.query.stage || '')));
const huyPhanIn = asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.phanInIds) ? req.body.phanInIds : [];
  const data = await service.softDeletePhanIn(ids, req.body.lyDo || null, req.user.id);
  return ok(res, data, `Đã hủy (xóa mềm) ${data.count} phần in`);
});

// Mở phần in (khôi phục xóa mềm): danh sách phần in đã hủy + mở lại nhiều phần in.
const listDeleted = asyncHandler(async (req, res) =>
  ok(res, await service.listDeleted(req.query.q || '')));
const moPhanIn = asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.phanInIds) ? req.body.phanInIds : [];
  const data = await service.reopenPhanIn(ids, req.user.id);
  return ok(res, data, `Đã mở lại ${data.count} phần in`);
});

module.exports = { list, listVaiVe, getOne, setChoKho, setLoiNhuan, profitHistory, searchCancel, huyPhanIn, listDeleted, moPhanIn };
