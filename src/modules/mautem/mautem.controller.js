'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const svc = require('./mautem.service');

const danhMuc = asyncHandler(async (req, res) => ok(res, await svc.danhMuc()));

const list = asyncHandler(async (req, res) => ok(res, { items: await svc.list(req.user.id) }));

const chiTiet = asyncHandler(async (req, res) => ok(res, await svc.chiTiet(req.params.id)));

const tao = asyncHandler(async (req, res) => {
  const b = req.body || {};
  const m = await svc.tao({ maMau: b.ma_mau, tenMau: b.ten_mau, moTa: b.mo_ta, boCuc: b.bo_cuc }, req.user.id);
  return ok(res, m, 'Đã tạo mẫu tem');
});

const nhanBan = asyncHandler(async (req, res) => {
  const b = req.body || {};
  const m = await svc.nhanBan(req.params.id, { maMau: b.ma_mau, tenMau: b.ten_mau }, req.user.id);
  return ok(res, m, 'Đã nhân bản mẫu tem');
});

const sua = asyncHandler(async (req, res) => {
  const b = req.body || {};
  // `bo_cuc` chỉ ghi khi CÓ gửi (đổi mỗi tên mẫu thì không đụng bố cục).
  const m = await svc.sua(req.params.id,
    { tenMau: b.ten_mau, moTa: b.mo_ta, ...(b.bo_cuc !== undefined ? { boCuc: b.bo_cuc } : {}) }, req.user.id);
  return ok(res, m, 'Đã lưu mẫu tem');
});

const xoa = asyncHandler(async (req, res) => {
  await svc.xoa(req.params.id, req.user.id);
  return ok(res, { id: req.params.id }, 'Đã xóa mẫu tem');
});

const gan = asyncHandler(async (req, res) => {
  const r = await svc.gan(req.params.maViTri, (req.body || {}).mau_tem_id, req.user.id);
  return ok(res, r, r ? 'Đã gắn mẫu vào nút in' : 'Đã gỡ mẫu — nút in dùng lại bố cục mặc định');
});

// FE gọi NGAY TRƯỚC KHI IN để biết dùng mẫu nào (chưa gắn → mau=null → lùi về bố cục cứng).
const mauChoViTri = asyncHandler(async (req, res) => ok(res, await svc.mauChoViTri(req.params.maViTri)));

module.exports = { danhMuc, list, chiTiet, tao, nhanBan, sua, xoa, gan, mauChoViTri };
