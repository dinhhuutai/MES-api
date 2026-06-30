'use strict';

const { query } = require('../../config/db');
const { lenhPhanInMatch } = require('../../utils/search');

const PHAN_AGG = `(SELECT string_agg(DISTINCT pin.ma_phan, ', ')
    FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
    JOIN phan_in pin ON pin.id = dv.phan_in_id WHERE lsd.lenh_san_xuat_id = ls.id)`;

// Thông tin phần in đại diện của 1 lệnh (mỗi đợt vải = 1 LSX → ánh xạ 1-1).
const PHAN_INFO_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang,
           pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.ma_phan, dv.han_giao_hang, dv.so_luong_vai_ve
    FROM lenh_sx_dot_vai lsd
    JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
    JOIN phan_in pin ON pin.id = dv.phan_in_id
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    WHERE lsd.lenh_san_xuat_id = ls.id
    ORDER BY pin.ma_phan, dv.ma_dot_vai
    LIMIT 1
  ) info ON true`;

// ----- XÁC NHẬN CHẠY -----
async function listProductionCandidates({ search = '', offset = 0, limit = 20 }) {
  const FROM = `
    FROM lenh_san_xuat ls
    JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
    ${PHAN_INFO_LATERAL}
    WHERE ls.trang_thai = 'RELEASE_2'
      AND ($1 = '' OR ls.ma_lenh_san_xuat ILIKE '%'||$1||'%' OR ${lenhPhanInMatch('ls.id', '$1')})`;
  const dataSql = `
    SELECT ls.id, ls.ma_lenh_san_xuat, ls.so_luong_release, ls.chuyen_id, ls.ngay_ke_hoach,
           cs.ma_chuyen, cs.ten_chuyen,
           info.ten_khach_hang, info.ma_don_hang, info.ma_hang,
           info.mau_vai, info.kich_vai, info.kich_phim, info.ma_phan,
           info.han_giao_hang, info.so_luong_vai_ve,
           (SELECT count(*) FROM lenh_sx_dot_vai lsd WHERE lsd.lenh_san_xuat_id = ls.id)::int AS so_dot_vai,
           ${PHAN_AGG} AS phan_list
    ${FROM}
    ORDER BY ls.ngay_ke_hoach NULLS LAST, ls.created_date
    LIMIT $2 OFFSET $3`;
  const countSql = `SELECT count(*)::int AS total ${FROM}`;
  const [data, count] = await Promise.all([
    query(dataSql, [search, limit, offset]),
    query(countSql, [search]),
  ]);
  return { rows: data.rows, total: count.rows[0].total };
}

// Tổng số lượng đã in của 1 phiếu (cho luật tối đa 110% SL release).
async function getPrintedTotal(phieuId) {
  const { rows } = await query(
    'SELECT COALESCE(SUM(so_luong),0)::int AS printed FROM tem WHERE phieu_san_xuat_id = $1',
    [phieuId]
  );
  return rows[0].printed;
}

// Xe phơi mặc định (xe hoạt động đầu tiên) — dùng khi in tem tự đưa vào xe.
async function getDefaultXePhoi() {
  const { rows } = await query(
    'SELECT id, ma_xe_phoi FROM xe_phoi WHERE dang_hoat_dong = true ORDER BY ma_xe_phoi LIMIT 1'
  );
  return rows[0] || null;
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
    `SELECT t.id, t.ma_tem, t.so_luong, t.trang_thai, t.created_date,
            (SELECT COALESCE(MAX(lt.so_lan_in),1) FROM log_tem lt WHERE lt.tem_id = t.id)::int AS so_lan_in
     FROM tem t WHERE t.phieu_san_xuat_id=$1 ORDER BY t.created_date`,
    [phieuId]
  );
  return rows;
}

// Ngữ cảnh tem (để in lại + reload đúng lệnh).
async function getTemContext(temId) {
  const { rows } = await query(
    `SELECT t.id, t.ma_tem, ps.lenh_san_xuat_id, ps.trang_thai AS phieu_trang_thai
     FROM tem t JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id WHERE t.id=$1`,
    [temId]
  );
  return rows[0] || null;
}

// Lịch sử in tem của 1 phiếu (in lần đầu + in lại), mới nhất trước.
async function listTemLogByPhieu(phieuId) {
  const { rows } = await query(
    `SELECT lt.id, lt.ma_tem, lt.so_lan_in, lt.ly_do_in_lai, lt.tg_in, nd.ho_ten AS nguoi
     FROM log_tem lt
     JOIN tem t ON t.id = lt.tem_id
     LEFT JOIN nguoi_dung nd ON nd.id = lt.nguoi_in_id
     WHERE t.phieu_san_xuat_id = $1
     ORDER BY lt.tg_in DESC, lt.so_lan_in DESC`,
    [phieuId]
  );
  return rows;
}

async function nextReprint(temId) {
  const { rows } = await query(
    'SELECT COALESCE(MAX(so_lan_in),0)+1 AS lan FROM log_tem WHERE tem_id=$1',
    [temId]
  );
  return rows[0].lan;
}

async function logReprint(temId, maTem, lyDo, soLan, actorId) {
  await query(
    `INSERT INTO log_tem (tem_id, ma_tem, nguoi_in_id, tg_in, so_lan_in, ly_do_in_lai, created_by)
     VALUES ($1,$2,$3,CURRENT_TIMESTAMP,$4,$5,$3)`,
    [temId, maTem, actorId, soLan, lyDo || null]
  );
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
    `SELECT ps.id AS phieu_id, ls.id AS lenh_id, cs.id AS chuyen_id, cs.ma_chuyen, cs.ten_chuyen,
            cs.dinh_muc_gio, ps.tg_bd, ls.ma_lenh_san_xuat, ls.ngay_ke_hoach,
            ls.so_luong_release AS target, ${PHAN_AGG} AS phan_list,
            info.ten_khach_hang, info.ma_hang, info.ma_phan, info.mau_vai, info.kich_vai, info.kich_phim,
            (SELECT COALESCE(SUM(t.so_luong),0)::int FROM tem t WHERE t.phieu_san_xuat_id=ps.id) AS printed,
            (SELECT count(*) FROM tem t WHERE t.phieu_san_xuat_id=ps.id)::int AS so_tem,
            EXISTS (SELECT 1 FROM ngung_chuyen n WHERE n.phieu_san_xuat_id=ps.id AND n.trang_thai='DANG_NGUNG') AS dang_ngung,
            (SELECT COALESCE(SUM(
               CASE WHEN n.trang_thai='DA_HOAT_DONG_LAI' THEN COALESCE(n.so_phut,0)
                    ELSE GREATEST(0, ROUND(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - n.tg_bd_ngung))/60.0))::int END
             ),0)::int FROM ngung_chuyen n WHERE n.phieu_san_xuat_id=ps.id) AS ngung_phut
     FROM phieu_san_xuat ps
     JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
     JOIN chuyen_san_xuat cs ON cs.id = ps.chuyen_id
     ${PHAN_INFO_LATERAL}
     WHERE ps.trang_thai='DANG_CHAY'
     ORDER BY cs.ma_chuyen`
  );
  return rows;
}

async function monitorQueue() {
  const { rows } = await query(
    `SELECT ls.ma_lenh_san_xuat, ls.so_luong_release AS target, ls.ngay_ke_hoach,
            cs.ma_chuyen, cs.ten_chuyen,
            info.ten_khach_hang, info.ma_hang, info.ma_phan, info.mau_vai, info.kich_vai, info.kich_phim
     FROM lenh_san_xuat ls
     JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
     ${PHAN_INFO_LATERAL}
     WHERE ls.trang_thai='RELEASE_2'
     ORDER BY cs.ma_chuyen, ls.ngay_ke_hoach NULLS LAST, ls.created_date`
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
     WHERE t.trang_thai='IN' AND ($1='' OR t.ma_tem ILIKE '%'||$1||'%' OR ls.ma_lenh_san_xuat ILIKE '%'||$1||'%'
            OR ${lenhPhanInMatch('ls.id', '$1')})
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
     WHERE t.trang_thai='DANG_PHOI' AND ($1='' OR t.ma_tem ILIKE '%'||$1||'%'
            OR ls.ma_lenh_san_xuat ILIKE '%'||$1||'%' OR ${lenhPhanInMatch('ls.id', '$1')})
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

// ----- NGỪNG CHUYỀN (downtime) -----
async function getActiveNgung(phieuId) {
  const { rows } = await query(
    `SELECT id, ly_do, tg_bd_ngung FROM ngung_chuyen
     WHERE phieu_san_xuat_id = $1 AND trang_thai = 'DANG_NGUNG' ORDER BY tg_bd_ngung DESC LIMIT 1`,
    [phieuId]
  );
  return rows[0] || null;
}

async function startNgung({ phieuId, lenhId, chuyenId, lyDo }, actorId) {
  const { rows } = await query(
    `INSERT INTO ngung_chuyen (phieu_san_xuat_id, lenh_san_xuat_id, chuyen_id, ly_do, tg_bd_ngung, trang_thai, created_by)
     VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP,'DANG_NGUNG',$5) RETURNING id`,
    [phieuId, lenhId || null, chuyenId || null, lyDo || null, actorId]
  );
  return rows[0].id;
}

async function resumeNgung(ngungId, actorId) {
  const { rowCount } = await query(
    `UPDATE ngung_chuyen
     SET tg_kt_ngung = CURRENT_TIMESTAMP,
         so_phut = GREATEST(0, ROUND(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - tg_bd_ngung)) / 60.0))::int,
         trang_thai = 'DA_HOAT_DONG_LAI', updated_by = $2, updated_date = CURRENT_TIMESTAMP
     WHERE id = $1 AND trang_thai = 'DANG_NGUNG'`,
    [ngungId, actorId]
  );
  return rowCount > 0;
}

async function listNgungByPhieu(phieuId) {
  const { rows } = await query(
    `SELECT n.id, n.ly_do, n.tg_bd_ngung, n.tg_kt_ngung, n.so_phut, n.trang_thai, nd.ho_ten AS nguoi
     FROM ngung_chuyen n LEFT JOIN nguoi_dung nd ON nd.id = n.created_by
     WHERE n.phieu_san_xuat_id = $1 ORDER BY n.tg_bd_ngung DESC`,
    [phieuId]
  );
  return rows;
}

module.exports = {
  listProductionCandidates, getPrintedTotal, getDefaultXePhoi, nextMaPhieu, createPhieu, setLenhTrangThai, getLenhBasic,
  getActivePhieu, getPhieuById, getTemsByPhieu, getTemContext, listTemLogByPhieu, nextReprint, logReprint,
  nextMaTem, createTem, logTemPrint, finishPhieu,
  monitorRunning, monitorQueue, listXePhoi, listCurrentPhoi, listTemChoPhoi, addTemToXe, adjustPhoi,
  listDryingTems, confirmDry, getTemBasic,
  getActiveNgung, startNgung, resumeNgung, listNgungByPhieu,
};
