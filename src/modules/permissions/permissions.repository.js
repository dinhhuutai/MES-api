'use strict';

const { query } = require('../../config/db');

async function list({ search = '', module = '' }) {
  const sql = `
    SELECT id, ma_permission, ten_permission, module, action, mo_ta, dang_hoat_dong
    FROM permission
    WHERE ($1 = '' OR ten_permission ILIKE '%'||$1||'%' OR ma_permission ILIKE '%'||$1||'%')
      AND ($2 = '' OR module = $2)
    ORDER BY module NULLS FIRST, ma_permission`;
  const { rows } = await query(sql, [search, module]);
  return rows;
}

async function existsCode(maPermission) {
  const { rows } = await query('SELECT 1 FROM permission WHERE ma_permission = $1', [maPermission]);
  return rows.length > 0;
}

async function create(data, actorId) {
  const { rows } = await query(
    `INSERT INTO permission (ma_permission, ten_permission, module, action, mo_ta, dang_hoat_dong, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [data.maPermission, data.tenPermission, data.module || null, data.action || null,
     data.moTa || null, data.dangHoatDong !== false, actorId]
  );
  return rows[0].id;
}

async function update(id, data, actorId) {
  await query(
    `UPDATE permission SET ten_permission = COALESCE($2, ten_permission), module = $3, action = $4,
       mo_ta = $5, updated_by = $6, updated_date = CURRENT_TIMESTAMP WHERE id = $1`,
    [id, data.tenPermission ?? null, data.module ?? null, data.action ?? null, data.moTa ?? null, actorId]
  );
}

async function setActive(id, active, actorId) {
  await query(
    'UPDATE permission SET dang_hoat_dong = $2, updated_by = $3, updated_date = CURRENT_TIMESTAMP WHERE id = $1',
    [id, active, actorId]
  );
}

module.exports = { list, existsCode, create, update, setActive };
