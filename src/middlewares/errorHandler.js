'use strict';

const AppError = require('../utils/AppError');
const { fail } = require('../utils/response');

// 404 cho route không khớp.
function notFound(req, res) {
  return fail(res, `Không tìm thấy route: ${req.method} ${req.originalUrl}`, 'NOT_FOUND', [], 404);
}

// Xử lý lỗi tập trung → envelope chuẩn.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return fail(res, err.message, err.errorCode, err.details, err.status);
  }
  // Lỗi vi phạm ràng buộc Postgres → 409.
  if (err && err.code === '23505') {
    return fail(res, 'Dữ liệu đã tồn tại (trùng khóa)', 'DUPLICATE', [err.detail], 409);
  }
  if (err && err.code === '23503') {
    return fail(res, 'Vi phạm khóa ngoại', 'FK_VIOLATION', [err.detail], 409);
  }
  console.error('[error]', err);
  return fail(res, 'Lỗi hệ thống', 'INTERNAL_ERROR', [], 500);
}

module.exports = { notFound, errorHandler };
