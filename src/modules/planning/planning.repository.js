'use strict';

const { query } = require('../../config/db');

// ----- RELEASE 1: đợt vải của phần in đã READY, chưa nằm trong lệnh nào -----
async function listRelease1Candidates({ search = '', offset = 0, limit = 50 }) {
  const SEARCH = `($1 = '' OR pin.ma_phan ILIKE '%'||$1||'%' OR kh.ten_khach_hang ILIKE '%'||$1||'%'
                  OR pin.mau_vai ILIKE '%'||$1||'%' OR dv.ma_dot_vai ILIKE '%'||$1||'%')`;
  const FROM = `
    FROM dot_vai_ve dv
    JOIN phan_in pin ON pin.id = dv.phan_in_id
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    WHERE EXISTS (SELECT 1 FROM ket_qua_checkpoint kq JOIN checkpoint cp ON cp.id = kq.checkpoint_id
                  WHERE kq.phan_in_id = pin.id AND cp.ma_checkpoint = 'QC_XAC_NHAN' AND kq.trang_thai = 'DAT')
      AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai lsd WHERE lsd.dot_vai_ve_id = dv.id)
      AND ${SEARCH}`;

  const dataSql = `
    SELECT dv.id AS dot_vai_id, dv.ma_dot_vai, dv.so_luong_vai_ve, dv.ngay_vai_ve, dv.han_giao_hang,
           pin.id AS phan_in_id, pin.ma_phan, pin.mau_vai, pin.kich_vai,
           mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang
    ${FROM}
    ORDER BY pin.mau_vai, pin.ma_phan, dv.ma_dot_vai
    LIMIT $2 OFFSET $3`;
  const countSql = `SELECT count(*)::int AS total ${FROM}`;

  const [data, count] = await Promise.all([
    query(dataSql, [search, limit, offset]),
    query(countSql, [search]),
  ]);
  return { rows: data.rows, total: count.rows[0].total };
}

async function nextMaLenh() {
  const { rows } = await query(
    `SELECT 'LSX' || LPAD((COALESCE(MAX(NULLIF(regexp_replace(ma_lenh_san_xuat,'\\D','','g'),''))::int,0)+1)::text, 4, '0') AS ma
     FROM lenh_san_xuat`
  );
  return rows[0].ma;
}

async function createLenh(client, data, actorId) {
  const { rows } = await client.query(
    `INSERT INTO lenh_san_xuat
       (workflow_version_id, ma_lenh_san_xuat, chuyen_id, so_luong_release, ngay_ke_hoach, trang_thai, created_by)
     VALUES ($1,$2,$3,$4,$5,'RELEASE_1',$6) RETURNING id`,
    [data.versionId, data.maLenh, data.chuyenId, data.soLuongRelease, data.ngayKeHoach || null, actorId]
  );
  return rows[0].id;
}

async function addLenhDotVai(client, lenhId, dotVaiId, actorId) {
  await client.query(
    `INSERT INTO lenh_sx_dot_vai (lenh_san_xuat_id, dot_vai_ve_id, created_by)
     VALUES ($1,$2,$3) ON CONFLICT (lenh_san_xuat_id, dot_vai_ve_id) DO NOTHING`,
    [lenhId, dotVaiId, actorId]
  );
}

async function dotVaiAlreadyReleased(dotVaiIds) {
  const { rows } = await query(
    'SELECT dot_vai_ve_id FROM lenh_sx_dot_vai WHERE dot_vai_ve_id = ANY($1::uuid[])',
    [dotVaiIds]
  );
  return rows.map((r) => r.dot_vai_ve_id);
}

// ----- TEST RUN / RELEASE 2 -----
function lenhListSql(extraWhere) {
  return `
    SELECT ls.id, ls.ma_lenh_san_xuat, ls.so_luong_release, ls.trang_thai, ls.ngay_ke_hoach,
           cs.ma_chuyen, cs.ten_chuyen,
           EXISTS (SELECT 1 FROM ket_qua_checkpoint k WHERE k.lenh_san_xuat_id = ls.id AND k.checkpoint_id = $1 AND k.trang_thai='DAT') AS cnsp_done,
           EXISTS (SELECT 1 FROM ket_qua_checkpoint k WHERE k.lenh_san_xuat_id = ls.id AND k.checkpoint_id = $2 AND k.trang_thai='DAT') AS qa_done,
           (SELECT count(*) FROM test_run tr WHERE tr.lenh_san_xuat_id = ls.id)::int AS so_lan_test,
           (SELECT count(*) FROM lenh_sx_dot_vai lsd WHERE lsd.lenh_san_xuat_id = ls.id)::int AS so_dot_vai
    FROM lenh_san_xuat ls
    LEFT JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
    WHERE ls.trang_thai = 'RELEASE_1' AND ($3 = '' OR ls.ma_lenh_san_xuat ILIKE '%'||$3||'%')
      ${extraWhere}
    ORDER BY ls.created_date DESC
    LIMIT $4 OFFSET $5`;
}

async function listTestRunCandidates({ cnspId, qaId, search = '', offset = 0, limit = 20 }) {
  const { rows } = await query(lenhListSql(''), [cnspId, qaId, search, limit, offset]);
  return rows;
}

async function listRelease2Candidates({ cnspId, qaId, search = '', offset = 0, limit = 20 }) {
  const extra = `
    AND EXISTS (SELECT 1 FROM ket_qua_checkpoint k WHERE k.lenh_san_xuat_id = ls.id AND k.checkpoint_id = $1 AND k.trang_thai='DAT')
    AND EXISTS (SELECT 1 FROM ket_qua_checkpoint k WHERE k.lenh_san_xuat_id = ls.id AND k.checkpoint_id = $2 AND k.trang_thai='DAT')`;
  const { rows } = await query(lenhListSql(extra), [cnspId, qaId, search, limit, offset]);
  return rows;
}

async function getLenhBasic(lenhId) {
  const { rows } = await query(
    `SELECT ls.id, ls.ma_lenh_san_xuat, ls.so_luong_release, ls.trang_thai, ls.ngay_ke_hoach,
            cs.ma_chuyen, cs.ten_chuyen
     FROM lenh_san_xuat ls LEFT JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
     WHERE ls.id = $1`,
    [lenhId]
  );
  return rows[0] || null;
}

async function getLenhDotVai(lenhId) {
  const { rows } = await query(
    `SELECT dv.id AS dot_vai_id, dv.ma_dot_vai, dv.so_luong_vai_ve,
            pin.ma_phan, pin.mau_vai, kh.ten_khach_hang
     FROM lenh_sx_dot_vai lsd
     JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
     JOIN phan_in pin ON pin.id = dv.phan_in_id
     JOIN ma_hang mh ON mh.id = pin.ma_hang_id
     JOIN don_hang dh ON dh.id = mh.don_hang_id
     JOIN khach_hang kh ON kh.id = dh.khach_hang_id
     WHERE lsd.lenh_san_xuat_id = $1
     ORDER BY pin.ma_phan, dv.ma_dot_vai`,
    [lenhId]
  );
  return rows;
}

async function getTestRuns(lenhId) {
  const { rows } = await query(
    `SELECT id, lan_test, so_luong, ket_qua, tg_bd_test, tg_kt_test, ghi_chu, created_date
     FROM test_run WHERE lenh_san_xuat_id = $1 ORDER BY lan_test`,
    [lenhId]
  );
  return rows;
}

async function getLenhTestStatus(lenhId, cnspId, qaId) {
  const { rows } = await query(
    `SELECT
       EXISTS (SELECT 1 FROM ket_qua_checkpoint k WHERE k.lenh_san_xuat_id=$1 AND k.checkpoint_id=$2 AND k.trang_thai='DAT') AS cnsp_done,
       EXISTS (SELECT 1 FROM ket_qua_checkpoint k WHERE k.lenh_san_xuat_id=$1 AND k.checkpoint_id=$3 AND k.trang_thai='DAT') AS qa_done`,
    [lenhId, cnspId, qaId]
  );
  return rows[0];
}

async function insertTestRun(lenhId, { soLuong, ketQua, ghiChu }, actorId) {
  const { rows } = await query(
    `INSERT INTO test_run (lenh_san_xuat_id, lan_test, so_luong, ket_qua, tg_bd_test, ghi_chu, created_by)
     VALUES ($1,
             (SELECT COALESCE(MAX(lan_test),0)+1 FROM test_run WHERE lenh_san_xuat_id=$1),
             $2,$3,CURRENT_TIMESTAMP,$4,$5)
     RETURNING id, lan_test`,
    [lenhId, soLuong ?? null, ketQua ?? null, ghiChu ?? null, actorId]
  );
  return rows[0];
}

async function upsertLenhResult(client, { lenhId, checkpointId, trangThai, nguoiXacNhanId, actorId }) {
  const ex = await client.query(
    'SELECT id FROM ket_qua_checkpoint WHERE lenh_san_xuat_id=$1 AND checkpoint_id=$2',
    [lenhId, checkpointId]
  );
  if (ex.rows[0]) {
    await client.query(
      `UPDATE ket_qua_checkpoint SET trang_thai=$2, nguoi_xac_nhan_id=$3, tg_xac_nhan=CURRENT_TIMESTAMP,
         updated_by=$4, updated_date=CURRENT_TIMESTAMP WHERE id=$1`,
      [ex.rows[0].id, trangThai, nguoiXacNhanId, actorId]
    );
    return ex.rows[0].id;
  }
  const { rows } = await client.query(
    `INSERT INTO ket_qua_checkpoint (checkpoint_id, lenh_san_xuat_id, trang_thai, nguoi_xac_nhan_id, tg_xac_nhan, created_by)
     VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP,$5) RETURNING id`,
    [checkpointId, lenhId, trangThai, nguoiXacNhanId, actorId]
  );
  return rows[0].id;
}

async function insertStatusLog(client, { ketQuaId, trangThaiMoiId, nguoiId, lyDo }) {
  await client.query(
    `INSERT INTO lich_su_trang_thai (ket_qua_checkpoint_id, trang_thai_moi_id, ly_do, nguoi_thuc_hien_id, tg_thuc_hien, created_by)
     VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP,$4)`,
    [ketQuaId, trangThaiMoiId, lyDo || null, nguoiId]
  );
}

async function setLenhTrangThai(client, lenhId, trangThai, actorId) {
  await client.query(
    'UPDATE lenh_san_xuat SET trang_thai=$2, updated_by=$3, updated_date=CURRENT_TIMESTAMP WHERE id=$1',
    [lenhId, trangThai, actorId]
  );
}

module.exports = {
  listRelease1Candidates, nextMaLenh, createLenh, addLenhDotVai, dotVaiAlreadyReleased,
  listTestRunCandidates, listRelease2Candidates, getLenhBasic, getLenhDotVai, getTestRuns,
  getLenhTestStatus, insertTestRun, upsertLenhResult, insertStatusLog, setLenhTrangThai,
};
