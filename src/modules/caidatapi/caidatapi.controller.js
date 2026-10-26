'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const { getPaging } = require('../../utils/pagination');
const service = require('./caidatapi.service');

const list = asyncHandler(async (req, res) => ok(res, { items: await service.danhSach() }));

const save = asyncHandler(async (req, res) =>
  ok(res, { items: await service.luu(req.body?.items, req.user.id) }, 'Đã lưu cài đặt API'));

const thu = asyncHandler(async (req, res) => ok(res, await service.thuKetNoi(req.params.ma)));

// Lịch sử gọi API (lấy mã tem / báo ERP in tem) — lọc ngày + tìm theo IDMES hoặc mã tem.
const lichSu = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  const q = req.query;
  // Lọc theo trường (26/10/2026): code phần · ngày ca · chuyền · đơn hàng · mã hàng · kích (vải/phim) · màu vải.
  const s = (k) => String(q[k] || '').trim().slice(0, 80);
  return ok(res, await service.lichSu(req.params.ma, {
    date: q.date || '', search: q.search || '', page, limit, offset,
    loc: { codePhan: s('codePhan'), ngayCa: s('ngayCa'), chuyen: s('chuyen'), don: s('don'), maHang: s('maHang'), kich: s('kich'), mau: s('mau') },
  }));
});

// Gửi lại 1 dòng lịch sử sang ERP (26/09/2026) — xem `guiLai.js`.
const guiLai = asyncHandler(async (req, res) =>
  ok(res, await require('./guiLai').guiLai(req.params.ma, req.params.auditId, req.user.id), 'Đã gửi lại sang ERP'));

// Sửa dữ liệu đã gửi rồi gửi lại (21/10/2026) — xem `suaGuiLai.js`. GET = danh sách trường của thân cũ.
const xemSuaGuiLai = asyncHandler(async (req, res) =>
  ok(res, await require('./suaGuiLai').xemSua(req.params.ma, req.params.auditId)));
const suaGuiLai = asyncHandler(async (req, res) =>
  ok(res, await require('./suaGuiLai').suaGuiLai(req.params.ma, req.params.auditId,
    { gui: req.body?.gui, lyDo: req.body?.lyDo }, req.user.id), 'Đã sửa và gửi lại sang ERP'));

module.exports = { list, save, thu, lichSu, guiLai, xemSuaGuiLai, suaGuiLai };
