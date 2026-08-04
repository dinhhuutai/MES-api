'use strict';

const service = require('./hskt.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const { getPaging } = require('../../utils/pagination');

// Lọc chạy ở SERVER (danh sách phân trang server-side) — xem `hskt.repository.HSKT_FILTER_COLS`.
const FILTER_KEYS = ['khach', 'don', 'maHang', 'mauVai', 'kichVai', 'kichPhim', 'codePhan', 'loaiDotVai',
  'phuongAnIn', 'gomSet', 'suaTay', 'tuNgay', 'denNgay'];

const list = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  const filters = {};
  FILTER_KEYS.forEach((k) => { if (req.query[k]) filters[k] = req.query[k]; });
  return ok(res, await service.list({ search: req.query.search || '', filters, page, limit, offset }));
});

const byPhanIn = asyncHandler(async (req, res) => ok(res, await service.byPhanIn(req.params.phanInId)));
// `?kieu=qr` → nội dung là CODE PHẦN · `?kieu=barcode` → barcode HSKT (so 11 số đầu) · bỏ trống → tự dò.
const byBarcode = asyncHandler(async (req, res) =>
  ok(res, await service.byBarcode(req.params.barcode, req.query.kieu)));
const detail = asyncHandler(async (req, res) => ok(res, await service.detail(req.params.id)));

const changePhuongAnIn = asyncHandler(async (req, res) =>
  ok(res, await service.changePhuongAnIn(req.params.id, req.body.phuong_an_in, req.user.id), 'Đã đổi phương án in'));

module.exports = { list, byPhanIn, byBarcode, detail, changePhuongAnIn };
