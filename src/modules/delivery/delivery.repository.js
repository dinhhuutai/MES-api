'use strict';

const { query } = require('../../config/db');

const DON_SUB = (col, alias) => `(SELECT string_agg(DISTINCT ${col}, ', ')
    FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
    JOIN phan_in pin ON pin.id = dv.phan_in_id
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    WHERE lsd.lenh_san_xuat_id = ls.id) AS ${alias}`;

// Tem OQC đạt, chưa nằm trong phiếu giao nào
async function listTemSanSang({ search = '' }) {
  const { rows } = await query(
    `SELECT t.id AS tem_id, t.ma_tem, t.so_luong, ls.ma_lenh_san_xuat,
            (SELECT string_agg(DISTINCT pin.ma_phan, ', ')
               FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
               JOIN phan_in pin ON pin.id = dv.phan_in_id WHERE lsd.lenh_san_xuat_id = ls.id) AS phan_list,
            ${DON_SUB('dh.ma_don_hang', 'don_list')},
            ${DON_SUB('kh.ten_khach_hang', 'khach_list')}
     FROM tem t
     JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
     JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
     WHERE t.trang_thai = 'OQC_DAT'
       AND NOT EXISTS (SELECT 1 FROM giao_hang_tem gt WHERE gt.tem_id = t.id)
       AND ($1 = '' OR t.ma_tem ILIKE '%'||$1||'%' OR ls.ma_lenh_san_xuat ILIKE '%'||$1||'%')
     ORDER BY t.created_date`,
    [search]
  );
  return rows;
}

async function donHangIdsForTems(temIds) {
  const { rows } = await query(
    `SELECT DISTINCT dh.id
     FROM tem t
     JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
     JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
     JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
     JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
     JOIN phan_in pin ON pin.id = dv.phan_in_id
     JOIN ma_hang mh ON mh.id = pin.ma_hang_id
     JOIN don_hang dh ON dh.id = mh.don_hang_id
     WHERE t.id = ANY($1::uuid[])`,
    [temIds]
  );
  return rows.map((r) => r.id);
}

async function nextMaPhieuGiao() {
  const { rows } = await query(
    `SELECT 'PG' || LPAD((COALESCE(MAX(NULLIF(regexp_replace(ma_phieu_giao,'\\D','','g'),''))::int,0)+1)::text, 4, '0') AS ma
     FROM giao_hang`
  );
  return rows[0].ma;
}

async function createGiaoHang(client, { maPhieu, donHangId, ngayGiao, ghiChu }, actorId) {
  const { rows } = await client.query(
    `INSERT INTO giao_hang (ma_phieu_giao, don_hang_id, ngay_giao, trang_thai, ghi_chu, created_by)
     VALUES ($1,$2,$3,'TAO',$4,$5) RETURNING id`,
    [maPhieu, donHangId, ngayGiao || null, ghiChu || null, actorId]
  );
  return rows[0].id;
}

async function addTem(client, giaoHangId, temId, actorId) {
  await client.query(
    `INSERT INTO giao_hang_tem (giao_hang_id, tem_id, so_luong_giao, created_by)
     SELECT $1, $2, t.so_luong, $3 FROM tem t WHERE t.id = $2
     ON CONFLICT (giao_hang_id, tem_id) DO NOTHING`,
    [giaoHangId, temId, actorId]
  );
}

async function getGiaoHang(giaoHangId) {
  const { rows } = await query(
    `SELECT gh.id, gh.ma_phieu_giao, gh.ngay_giao, gh.trang_thai, gh.ghi_chu, gh.created_date,
            dh.ma_don_hang, kh.ten_khach_hang,
            (SELECT count(*) FROM giao_hang_tem gt WHERE gt.giao_hang_id = gh.id)::int AS so_tem,
            (SELECT COALESCE(SUM(gt.so_luong_giao),0)::int FROM giao_hang_tem gt WHERE gt.giao_hang_id = gh.id) AS tong_sl
     FROM giao_hang gh
     LEFT JOIN don_hang dh ON dh.id = gh.don_hang_id
     LEFT JOIN khach_hang kh ON kh.id = dh.khach_hang_id
     WHERE gh.id = $1`,
    [giaoHangId]
  );
  return rows[0] || null;
}

async function listGiaoHang({ search = '' }) {
  const { rows } = await query(
    `SELECT gh.id, gh.ma_phieu_giao, gh.ngay_giao, gh.trang_thai, gh.created_date,
            dh.ma_don_hang, kh.ten_khach_hang,
            (SELECT count(*) FROM giao_hang_tem gt WHERE gt.giao_hang_id = gh.id)::int AS so_tem,
            (SELECT COALESCE(SUM(gt.so_luong_giao),0)::int FROM giao_hang_tem gt WHERE gt.giao_hang_id = gh.id) AS tong_sl
     FROM giao_hang gh
     LEFT JOIN don_hang dh ON dh.id = gh.don_hang_id
     LEFT JOIN khach_hang kh ON kh.id = dh.khach_hang_id
     WHERE ($1 = '' OR gh.ma_phieu_giao ILIKE '%'||$1||'%' OR kh.ten_khach_hang ILIKE '%'||$1||'%')
     ORDER BY gh.created_date DESC`,
    [search]
  );
  return rows;
}

async function getGiaoHangTems(giaoHangId) {
  const { rows } = await query(
    `SELECT gt.id, gt.so_luong_giao, t.ma_tem, t.trang_thai, ls.ma_lenh_san_xuat
     FROM giao_hang_tem gt
     JOIN tem t ON t.id = gt.tem_id
     LEFT JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
     LEFT JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
     WHERE gt.giao_hang_id = $1
     ORDER BY t.ma_tem`,
    [giaoHangId]
  );
  return rows;
}

async function confirmGiao(client, giaoHangId, actorId) {
  await client.query(
    `UPDATE giao_hang SET trang_thai='DA_GIAO', ngay_giao=COALESCE(ngay_giao, CURRENT_DATE),
       updated_by=$2, updated_date=CURRENT_TIMESTAMP WHERE id=$1`,
    [giaoHangId, actorId]
  );
  await client.query(
    `UPDATE tem SET trang_thai='DA_GIAO', updated_by=$2, updated_date=CURRENT_TIMESTAMP
     WHERE id IN (SELECT tem_id FROM giao_hang_tem WHERE giao_hang_id=$1)`,
    [giaoHangId, actorId]
  );
}

module.exports = {
  listTemSanSang, donHangIdsForTems, nextMaPhieuGiao, createGiaoHang, addTem,
  getGiaoHang, listGiaoHang, getGiaoHangTems, confirmGiao,
};
