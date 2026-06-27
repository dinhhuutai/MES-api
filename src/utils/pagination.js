'use strict';

// Chuẩn hóa tham số phân trang từ query string.
function getPaging(query) {
  let page = parseInt(query.page, 10);
  let limit = parseInt(query.limit, 10);
  if (!Number.isInteger(page) || page < 1) page = 1;
  if (!Number.isInteger(limit) || limit < 1) limit = 20;
  if (limit > 200) limit = 200;
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

function buildMeta(page, limit, total) {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

module.exports = { getPaging, buildMeta };
