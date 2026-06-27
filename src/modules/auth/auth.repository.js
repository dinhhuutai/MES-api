'use strict';

const { query } = require('../../config/db');

async function findByUsername(username) {
  const sql = `
    SELECT u.id, u.ma_user, u.ten_dang_nhap, u.mat_khau_hash, u.ho_ten, u.email,
           u.chuc_vu, u.trang_thai, u.dang_hoat_dong, u.phong_ban_id,
           pb.ten_phong_ban
    FROM nguoi_dung u
    LEFT JOIN phong_ban pb ON pb.id = u.phong_ban_id
    WHERE u.ten_dang_nhap = $1
    LIMIT 1`;
  const { rows } = await query(sql, [username]);
  return rows[0] || null;
}

async function findById(id) {
  const sql = `
    SELECT u.id, u.ma_user, u.ten_dang_nhap, u.ho_ten, u.email, u.chuc_vu,
           u.trang_thai, u.dang_hoat_dong, u.phong_ban_id, pb.ten_phong_ban
    FROM nguoi_dung u
    LEFT JOIN phong_ban pb ON pb.id = u.phong_ban_id
    WHERE u.id = $1
    LIMIT 1`;
  const { rows } = await query(sql, [id]);
  return rows[0] || null;
}

async function getRoles(userId) {
  const sql = `
    SELECT r.ma_role
    FROM vai_tro r
    JOIN user_role ur ON ur.role_id = r.id
    WHERE ur.user_id = $1 AND r.dang_hoat_dong = true`;
  const { rows } = await query(sql, [userId]);
  return rows.map((r) => r.ma_role);
}

// Quyền hiệu lực = (quyền từ role ∪ quyền cấp trực tiếp duoc_phep=true) \ (quyền bị thu hồi duoc_phep=false)
async function getPermissions(userId) {
  const sql = `
    WITH role_perms AS (
      SELECT DISTINCT p.ma_permission
      FROM permission p
      JOIN role_permission rp ON rp.permission_id = p.id
      JOIN user_role ur ON ur.role_id = rp.role_id
      WHERE ur.user_id = $1 AND p.dang_hoat_dong = true
    ),
    grant_perms AS (
      SELECT p.ma_permission
      FROM permission p
      JOIN user_permission up ON up.permission_id = p.id
      WHERE up.user_id = $1 AND up.duoc_phep = true
    ),
    deny_perms AS (
      SELECT p.ma_permission
      FROM permission p
      JOIN user_permission up ON up.permission_id = p.id
      WHERE up.user_id = $1 AND up.duoc_phep = false
    )
    SELECT ma_permission FROM (
      SELECT ma_permission FROM role_perms
      UNION
      SELECT ma_permission FROM grant_perms
    ) t
    WHERE ma_permission NOT IN (SELECT ma_permission FROM deny_perms)`;
  const { rows } = await query(sql, [userId]);
  return rows.map((r) => r.ma_permission);
}

async function updateLastLogin(userId) {
  await query('UPDATE nguoi_dung SET lan_dang_nhap_cuoi = CURRENT_TIMESTAMP WHERE id = $1', [userId]);
}

module.exports = { findByUsername, findById, getRoles, getPermissions, updateLastLogin };
