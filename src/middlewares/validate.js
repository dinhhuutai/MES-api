'use strict';

const { validationResult } = require('express-validator');
const { fail } = require('../utils/response');

// Chạy sau các rule express-validator; gom lỗi → envelope.
module.exports = function validate(req, res, next) {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    const details = result.array().map((e) => ({ field: e.path, message: e.msg }));
    return fail(res, 'Dữ liệu không hợp lệ', 'VALIDATION_ERROR', details, 422);
  }
  return next();
};
