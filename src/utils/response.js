'use strict';

// Envelope chuẩn theo CLAUDE.md §19.

function ok(res, data = {}, message = 'OK', status = 200) {
  return res.status(status).json({ success: true, message, data });
}

function created(res, data = {}, message = 'Tạo thành công') {
  return ok(res, data, message, 201);
}

function fail(res, message = 'Lỗi xử lý', errorCode = 'ERROR', details = [], status = 400) {
  return res.status(status).json({ success: false, message, errorCode, details });
}

module.exports = { ok, created, fail };
