'use strict';

const { query } = require('../../config/db');

async function listChuyen({ search = '' }) {
  const { rows } = await query(
    `SELECT cs.id, cs.ma_chuyen, cs.ten_chuyen, cs.loai_chuyen_id, cs.dinh_muc_gio, cs.dang_hoat_dong,
            lc.ma_loai AS loai_ma, lc.ten_loai AS loai_ten
     FROM chuyen_san_xuat cs
     LEFT JOIN loai_chuyen lc ON lc.id = cs.loai_chuyen_id
     WHERE ($1 = '' OR cs.ma_chuyen ILIKE '%'||$1||'%' OR cs.ten_chuyen ILIKE '%'||$1||'%' OR lc.ten_loai ILIKE '%'||$1||'%')
     ORDER BY cs.ma_chuyen`.replace(/\s+/g, ' '),
    [search]
  );
  return rows;
}

async function createChuyen(d, actor) {
  const { rows } = await query(
    `INSERT INTO chuyen_san_xuat (ma_chuyen, ten_chuyen, loai_chuyen_id, dinh_muc_gio, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [d.maChuyen, d.tenChuyen, d.loaiChuyenId || null, d.dinhMucGio ?? null, actor]
  );
  return rows[0].id;
}

async function updateChuyen(id, d, actor) {
  await query(
    `UPDATE chuyen_san_xuat SET ten_chuyen = COALESCE($2, ten_chuyen), loai_chuyen_id = $3, dinh_muc_gio = $4,
       updated_by = $5, updated_date = CURRENT_TIMESTAMP WHERE id = $1`,
    [id, d.tenChuyen ?? null, d.loaiChuyenId || null, d.dinhMucGio ?? null, actor]
  );
}

async function setChuyenActive(id, active, actor) {
  await query('UPDATE chuyen_san_xuat SET dang_hoat_dong = $2, updated_by = $3, updated_date = CURRENT_TIMESTAMP WHERE id = $1',
    [id, active, actor]);
}

async function listLoai() {
  const { rows } = await query(
    'SELECT id, ma_loai, ten_loai, dang_hoat_dong FROM loai_chuyen ORDER BY ten_loai'
  );
  return rows;
}

async function createLoai(d, actor) {
  const { rows } = await query(
    'INSERT INTO loai_chuyen (ma_loai, ten_loai, ghi_chu, created_by) VALUES ($1,$2,$3,$4) RETURNING id',
    [d.maLoai, d.tenLoai, d.ghiChu || null, actor]
  );
  return rows[0].id;
}

module.exports = { listChuyen, createChuyen, updateChuyen, setChuyenActive, listLoai, createLoai };
