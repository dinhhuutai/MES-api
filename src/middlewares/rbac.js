'use strict';

const { fail } = require('../utils/response');

// Kiểm tra người dùng có ÍT NHẤT MỘT trong các permission yêu cầu.
// Dùng sau middleware auth. Vd: router.get('/', auth, rbac('USER_VIEW'), ...)
// Role ADMIN (có permission '*') bỏ qua kiểm tra.
module.exports = function rbac(...required) {
  return function (req, res, next) {
    const perms = (req.user && req.user.permissions) || [];
    if (perms.includes('*')) return next();
    const allowed = required.some((p) => perms.includes(p));
    if (!allowed) {
      return fail(res, 'Không có quyền thực hiện', 'FORBIDDEN', required, 403);
    }
    return next();
  };
};
