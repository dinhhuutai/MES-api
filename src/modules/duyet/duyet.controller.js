'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const service = require('./duyet.service');

// ⚠ Hàng đợi duyệt CHỈ CẦN ĐĂNG NHẬP; quyền lọc TRONG service:
//   · duyệt được ít nhất 1 loại  → thấy MỌI yêu cầu của loại đó
//   · chỉ gửi được               → chỉ thấy yêu cầu CỦA CHÍNH MÌNH
//   · không thuộc diện nào       → danh sách RỖNG + `co_quyen=false` để FE ẩn menu
//   Đặt `rbac` ở route thì nhóm thứ 2 ăn 403 và không xem được yêu cầu của chính họ.
const danhSach = asyncHandler(async (req, res) => ok(res, await service.danhSach(req.user, req.query)));
const demChoDuyet = asyncHandler(async (req, res) => ok(res, await service.demChoDuyet(req.user)));

const guiDoiPain = asyncHandler(async (req, res) => {
  const kq = await service.guiYeuCauDoiPain(req.user, {
    hsktId: req.body.hsktId,
    phuongAnIn: req.body.phuongAnIn,
    lyDo: req.body.lyDo,
  });
  return ok(res, kq, kq.da_ap_dung
    ? 'Đã đổi phương án in'
    : 'Đã gửi yêu cầu — chờ người duyệt thông qua');
});

const duyet = asyncHandler(async (req, res) =>
  ok(res, await service.duyet(req.user, req.params.id, { ghiChu: req.body && req.body.ghiChu }),
    'Đã duyệt và áp dụng thay đổi'));

const tuChoi = asyncHandler(async (req, res) =>
  ok(res, await service.tuChoi(req.user, req.params.id, { lyDo: req.body && req.body.lyDo }),
    'Đã từ chối yêu cầu'));

const huy = asyncHandler(async (req, res) =>
  ok(res, await service.huy(req.user, req.params.id), 'Đã hủy yêu cầu'));

module.exports = { danhSach, demChoDuyet, guiDoiPain, duyet, tuChoi, huy };
