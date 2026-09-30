'use strict';

const { fail } = require('../utils/response');

// Quyền "XEM MODULE HỆ THỐNG" (30/09/2026) — gương FE `constants/modules.QUYEN_XEM_HE_THONG`.
// Người có quyền này ĐỌC được (GET) mọi API để xem các trang Hệ thống; mọi lệnh GHI (POST/PUT/PATCH/
// DELETE) vẫn đòi đúng quyền thật của route ⇒ chỉ xem, không sửa được gì.
// ⚠ Mở theo PHƯƠNG THỨC (GET) chứ không liệt kê route: trang Hệ thống đọc dữ liệu của nhiều module (vd
//   "Hủy lệnh xác nhận" đọc danh sách của planning/production/quality) — liệt kê tay là chắc chắn sót.
//   Đổi lại người có quyền này đọc được mọi API GET (chỉ đọc) — đã chấp nhận.
const QUYEN_XEM_HE_THONG = 'HE_THONG_XEM';

// Kiểm tra người dùng có ÍT NHẤT MỘT trong các permission yêu cầu.
// Dùng sau middleware auth. Vd: router.get('/', auth, rbac('USER_VIEW'), ...)
// Role ADMIN (có permission '*') bỏ qua kiểm tra.
module.exports = function rbac(...required) {
  return function (req, res, next) {
    const perms = (req.user && req.user.permissions) || [];
    if (perms.includes('*')) return next();
    const allowed = required.some((p) => perms.includes(p))
      || (req.method === 'GET' && perms.includes(QUYEN_XEM_HE_THONG));
    if (!allowed) {
      return fail(res, 'Không có quyền thực hiện', 'FORBIDDEN', required, 403);
    }
    return next();
  };
};

module.exports.QUYEN_XEM_HE_THONG = QUYEN_XEM_HE_THONG;
