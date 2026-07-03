'use strict';

const { query } = require('../../config/db');

// Đợt vải gom được: chưa release (không nằm trong lệnh) và chưa thuộc set đang mở.
async function listCandidates({ search = '', offset = 0, limit = 50 }) {
  const SEARCH = `($1 = '' OR pin.ma_phan ILIKE '%'||$1||'%' OR kh.ten_khach_hang ILIKE '%'||$1||'%'
                  OR mh.ma_hang ILIKE '%'||$1||'%' OR pin.mau_vai ILIKE '%'||$1||'%'
                  OR pin.kich_vai ILIKE '%'||$1||'%' OR pin.kich_phim ILIKE '%'||$1||'%'
                  OR dv.ma_dot_vai ILIKE '%'||$1||'%')`;
  const FROM = `
    FROM dot_vai_ve dv
    JOIN phan_in pin ON pin.id = dv.phan_in_id
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    WHERE NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai lsd JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id
                      WHERE lsd.dot_vai_ve_id = dv.id AND ls.trang_thai <> 'HUY')
      AND NOT EXISTS (SELECT 1 FROM gom_set_dot_vai gsd JOIN gom_set gs ON gs.id = gsd.gom_set_id
                      WHERE gsd.dot_vai_ve_id = dv.id AND gs.trang_thai = 'MO')
      AND NOT EXISTS (SELECT 1 FROM ket_qua_checkpoint kq JOIN checkpoint cp ON cp.id = kq.checkpoint_id
                      WHERE kq.phan_in_id = pin.id AND cp.ma_checkpoint IN ('KHUON','FILM','QC_XAC_NHAN') AND kq.trang_thai = 'DAT')
      AND ${SEARCH}`;
  const dataSql = `
    SELECT dv.id AS dot_vai_id, dv.ma_dot_vai, dv.so_luong_vai_ve, dv.ngay_vai_ve, dv.han_giao_hang,
           pin.id AS phan_in_id, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.so_luong_don_hang,
           mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang,
           EXISTS (SELECT 1 FROM ket_qua_checkpoint kq JOIN checkpoint cp ON cp.id = kq.checkpoint_id
                   WHERE kq.phan_in_id = pin.id AND cp.ma_checkpoint = 'QC_XAC_NHAN' AND kq.trang_thai = 'DAT') AS qc_done,
           COUNT(*) OVER()::int AS total
    ${FROM}
    ORDER BY pin.mau_vai, pin.ma_phan, dv.ma_dot_vai
    LIMIT $2 OFFSET $3`;
  const { rows } = await query(dataSql, [search, limit, offset]);
  const total = rows[0] ? rows[0].total : 0;
  return { rows, total };
}

async function nextMaSet() {
  const { rows } = await query(
    `SELECT 'SET' || LPAD((COALESCE(MAX(NULLIF(regexp_replace(ma_set,'\\D','','g'),''))::int,0)+1)::text, 4, '0') AS ma
     FROM gom_set`
  );
  return rows[0].ma;
}

async function createSet(client, { maSet, ghiChu }, actorId) {
  const { rows } = await client.query(
    `INSERT INTO gom_set (ma_set, ghi_chu, trang_thai, created_by) VALUES ($1,$2,'MO',$3) RETURNING id`,
    [maSet, ghiChu || null, actorId]
  );
  return rows[0].id;
}

async function addDotVai(client, setId, dotVaiId, actorId) {
  await client.query(
    `INSERT INTO gom_set_dot_vai (gom_set_id, dot_vai_ve_id, created_by)
     VALUES ($1,$2,$3) ON CONFLICT (gom_set_id, dot_vai_ve_id) DO NOTHING`,
    [setId, dotVaiId, actorId]
  );
}

// Đợt vải đã release (nằm trong lệnh) → không gom được.
async function dotVaiReleased(dotVaiIds) {
  const { rows } = await query(
    `SELECT lsd.dot_vai_ve_id FROM lenh_sx_dot_vai lsd JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id
     WHERE lsd.dot_vai_ve_id = ANY($1::uuid[]) AND ls.trang_thai <> 'HUY'`,
    [dotVaiIds]
  );
  return rows.map((r) => r.dot_vai_ve_id);
}

// Đợt vải đã thuộc 1 set đang mở khác (loại trừ set hiện tại nếu có).
async function dotVaiInOpenSet(dotVaiIds, exceptSetId = null) {
  const { rows } = await query(
    `SELECT gsd.dot_vai_ve_id FROM gom_set_dot_vai gsd
     JOIN gom_set gs ON gs.id = gsd.gom_set_id
     WHERE gsd.dot_vai_ve_id = ANY($1::uuid[]) AND gs.trang_thai = 'MO'
       AND ($2::uuid IS NULL OR gs.id <> $2)`,
    [dotVaiIds, exceptSetId]
  );
  return rows.map((r) => r.dot_vai_ve_id);
}

async function getSet(setId) {
  const { rows } = await query(
    'SELECT id, ma_set, ghi_chu, trang_thai, lenh_san_xuat_id FROM gom_set WHERE id = $1',
    [setId]
  );
  return rows[0] || null;
}

// Danh sách set (mặc định trạng thái MO) + số đợt vải + số màu (để cảnh báo khác màu).
async function listSets({ search = '', trangThai = 'MO' }) {
  const { rows } = await query(
    `SELECT gs.id, gs.ma_set, gs.ghi_chu, gs.trang_thai, gs.created_date,
            (SELECT count(*) FROM gom_set_dot_vai d WHERE d.gom_set_id = gs.id)::int AS so_dot_vai,
            (SELECT count(DISTINCT pin.mau_vai)
               FROM gom_set_dot_vai d JOIN dot_vai_ve dv ON dv.id = d.dot_vai_ve_id
               JOIN phan_in pin ON pin.id = dv.phan_in_id WHERE d.gom_set_id = gs.id)::int AS so_mau,
            (SELECT string_agg(DISTINCT pin.mau_vai, ', ')
               FROM gom_set_dot_vai d JOIN dot_vai_ve dv ON dv.id = d.dot_vai_ve_id
               JOIN phan_in pin ON pin.id = dv.phan_in_id WHERE d.gom_set_id = gs.id) AS mau_list,
            (SELECT count(*) FROM gom_set_dot_vai d JOIN dot_vai_ve dv ON dv.id = d.dot_vai_ve_id
               JOIN phan_in pin ON pin.id = dv.phan_in_id
               WHERE d.gom_set_id = gs.id AND NOT EXISTS (
                 SELECT 1 FROM ket_qua_checkpoint kq JOIN checkpoint cp ON cp.id = kq.checkpoint_id
                 WHERE kq.phan_in_id = pin.id AND cp.ma_checkpoint = 'QC_XAC_NHAN' AND kq.trang_thai = 'DAT'))::int AS so_chua_ready
     FROM gom_set gs
     WHERE gs.trang_thai = $1
       AND ($2 = '' OR gs.ma_set ILIKE '%'||$2||'%' OR gs.ghi_chu ILIKE '%'||$2||'%')
     ORDER BY gs.created_date DESC`,
    [trangThai, search]
  );
  return rows;
}

async function getSetMembers(setId) {
  const { rows } = await query(
    `SELECT gsd.id AS member_id, dv.id AS dot_vai_id, dv.ma_dot_vai, dv.so_luong_vai_ve, dv.han_giao_hang,
            pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim, mh.ma_hang, kh.ten_khach_hang,
            EXISTS (SELECT 1 FROM ket_qua_checkpoint kq JOIN checkpoint cp ON cp.id = kq.checkpoint_id
                    WHERE kq.phan_in_id = pin.id AND cp.ma_checkpoint = 'QC_XAC_NHAN' AND kq.trang_thai = 'DAT') AS qc_done,
            EXISTS (SELECT 1 FROM lenh_sx_dot_vai lsd JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id
                    WHERE lsd.dot_vai_ve_id = dv.id AND ls.trang_thai <> 'HUY') AS da_release
     FROM gom_set_dot_vai gsd
     JOIN dot_vai_ve dv ON dv.id = gsd.dot_vai_ve_id
     JOIN phan_in pin ON pin.id = dv.phan_in_id
     JOIN ma_hang mh ON mh.id = pin.ma_hang_id
     JOIN don_hang dh ON dh.id = mh.don_hang_id
     JOIN khach_hang kh ON kh.id = dh.khach_hang_id
     WHERE gsd.gom_set_id = $1
     ORDER BY pin.mau_vai, pin.ma_phan, dv.ma_dot_vai`,
    [setId]
  );
  return rows;
}

async function removeDotVai(setId, dotVaiId) {
  await query('DELETE FROM gom_set_dot_vai WHERE gom_set_id = $1 AND dot_vai_ve_id = $2', [setId, dotVaiId]);
}

async function cancelSet(setId, actorId) {
  await query(
    `UPDATE gom_set SET trang_thai='HUY', updated_by=$2, updated_date=CURRENT_TIMESTAMP WHERE id=$1`,
    [setId, actorId]
  );
}

// Nhãn ngắn của đợt vải để ghi lịch sử thao tác.
async function getDotVaiLabels(dotVaiIds) {
  const { rows } = await query(
    `SELECT dv.id::text AS id, dv.ma_dot_vai, pin.ma_phan, pin.mau_vai
     FROM dot_vai_ve dv JOIN phan_in pin ON pin.id = dv.phan_in_id
     WHERE dv.id = ANY($1::uuid[])`,
    [dotVaiIds]
  );
  return rows;
}

// Lịch sử thao tác gom set → audit_log (ten_bang='gom_set').
async function logGomAction(client, setId, hanhDong, chiTiet, actorId) {
  const runner = client || { query };
  await runner.query(
    `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ('gom_set', $1, $2, $3::jsonb, $4, CURRENT_TIMESTAMP, $4)`,
    [String(setId), hanhDong, JSON.stringify({ chi_tiet: chiTiet || null }), actorId]
  );
}

async function gomHistoryByDate(date) {
  const { rows } = await query(
    `SELECT a.thoi_gian AS tg, nd.ho_ten AS nguoi, a.hanh_dong,
            gs.ma_set, a.gia_tri_moi->>'chi_tiet' AS chi_tiet
     FROM audit_log a
     LEFT JOIN gom_set gs ON gs.id = a.id_ban_ghi::uuid
     LEFT JOIN nguoi_dung nd ON nd.id = a.nguoi_thuc_hien_id
     WHERE a.ten_bang = 'gom_set'
       AND (a.thoi_gian AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $1::date
     ORDER BY a.thoi_gian DESC`,
    [date]
  );
  return rows;
}

// Danh sách set "đã hoàn thành" thao tác gom (tạo/release) trong ngày (giờ VN) — cho DonePanel.
async function gomDoneByDate(date) {
  const sql = `
    SELECT a.thoi_gian AS tg, nd.ho_ten AS nguoi, a.hanh_dong, gs.ma_set AS ma,
           (SELECT count(*) FROM gom_set_dot_vai d WHERE d.gom_set_id = gs.id)::int AS so_dot_vai,
           (SELECT string_agg(DISTINCT pin.mau_vai, ', ')
              FROM gom_set_dot_vai d JOIN dot_vai_ve dv ON dv.id = d.dot_vai_ve_id
              JOIN phan_in pin ON pin.id = dv.phan_in_id WHERE d.gom_set_id = gs.id) AS mau_list
    FROM audit_log a
    JOIN gom_set gs ON gs.id = a.id_ban_ghi::uuid
    LEFT JOIN nguoi_dung nd ON nd.id = a.nguoi_thuc_hien_id
    WHERE a.ten_bang = 'gom_set' AND a.hanh_dong IN ('CREATE_SET','RELEASE_SET')
      AND (a.thoi_gian AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $1::date
    ORDER BY a.thoi_gian DESC`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [date]);
  return rows;
}

module.exports = {
  listCandidates, nextMaSet, createSet, addDotVai, dotVaiReleased, dotVaiInOpenSet,
  getSet, listSets, getSetMembers, removeDotVai, cancelSet,
  getDotVaiLabels, logGomAction, gomHistoryByDate, gomDoneByDate,
};
