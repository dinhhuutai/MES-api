'use strict';

const { query, withTransaction } = require('../../config/db');

// Danh sách RÚT GỌN để CHỌN NGƯỜI (combobox owner...) — chỉ id/họ tên/username, KHÔNG kèm
// email/SĐT/vai trò/phòng ban. Dùng cho màn nghiệp vụ (vd OQC chọn owner cho giao) nên chỉ cần
// đăng nhập, không đòi USER_VIEW (quyền quản trị user) — xem users.routes.
async function listOptions({ search = '', limit = 500 }) {
  const { rows } = await query(
    `SELECT u.id, u.ho_ten, u.ten_dang_nhap
     FROM nguoi_dung u
     WHERE u.dang_hoat_dong = true
       AND ($1 = '' OR u.ho_ten ILIKE '%'||$1||'%' OR u.ten_dang_nhap ILIKE '%'||$1||'%')
     ORDER BY u.ho_ten NULLS LAST, u.ten_dang_nhap
     LIMIT $2`.replace(/\s+/g, ' '),
    [search, limit]
  );
  return rows;
}

async function list({ search = '', active = null, offset = 0, limit = 20 }) {
  const params = [search, limit, offset];
  let activeCond = '';
  if (active === true || active === false) {
    params.push(active);
    activeCond = ` AND u.dang_hoat_dong = $${params.length}`;
  }
  const where = `WHERE ($1 = '' OR u.ho_ten ILIKE '%'||$1||'%' OR u.ten_dang_nhap ILIKE '%'||$1||'%'
                 OR u.ma_user ILIKE '%'||$1||'%')${activeCond}`;

  const dataSql = `
    SELECT u.id, u.ma_user, u.ten_dang_nhap, u.ho_ten, u.email, u.so_dien_thoai, u.chuc_vu,
           u.gioi_tinh, u.avatar_url, u.trang_thai, u.dang_hoat_dong, u.phong_ban_id, pb.ten_phong_ban,
           COALESCE(array_agg(r.ma_role) FILTER (WHERE r.id IS NOT NULL), '{}') AS roles
    FROM nguoi_dung u
    LEFT JOIN phong_ban pb ON pb.id = u.phong_ban_id
    LEFT JOIN user_role ur ON ur.user_id = u.id
    LEFT JOIN vai_tro r ON r.id = ur.role_id
    ${where}
    GROUP BY u.id, pb.ten_phong_ban
    ORDER BY u.created_date DESC
    LIMIT $2 OFFSET $3`;
  const countSql = `SELECT count(*)::int AS total FROM nguoi_dung u ${where}`;

  const [data, count] = await Promise.all([
    query(dataSql, params),
    query(countSql, active === null ? [search] : [search, active]),
  ]);
  return { rows: data.rows, total: count.rows[0].total };
}

async function findById(id) {
  const sql = `
    SELECT u.id, u.ma_user, u.ten_dang_nhap, u.ho_ten, u.email, u.so_dien_thoai, u.chuc_vu,
           u.gioi_tinh, u.avatar_url, u.trang_thai, u.dang_hoat_dong, u.phong_ban_id, pb.ten_phong_ban,
           COALESCE(array_agg(DISTINCT r.id) FILTER (WHERE r.id IS NOT NULL), '{}') AS role_ids
    FROM nguoi_dung u
    LEFT JOIN phong_ban pb ON pb.id = u.phong_ban_id
    LEFT JOIN user_role ur ON ur.user_id = u.id
    LEFT JOIN vai_tro r ON r.id = ur.role_id
    WHERE u.id = $1
    GROUP BY u.id, pb.ten_phong_ban`;
  const { rows } = await query(sql, [id]);
  return rows[0] || null;
}

async function existsUsername(tenDangNhap) {
  const { rows } = await query('SELECT 1 FROM nguoi_dung WHERE ten_dang_nhap = $1', [tenDangNhap]);
  return rows.length > 0;
}

async function nextMaUser() {
  // Sinh mã U#### tăng dần.
  const { rows } = await query(
    `SELECT 'U' || LPAD((COALESCE(MAX(NULLIF(regexp_replace(ma_user,'\\D','','g'),''))::int,0)+1)::text, 4, '0') AS ma
     FROM nguoi_dung`
  );
  return rows[0].ma;
}

async function create(data, actorId) {
  const sql = `
    INSERT INTO nguoi_dung
      (ma_user, ten_dang_nhap, mat_khau_hash, ho_ten, email, so_dien_thoai, chuc_vu,
       gioi_tinh, phong_ban_id, trang_thai, dang_hoat_dong, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING id`;
  const { rows } = await query(sql, [
    data.maUser, data.tenDangNhap, data.matKhauHash, data.hoTen, data.email || null,
    data.soDienThoai || null, data.chucVu || null, data.gioiTinh || null, data.phongBanId || null,
    data.trangThai || 'ACTIVE', data.dangHoatDong !== false, actorId,
  ]);
  return rows[0].id;
}

async function update(id, data, actorId) {
  const sql = `
    UPDATE nguoi_dung SET
      ho_ten = COALESCE($2, ho_ten),
      email = $3,
      so_dien_thoai = $4,
      chuc_vu = $5,
      phong_ban_id = $6,
      trang_thai = COALESCE($7, trang_thai),
      gioi_tinh = $9,
      updated_by = $8,
      updated_date = CURRENT_TIMESTAMP
    WHERE id = $1`;
  await query(sql, [
    id, data.hoTen ?? null, data.email ?? null, data.soDienThoai ?? null,
    data.chucVu ?? null, data.phongBanId ?? null, data.trangThai ?? null, actorId,
    data.gioiTinh ?? null,
  ]);
}

async function setActive(id, active, actorId) {
  await query(
    'UPDATE nguoi_dung SET dang_hoat_dong = $2, updated_by = $3, updated_date = CURRENT_TIMESTAMP WHERE id = $1',
    [id, active, actorId]
  );
}

async function setPassword(id, hash, actorId) {
  await query(
    'UPDATE nguoi_dung SET mat_khau_hash = $2, updated_by = $3, updated_date = CURRENT_TIMESTAMP WHERE id = $1',
    [id, hash, actorId]
  );
}

// Thay toàn bộ role của user (cần quyền DELETE trên user_role — xem 006_grant_rbac_delete.sql).
async function setRoles(userId, roleIds, actorId) {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM user_role WHERE user_id = $1', [userId]);
    for (const rid of roleIds) {
      await client.query(
        'INSERT INTO user_role (user_id, role_id, created_by) VALUES ($1,$2,$3) ON CONFLICT (user_id, role_id) DO NOTHING',
        [userId, rid, actorId]
      );
    }
  });
}

module.exports = {
  list, listOptions, findById, existsUsername, nextMaUser, create, update, setActive, setPassword, setRoles,
};
