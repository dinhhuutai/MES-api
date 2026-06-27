'use strict';

const { query } = require('../../config/db');

const PHAN_AGG = `(SELECT string_agg(DISTINCT pin.ma_phan, ', ')
    FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
    JOIN phan_in pin ON pin.id = dv.phan_in_id WHERE lsd.lenh_san_xuat_id = ls.id)`;

// ----- XÁC NHẬN CHẠY -----
async function listProductionCandidates({ search = '', offset = 0, limit = 20 }) {
  const FROM = `
    FROM lenh_san_xuat ls
    JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
    WHERE ls.trang_thai = 'RELEASE_2' AND ($1 = '' OR ls.ma_lenh_san_xuat ILIKE '%'||$1||'%')`;
  const dataSql = `
    SELECT ls.id, ls.ma_lenh_san_xuat, ls.so_luong_release, ls.chuyen_id,
           cs.ma_chuyen, cs.ten_chuyen,
           (SELECT count(*) FROM lenh_sx_dot_vai lsd WHERE lsd.lenh_san_xuat_id = ls.id)::int AS so_dot_vai,
           ${PHAN_AGG} AS phan_list
    ${FROM}
    ORDER BY ls.created_date
    LIMIT $2 OFFSET $3`;
  const countSql = `SELECT count(*)::int AS total ${FROM}`;
  const [data, count] = await Promise.all([
    query(dataSql, [search, limit, offset]),
    query(countSql, [search]),
  ]);
  return { rows: data.rows, total: count.rows[0].total };
}

async function nextMaPhieu() {
  const { rows } = await query(
    `SELECT 'PSX' || LPAD((COALESCE(MAX(NULLIF(regexp_replace(ma_phieu_san_xuat,'\\D','','g'),''))::int,0)+1)::text, 4, '0') AS ma
     FROM phieu_san_xuat`
  );
  return rows[0].ma;
}

async function createPhieu(client, { lenhId, chuyenId, maPhieu }, actorId) {
  const { rows } = await client.query(
    `INSERT INTO phieu_san_xuat (lenh_san_xuat_id, chuyen_id, ma_phieu_san_xuat, trang_thai, tg_bd, created_by)
     VALUES ($1,$2,$3,'DANG_CHAY',CURRENT_TIMESTAMP,$4) RETURNING id`,
    [lenhId, chuyenId, maPhieu, actorId]
  );
  return rows[0].id;
}

async function setLenhTrangThai(client, lenhId, trangThai, actorId) {
  await client.query(
    'UPDATE lenh_san_xuat SET trang_thai=$2, updated_by=$3, updated_date=CURRENT_TIMESTAMP WHERE id=$1',
    [lenhId, trangThai, actorId]
  );
}

async function getLenhBasic(lenhId) {
  const { rows } = await query(
    `SELECT ls.id, ls.ma_lenh_san_xuat, ls.so_luong_release, ls.trang_thai, ls.chuyen_id,
            cs.ma_chuyen, cs.ten_chuyen, ${PHAN_AGG} AS phan_list
     FROM lenh_san_xuat ls LEFT JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
     WHERE ls.id = $1`,
    [lenhId]
  );
  return rows[0] || null;
}

async function getActivePhieu(lenhId) {
  const { rows } = await query(
    `SELECT id, ma_phieu_san_xuat, trang_thai, so_luong_in, tg_bd, tg_kt
     FROM phieu_san_xuat WHERE lenh_san_xuat_id = $1 ORDER BY created_date DESC LIMIT 1`,
    [lenhId]
  );
  return rows[0] || null;
}

async function getPhieuById(phieuId) {
  const { rows } = await query('SELECT id, lenh_san_xuat_id, trang_thai FROM phieu_san_xuat WHERE id=$1', [phieuId]);
  return rows[0] || null;
}

async function getTemsByPhieu(phieuId) {
  const { rows } = await query(
    'SELECT id, ma_tem, so_luong, trang_thai, created_date FROM tem WHERE phieu_san_xuat_id=$1 ORDER BY created_date',
    [phieuId]
  );
  return rows;
}

async function nextMaTem() {
  const { rows } = await query(
    `SELECT 'TEM' || LPAD((COALESCE(MAX(NULLIF(regexp_replace(ma_tem,'\\D','','g'),''))::int,0)+1)::text, 5, '0') AS ma
     FROM tem`
  );
  return rows[0].ma;
}

async function createTem(client, { phieuId, maTem, soLuong }, actorId) {
  const { rows } = await client.query(
    `INSERT INTO tem (phieu_san_xuat_id, ma_tem, so_luong, trang_thai, created_by)
     VALUES ($1,$2,$3,'IN',$4) RETURNING id`,
    [phieuId, maTem, soLuong, actorId]
  );
  return rows[0].id;
}

async function logTemPrint(client, { temId, maTem, actorId }) {
  await client.query(
    `INSERT INTO log_tem (tem_id, ma_tem, nguoi_in_id, tg_in, so_lan_in, created_by)
     VALUES ($1,$2,$3,CURRENT_TIMESTAMP,1,$3)`,
    [temId, maTem, actorId]
  );
}

async function finishPhieu(phieuId, actorId) {
  await query(
    `UPDATE phieu_san_xuat SET trang_thai='HOAN_TAT', tg_kt=CURRENT_TIMESTAMP,
       so_luong_in=(SELECT COALESCE(SUM(so_luong),0) FROM tem WHERE phieu_san_xuat_id=$1),
       updated_by=$2, updated_date=CURRENT_TIMESTAMP WHERE id=$1`,
    [phieuId, actorId]
  );
}

// ----- THEO DÕI CHUYỀN -----
async function monitorRunning() {
  const { rows } = await query(
    `SELECT ps.id AS phieu_id, ls.id AS lenh_id, cs.ma_chuyen, cs.ten_chuyen, ls.ma_lenh_san_xuat,
            ls.so_luong_release AS target, ${PHAN_AGG} AS phan_list,
            (SELECT COALESCE(SUM(t.so_luong),0)::int FROM tem t WHERE t.phieu_san_xuat_id=ps.id) AS printed,
            (SELECT count(*) FROM tem t WHERE t.phieu_san_xuat_id=ps.id)::int AS so_tem
     FROM phieu_san_xuat ps
     JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
     JOIN chuyen_san_xuat cs ON cs.id = ps.chuyen_id
     WHERE ps.trang_thai='DANG_CHAY'
     ORDER BY cs.ma_chuyen`
  );
  return rows;
}

async function monitorQueue() {
  const { rows } = await query(
    `SELECT ls.ma_lenh_san_xuat, ls.so_luong_release AS target, cs.ma_chuyen, cs.ten_chuyen
     FROM lenh_san_xuat ls JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
     WHERE ls.trang_thai='RELEASE_2' ORDER BY cs.ma_chuyen, ls.created_date`
  );
  return rows;
}

// ----- XE PHƠI -----
async function listXePhoi() {
  const { rows } = await query(
    'SELECT id, ma_xe_phoi, ten_xe_phoi FROM xe_phoi WHERE dang_hoat_dong=true ORDER BY ma_xe_phoi'
  );
  return rows;
}

async function listCurrentPhoi() {
  const { rows } = await query(
    `SELECT txp.id AS tem_xe_id, txp.xe_phoi_id, txp.so_luong_phoi, txp.tg_bd_phoi, txp.tg_kt_phoi,
            t.ma_tem, ls.ma_lenh_san_xuat
     FROM tem_xe_phoi txp
     JOIN tem t ON t.id = txp.tem_id
     LEFT JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
     LEFT JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
     WHERE txp.trang_thai='DANG_PHOI'
     ORDER BY txp.tg_kt_phoi`
  );
  return rows;
}

async function listTemChoPhoi({ search = '' }) {
  const { rows } = await query(
    `SELECT t.id AS tem_id, t.ma_tem, t.so_luong, ls.ma_lenh_san_xuat, cs.ma_chuyen
     FROM tem t
     JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
     JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
     LEFT JOIN chuyen_san_xuat cs ON cs.id = ps.chuyen_id
     WHERE t.trang_thai='IN' AND ($1='' OR t.ma_tem ILIKE '%'||$1||'%' OR ls.ma_lenh_san_xuat ILIKE '%'||$1||'%')
     ORDER BY t.created_date`,
    [search]
  );
  return rows;
}

async function addTemToXe(client, { temId, xeId, soLuongPhoi, phut }, actorId) {
  await client.query(
    `INSERT INTO tem_xe_phoi (tem_id, xe_phoi_id, so_luong_phoi, tg_bd_phoi, tg_kt_phoi, trang_thai, created_by)
     VALUES ($1,$2,$3,CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + make_interval(mins => $4), 'DANG_PHOI', $5)`,
    [temId, xeId, soLuongPhoi ?? null, phut || 0, actorId]
  );
  await client.query("UPDATE tem SET trang_thai='DANG_PHOI', updated_by=$2, updated_date=CURRENT_TIMESTAMP WHERE id=$1", [temId, actorId]);
}

async function adjustPhoi(temXeId, phut, actorId) {
  const { rowCount } = await query(
    `UPDATE tem_xe_phoi SET tg_kt_phoi = CURRENT_TIMESTAMP + make_interval(mins => $2),
       updated_by=$3, updated_date=CURRENT_TIMESTAMP WHERE id=$1 AND trang_thai='DANG_PHOI'`,
    [temXeId, phut || 0, actorId]
  );
  return rowCount > 0;
}

// ----- CHỜ KHÔ -----
async function listDryingTems({ search = '' }) {
  const { rows } = await query(
    `SELECT t.id AS tem_id, t.ma_tem, t.so_luong, txp.id AS tem_xe_id, txp.tg_bd_phoi, txp.tg_kt_phoi,
            xp.ma_xe_phoi, ls.ma_lenh_san_xuat
     FROM tem t
     JOIN tem_xe_phoi txp ON txp.tem_id = t.id AND txp.trang_thai='DANG_PHOI'
     JOIN xe_phoi xp ON xp.id = txp.xe_phoi_id
     LEFT JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
     LEFT JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
     WHERE t.trang_thai='DANG_PHOI' AND ($1='' OR t.ma_tem ILIKE '%'||$1||'%')
     ORDER BY txp.tg_kt_phoi`,
    [search]
  );
  return rows;
}

async function confirmDry(client, temId, actorId) {
  await client.query("UPDATE tem SET trang_thai='DA_KHO', updated_by=$2, updated_date=CURRENT_TIMESTAMP WHERE id=$1", [temId, actorId]);
  await client.query(
    `UPDATE tem_xe_phoi SET trang_thai='XONG', tg_kt_phoi=COALESCE(tg_kt_phoi, CURRENT_TIMESTAMP),
       updated_by=$2, updated_date=CURRENT_TIMESTAMP WHERE tem_id=$1 AND trang_thai='DANG_PHOI'`,
    [temId, actorId]
  );
}

async function getTemBasic(temId) {
  const { rows } = await query('SELECT id, ma_tem, trang_thai FROM tem WHERE id=$1', [temId]);
  return rows[0] || null;
}

module.exports = {
  listProductionCandidates, nextMaPhieu, createPhieu, setLenhTrangThai, getLenhBasic,
  getActivePhieu, getPhieuById, getTemsByPhieu, nextMaTem, createTem, logTemPrint, finishPhieu,
  monitorRunning, monitorQueue, listXePhoi, listCurrentPhoi, listTemChoPhoi, addTemToXe, adjustPhoi,
  listDryingTems, confirmDry, getTemBasic,
};
