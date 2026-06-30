'use strict';

const { query } = require('../../config/db');

// Ghi 1 lần điều hướng trang.
async function insertNav({ userId, duongDan, tieuDe, ip }) {
  await query(
    `INSERT INTO nhat_ky_dieu_huong (nguoi_dung_id, duong_dan, tieu_de, dia_chi_ip)
     VALUES ($1,$2,$3,$4)`,
    [userId, (duongDan || '').slice(0, 255), tieuDe ? tieuDe.slice(0, 255) : null, ip ? ip.slice(0, 64) : null]
  );
}

// Lịch sử điều hướng theo ngày (giờ VN). userId tùy chọn.
async function listHistory({ date, userId, limit = 500 }) {
  const params = [];
  const where = [];
  if (date) {
    params.push(date);
    where.push(`(h.thoi_gian AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $${params.length}`);
  }
  if (userId) {
    params.push(userId);
    where.push(`h.nguoi_dung_id = $${params.length}`);
  }
  params.push(limit);
  const { rows } = await query(
    `SELECT h.id, h.duong_dan, h.tieu_de, h.dia_chi_ip, h.thoi_gian,
            h.nguoi_dung_id, nd.ho_ten AS nguoi, nd.ten_dang_nhap AS username
     FROM nhat_ky_dieu_huong h
     JOIN nguoi_dung nd ON nd.id = h.nguoi_dung_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY h.thoi_gian DESC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

module.exports = { insertNav, listHistory };
