'use strict';

const service = require('./phien.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');

// Có quyền đăng xuất thiết bị của NGƯỜI KHÁC? Kiểm Ở SERVER — FE gửi gì cũng không lách được.
// (Đăng xuất thiết bị CỦA CHÍNH MÌNH thì không cần quyền — service tự cho qua.)
const coQuyenQuanLy = (req) => {
  const perms = (req.user && req.user.permissions) || [];
  return perms.includes('*') || perms.includes('PHIEN_MANAGE');
};

const danhSach = asyncHandler(async (req, res) => ok(res, await service.danhSach({
  search: req.query.search || '',
  // Mặc định chỉ hiện phiên ĐANG hoạt động — đó là thứ người quản lý cần xử lý.
  chiHoatDong: req.query.tatCa !== '1',
  userId: req.query.userId || null,
})));

const dangXuatPhien = asyncHandler(async (req, res) => {
  const r = await service.dangXuatPhien(req.params.id,
    { actorId: req.user.id, coQuyen: coQuyenQuanLy(req) }, req.body?.lyDo);
  return ok(res, r, `Đã đăng xuất ${r.ho_ten || 'tài khoản'} khỏi ${r.thiet_bi || 'thiết bị'}`);
});

const dangXuatMoiThietBi = asyncHandler(async (req, res) => {
  const r = await service.dangXuatMoiThietBi(req.params.userId,
    { actorId: req.user.id, coQuyen: coQuyenQuanLy(req) }, req.body?.lyDo, req.user.jti || null);
  return ok(res, r, `Đã đăng xuất ${r.so_phien} thiết bị`);
});

module.exports = { danhSach, dangXuatPhien, dangXuatMoiThietBi, coQuyenQuanLy };
