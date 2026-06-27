'use strict';

// Lỗi nghiệp vụ có mã + HTTP status để errorHandler trả envelope thống nhất.
class AppError extends Error {
  constructor(message, { status = 400, errorCode = 'ERROR', details = [] } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.errorCode = errorCode;
    this.details = details;
  }
}

module.exports = AppError;
