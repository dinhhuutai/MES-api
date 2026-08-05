'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const { TRANG_PAIN, loadCauHinhPain, luuCauHinhPain, loadLoaiChuyen } = require('../../utils/phuongAnIn');

// `co_loai_chuyen`: trang có áp được lọc theo LOẠI CHUYỀN không (chỉ mức lệnh/phiếu — xem TRANG_PAIN.muc).
const dungItems = (cf) => TRANG_PAIN.map((t) => ({
  ...t, ...(cf[t.ma] || {}), co_loai_chuyen: t.muc === 'lenh' || t.muc === 'phieu',
}));

// Trả DANH MỤC TRANG (gom theo module) + trạng thái toggle của CẢ 2 chiều (phương án in · loại chuyền),
// kèm danh mục loại chuyền động (đọc từ bảng `loai_chuyen`) để giao diện dựng cột.
const list = asyncHandler(async (req, res) => {
  const [cf, nhomLoaiChuyen] = await Promise.all([loadCauHinhPain(), loadLoaiChuyen()]);
  return ok(res, { items: dungItems(cf), nhom_loai_chuyen: nhomLoaiChuyen });
});

// Lưu nhiều dòng 1 lượt (bật/tắt ở cấp module gửi hết các trang con).
const save = asyncHandler(async (req, res) => {
  await luuCauHinhPain(req.body?.items, req.user.id);
  const [cf, nhomLoaiChuyen] = await Promise.all([loadCauHinhPain(), loadLoaiChuyen()]);
  return ok(res, { items: dungItems(cf), nhom_loai_chuyen: nhomLoaiChuyen }, 'Đã lưu cấu hình hiển thị');
});

module.exports = { list, save };
