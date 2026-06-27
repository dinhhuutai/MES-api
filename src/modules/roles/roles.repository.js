'use strict';

const { query, withTransaction } = require('../../config/db');

async function list({ search = '' }) {
  const sql = `
    SELECT r.id, r.ma_role, r.ten_role, r.mo_ta, r.dang_hoat_dong,
           count(DISTINCT rp.permission_id)::int AS so_quyen,
           count(DISTINCT ur.user_id)::int AS so_nguoi_dung
    FROM vai_tro r
    LEFT JOIN role_permission rp ON rp.role_id = r.id
    LEFT JOIN user_role ur ON ur.role_id = r.id
    WHERE ($1 = '' OR r.ten_role ILIKE '%'||$1||'%' OR r.ma_role ILIKE '%'||$1||'%')
    GROUP BY r.id
    ORDER BY r.ma_role`;
  const { rows } = await query(sql, [search]);
  return rows;
}

async function findById(id) {
  const sql = `
    SELECT r.id, r.ma_role, r.ten_role, r.mo_ta, r.dang_hoat_dong,
           COALESCE(array_agg(rp.permission_id) FILTER (WHERE rp.permission_id IS NOT NULL), '{}') AS permission_ids
    FROM vai_tro r
    LEFT JOIN role_permission rp ON rp.role_id = r.id
    WHERE r.id = $1
    GROUP BY r.id`;
  const { rows } = await query(sql, [id]);
  return rows[0] || null;
}

async function existsCode(maRole) {
  const { rows } = await query('SELECT 1 FROM vai_tro WHERE ma_role = $1', [maRole]);
  return rows.length > 0;
}

async function create(data, actorId) {
  const { rows } = await query(
    `INSERT INTO vai_tro (ma_role, ten_role, mo_ta, dang_hoat_dong, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [data.maRole, data.tenRole, data.moTa || null, data.dangHoatDong !== false, actorId]
  );
  return rows[0].id;
}

async function update(id, data, actorId) {
  await query(
    `UPDATE vai_tro SET ten_role = COALESCE($2, ten_role), mo_ta = $3,
       updated_by = $4, updated_date = CURRENT_TIMESTAMP WHERE id = $1`,
    [id, data.tenRole ?? null, data.moTa ?? null, actorId]
  );
}

async function setActive(id, active, actorId) {
  await query(
    'UPDATE vai_tro SET dang_hoat_dong = $2, updated_by = $3, updated_date = CURRENT_TIMESTAMP WHERE id = $1',
    [id, active, actorId]
  );
}

// Thay toàn bộ permission của role (cần DELETE trên role_permission — xem 006_grant_rbac_delete.sql).
async function setPermissions(roleId, permissionIds, actorId) {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM role_permission WHERE role_id = $1', [roleId]);
    for (const pid of permissionIds) {
      await client.query(
        'INSERT INTO role_permission (role_id, permission_id, created_by) VALUES ($1,$2,$3) ON CONFLICT (role_id, permission_id) DO NOTHING',
        [roleId, pid, actorId]
      );
    }
  });
}

module.exports = { list, findById, existsCode, create, update, setActive, setPermissions };
