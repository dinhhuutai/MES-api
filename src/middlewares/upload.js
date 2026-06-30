'use strict';

const multer = require('multer');
const AppError = require('../utils/AppError');

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

// Lưu vào RAM (file.buffer) — service tự ghi xuống đĩa.
const instance = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => {
    if (IMAGE_MIMES.has((file.mimetype || '').toLowerCase())) return cb(null, true);
    return cb(new AppError('Chỉ chấp nhận ảnh JPG, PNG, WEBP hoặc GIF', {
      status: 400, errorCode: 'INVALID_FILE_TYPE',
    }));
  },
});

// Bọc multer.single để chuyển MulterError → AppError (envelope chuẩn).
function singleImage(field) {
  return (req, res, next) => {
    instance.single(field)(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Ảnh vượt quá 5MB' : 'Tải ảnh thất bại';
        return next(new AppError(msg, { status: 400, errorCode: err.code }));
      }
      return next(err); // AppError từ fileFilter hoặc lỗi khác
    });
  };
}

module.exports = { singleImage };
