'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const { TRANG_PAIN, loadCauHinhPain, luuCauHinhPain } = require('../../utils/phuongAnIn');

// Trả DANH MỤC TRANG (gom theo module) kèm trạng thái 4 toggle hiện tại.
const list = asyncHandler(async (req, res) => {
  const cf = await loadCauHinhPain();
  const items = TRANG_PAIN.map((t) => ({ ...t, ...(cf[t.ma] || {}) }));
  return ok(res, { items });
});

// Lưu nhiều dòng 1 lượt (bật/tắt ở cấp module gửi hết các trang con).
const save = asyncHandler(async (req, res) => {
  await luuCauHinhPain(req.body?.items, req.user.id);
  const cf = await loadCauHinhPain();
  return ok(res, { items: TRANG_PAIN.map((t) => ({ ...t, ...(cf[t.ma] || {}) })) }, 'Đã lưu cấu hình hiển thị');
});

module.exports = { list, save };
