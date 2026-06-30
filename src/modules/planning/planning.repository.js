'use strict';

const { query } = require('../../config/db');
const { lenhPhanInMatch } = require('../../utils/search');

// ----- RELEASE 1: đợt vải của phần in đã READY, chưa nằm trong lệnh nào -----
async function listRelease1Candidates({ search = '', offset = 0, limit = 50 }) {
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
    WHERE EXISTS (SELECT 1 FROM ket_qua_checkpoint kq JOIN checkpoint cp ON cp.id = kq.checkpoint_id
                  WHERE kq.phan_in_id = pin.id AND cp.ma_checkpoint = 'QC_XAC_NHAN' AND kq.trang_thai = 'DAT')
      AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai lsd WHERE lsd.dot_vai_ve_id = dv.id)
      AND NOT EXISTS (SELECT 1 FROM gom_set_dot_vai gsd JOIN gom_set gs ON gs.id = gsd.gom_set_id
                      WHERE gsd.dot_vai_ve_id = dv.id AND gs.trang_thai = 'MO')
      AND ${SEARCH}`;

  const dataSql = `
    SELECT dv.id AS dot_vai_id, dv.ma_dot_vai, dv.so_luong_vai_ve, dv.ngay_vai_ve, dv.han_giao_hang,
           pin.id AS phan_in_id, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim,
           pin.so_luong_don_hang,
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

const NEXT_MA_SQL =
  `SELECT 'LSX' || LPAD((COALESCE(MAX(NULLIF(regexp_replace(ma_lenh_san_xuat,'\\D','','g'),''))::int,0)+1)::text, 4, '0') AS ma
   FROM lenh_san_xuat`;

async function nextMaLenh() {
  const { rows } = await query(NEXT_MA_SQL);
  return rows[0].ma;
}

// Sinh mã trong transaction (thấy được các lệnh vừa INSERT ở cùng client) — cho phép tạo nhiều lệnh 1 lần.
async function nextMaLenhTx(client) {
  const { rows } = await client.query(NEXT_MA_SQL);
  return rows[0].ma;
}

async function createLenh(client, data, actorId) {
  const { rows } = await client.query(
    `INSERT INTO lenh_san_xuat
       (workflow_version_id, ma_lenh_san_xuat, chuyen_id, so_luong_release, ngay_ke_hoach, trang_thai, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [data.versionId, data.maLenh, data.chuyenId, data.soLuongRelease, data.ngayKeHoach || null,
     data.trangThai || 'RELEASE_1', actorId]
  );
  return rows[0].id;
}

// Đợt vải có code phần (phan_in) ĐÃ test run xong (CNSP+QA DAT ở 1 lệnh trước đó) → không cần test lại.
async function testedDotVaiIds(dotVaiIds, cnspCheckpointId, qaCheckpointId) {
  const { rows } = await query(
    `SELECT dv.id::text AS id
     FROM dot_vai_ve dv
     WHERE dv.id = ANY($1::uuid[])
       AND EXISTS (
         SELECT 1
         FROM lenh_sx_dot_vai lsd
         JOIN dot_vai_ve dv2 ON dv2.id = lsd.dot_vai_ve_id AND dv2.phan_in_id = dv.phan_in_id
         WHERE EXISTS (SELECT 1 FROM ket_qua_checkpoint k WHERE k.lenh_san_xuat_id = lsd.lenh_san_xuat_id AND k.checkpoint_id = $2 AND k.trang_thai = 'DAT')
           AND EXISTS (SELECT 1 FROM ket_qua_checkpoint k WHERE k.lenh_san_xuat_id = lsd.lenh_san_xuat_id AND k.checkpoint_id = $3 AND k.trang_thai = 'DAT')
       )`,
    [dotVaiIds, cnspCheckpointId, qaCheckpointId]
  );
  return rows.map((r) => r.id);
}

async function getDotVaiQty(dotVaiIds) {
  const { rows } = await query(
    'SELECT id::text AS id, COALESCE(so_luong_vai_ve,0)::int AS so_luong FROM dot_vai_ve WHERE id = ANY($1::uuid[])',
    [dotVaiIds]
  );
  return rows;
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

// ----- RELEASE SET (gom set → 1 lệnh chung) -----
async function listReleasableSets(search = '') {
  const { rows } = await query(
    `SELECT gs.id, gs.ma_set, gs.ghi_chu, gs.created_date,
            (SELECT count(*) FROM gom_set_dot_vai d WHERE d.gom_set_id = gs.id)::int AS so_dot_vai,
            (SELECT string_agg(DISTINCT pin.mau_vai, ', ')
               FROM gom_set_dot_vai d JOIN dot_vai_ve dv ON dv.id = d.dot_vai_ve_id
               JOIN phan_in pin ON pin.id = dv.phan_in_id WHERE d.gom_set_id = gs.id) AS mau_list,
            (SELECT count(DISTINCT pin.mau_vai)
               FROM gom_set_dot_vai d JOIN dot_vai_ve dv ON dv.id = d.dot_vai_ve_id
               JOIN phan_in pin ON pin.id = dv.phan_in_id WHERE d.gom_set_id = gs.id)::int AS so_mau,
            (SELECT string_agg(DISTINCT pin.ma_phan, ', ')
               FROM gom_set_dot_vai d JOIN dot_vai_ve dv ON dv.id = d.dot_vai_ve_id
               JOIN phan_in pin ON pin.id = dv.phan_in_id WHERE d.gom_set_id = gs.id) AS phan_list,
            (SELECT COALESCE(SUM(dv.so_luong_vai_ve),0)::int
               FROM gom_set_dot_vai d JOIN dot_vai_ve dv ON dv.id = d.dot_vai_ve_id WHERE d.gom_set_id = gs.id) AS tong_vai,
            (SELECT count(*) FROM gom_set_dot_vai d JOIN dot_vai_ve dv ON dv.id = d.dot_vai_ve_id
               JOIN phan_in pin ON pin.id = dv.phan_in_id
               WHERE d.gom_set_id = gs.id AND NOT EXISTS (
                 SELECT 1 FROM ket_qua_checkpoint kq JOIN checkpoint cp ON cp.id = kq.checkpoint_id
                 WHERE kq.phan_in_id = pin.id AND cp.ma_checkpoint = 'QC_XAC_NHAN' AND kq.trang_thai = 'DAT'))::int AS so_chua_ready
     FROM gom_set gs
     WHERE gs.trang_thai = 'MO'
       AND ($1 = '' OR gs.ma_set ILIKE '%'||$1||'%' OR gs.ghi_chu ILIKE '%'||$1||'%')
     ORDER BY gs.created_date DESC`,
    [search]
  );
  return rows;
}

// Thành viên (đợt vải) của các set đang mở — đủ cột để render chung bảng Release 1.
async function getOpenSetMembers() {
  const { rows } = await query(
    `SELECT gs.id AS set_id, dv.id AS dot_vai_id, dv.ma_dot_vai,
            dv.so_luong_vai_ve, dv.ngay_vai_ve, dv.han_giao_hang,
            pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.so_luong_don_hang,
            mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang,
            EXISTS (SELECT 1 FROM ket_qua_checkpoint kq JOIN checkpoint cp ON cp.id = kq.checkpoint_id
                    WHERE kq.phan_in_id = pin.id AND cp.ma_checkpoint = 'QC_XAC_NHAN' AND kq.trang_thai = 'DAT') AS qc_done
     FROM gom_set gs
     JOIN gom_set_dot_vai gsd ON gsd.gom_set_id = gs.id
     JOIN dot_vai_ve dv ON dv.id = gsd.dot_vai_ve_id
     JOIN phan_in pin ON pin.id = dv.phan_in_id
     JOIN ma_hang mh ON mh.id = pin.ma_hang_id
     JOIN don_hang dh ON dh.id = mh.don_hang_id
     JOIN khach_hang kh ON kh.id = dh.khach_hang_id
     WHERE gs.trang_thai = 'MO'
     ORDER BY gs.created_date DESC, pin.mau_vai, pin.ma_phan, dv.ma_dot_vai`
  );
  return rows;
}

async function getSetForRelease(setId) {
  const { rows } = await query('SELECT id, ma_set, trang_thai FROM gom_set WHERE id = $1', [setId]);
  return rows[0] || null;
}

async function getSetMembersForRelease(setId) {
  const { rows } = await query(
    `SELECT dv.id AS dot_vai_id, COALESCE(dv.so_luong_vai_ve,0)::int AS so_luong,
            EXISTS (SELECT 1 FROM ket_qua_checkpoint kq JOIN checkpoint cp ON cp.id = kq.checkpoint_id
                    WHERE kq.phan_in_id = pin.id AND cp.ma_checkpoint = 'QC_XAC_NHAN' AND kq.trang_thai = 'DAT') AS qc_done,
            EXISTS (SELECT 1 FROM lenh_sx_dot_vai lsd WHERE lsd.dot_vai_ve_id = dv.id) AS da_release
     FROM gom_set_dot_vai gsd
     JOIN dot_vai_ve dv ON dv.id = gsd.dot_vai_ve_id
     JOIN phan_in pin ON pin.id = dv.phan_in_id
     WHERE gsd.gom_set_id = $1`,
    [setId]
  );
  return rows;
}

async function markSetReleased(client, setId, lenhId, actorId) {
  await client.query(
    `UPDATE gom_set SET trang_thai='DA_RELEASE', lenh_san_xuat_id=$2, updated_by=$3, updated_date=CURRENT_TIMESTAMP
     WHERE id=$1`,
    [setId, lenhId, actorId]
  );
}

// Ghi lịch sử thao tác gom set (RELEASE_SET) vào audit_log để màn Gom set thấy.
async function logGomSetReleased(client, setId, chiTiet, actorId) {
  await client.query(
    `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ('gom_set', $1, 'RELEASE_SET', $2::jsonb, $3, CURRENT_TIMESTAMP, $3)`,
    [String(setId), JSON.stringify({ chi_tiet: chiTiet || null }), actorId]
  );
}

// Lịch sử Release 1 theo ngày (giờ VN) — lệnh sản xuất được tạo trong ngày (mỗi đợt vải 1 dòng).
async function release1HistoryByDate(date) {
  const sql = `
    SELECT ls.created_date AS tg, nd.ho_ten AS nguoi,
           ls.ma_lenh_san_xuat AS ma_lenh, cs.ten_chuyen, cs.ma_chuyen,
           pin.ma_phan, pin.mau_vai, dv.ma_dot_vai
    FROM lenh_san_xuat ls
    JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
    JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
    JOIN phan_in pin ON pin.id = dv.phan_in_id
    LEFT JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
    LEFT JOIN nguoi_dung nd ON nd.id = ls.created_by
    WHERE (ls.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $1::date
    ORDER BY ls.created_date DESC, pin.ma_phan, dv.ma_dot_vai`;
  const { rows } = await query(sql, [date]);
  return rows;
}

// ----- TEST RUN / RELEASE 2 -----
// Thông tin phần in đại diện của 1 lệnh (mỗi đợt vải = 1 LSX nên ánh xạ 1-1). Dùng chung cho Test Run / Release 2 / Lập kế hoạch lại.
const PHAN_INFO_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang,
           pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.ma_phan, pin.so_luong_don_hang,
           dv.so_luong_vai_ve, dv.ngay_vai_ve, dv.han_giao_hang
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

function lenhListSql(extraWhere) {
  return `
    SELECT ls.id, ls.ma_lenh_san_xuat, ls.so_luong_release, ls.trang_thai, ls.ngay_ke_hoach,
           cs.ma_chuyen, cs.ten_chuyen,
           info.ten_khach_hang, info.ma_don_hang, info.ma_hang,
           info.mau_vai, info.kich_vai, info.kich_phim, info.ma_phan,
           info.so_luong_don_hang, info.so_luong_vai_ve, info.ngay_vai_ve, info.han_giao_hang,
           EXISTS (SELECT 1 FROM ket_qua_checkpoint k WHERE k.lenh_san_xuat_id = ls.id AND k.checkpoint_id = $1 AND k.trang_thai='DAT') AS cnsp_done,
           EXISTS (SELECT 1 FROM ket_qua_checkpoint k WHERE k.lenh_san_xuat_id = ls.id AND k.checkpoint_id = $2 AND k.trang_thai='DAT') AS qa_done,
           (SELECT count(*) FROM test_run tr WHERE tr.lenh_san_xuat_id = ls.id)::int AS so_lan_test,
           (SELECT count(*) FROM lenh_sx_dot_vai lsd WHERE lsd.lenh_san_xuat_id = ls.id)::int AS so_dot_vai
    FROM lenh_san_xuat ls
    LEFT JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
    ${PHAN_INFO_LATERAL}
    WHERE ls.trang_thai = 'RELEASE_1'
      AND ($3 = '' OR ls.ma_lenh_san_xuat ILIKE '%'||$3||'%' OR ${lenhPhanInMatch('ls.id', '$3')})
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

// ----- LẬP KẾ HOẠCH LẠI (lệnh đã RELEASE_2 nhưng chưa bắt đầu sản xuất) -----
async function listReplanCandidates({ search = '', offset = 0, limit = 50 }) {
  const FROM = `
    FROM lenh_san_xuat ls
    LEFT JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
    ${PHAN_INFO_LATERAL}
    WHERE ls.trang_thai = 'RELEASE_2'
      AND NOT EXISTS (SELECT 1 FROM phieu_san_xuat ps WHERE ps.lenh_san_xuat_id = ls.id)
      AND ($1 = '' OR ls.ma_lenh_san_xuat ILIKE '%'||$1||'%' OR ${lenhPhanInMatch('ls.id', '$1')})`;
  const dataSql = `
    SELECT ls.id, ls.ma_lenh_san_xuat, ls.so_luong_release, ls.ngay_ke_hoach, ls.chuyen_id,
           cs.ma_chuyen, cs.ten_chuyen,
           info.ten_khach_hang, info.ma_don_hang, info.ma_hang,
           info.mau_vai, info.kich_vai, info.kich_phim, info.ma_phan,
           info.so_luong_don_hang, info.so_luong_vai_ve, info.ngay_vai_ve, info.han_giao_hang,
           (SELECT count(*) FROM lenh_sx_dot_vai lsd WHERE lsd.lenh_san_xuat_id = ls.id)::int AS so_dot_vai
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

async function getLenhForReplan(lenhId) {
  const { rows } = await query(
    `SELECT ls.id, ls.ma_lenh_san_xuat, ls.trang_thai, ls.chuyen_id, ls.ngay_ke_hoach,
            EXISTS (SELECT 1 FROM phieu_san_xuat ps WHERE ps.lenh_san_xuat_id = ls.id) AS co_phieu
     FROM lenh_san_xuat ls WHERE ls.id = $1`,
    [lenhId]
  );
  return rows[0] || null;
}

async function updateLenhPlan(client, lenhId, { chuyenId, ngayKeHoach }, actorId) {
  await client.query(
    `UPDATE lenh_san_xuat SET chuyen_id = $2, ngay_ke_hoach = $3,
       updated_by = $4, updated_date = CURRENT_TIMESTAMP WHERE id = $1`,
    [lenhId, chuyenId, ngayKeHoach || null, actorId]
  );
}

// Ghi audit_log thay đổi kế hoạch lệnh (RELEASE_2 / REPLAN) — forward-only, pattern như logProfitChange.
async function logPlanChange(client, lenhId, hanhDong, giaTriCu, giaTriMoi, actorId) {
  const run = client || { query };
  await run.query(
    `INSERT INTO audit_log
       (ten_bang, id_ban_ghi, hanh_dong, gia_tri_cu, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ('lenh_san_xuat', $1, $2, $3::jsonb, $4::jsonb, $5, CURRENT_TIMESTAMP, $5)`,
    [String(lenhId), hanhDong, JSON.stringify(giaTriCu || {}), JSON.stringify(giaTriMoi || {}), actorId]
  );
}

// Lịch sử kế hoạch theo ngày (giờ VN): duyệt Release 2 + lập kế hoạch lại.
async function planHistoryByDate(date) {
  const { rows } = await query(
    `SELECT a.thoi_gian AS tg, nd.ho_ten AS nguoi, a.hanh_dong,
            ls.ma_lenh_san_xuat AS ma_lenh,
            csc.ten_chuyen AS ten_chuyen_cu, csm.ten_chuyen AS ten_chuyen_moi,
            a.gia_tri_cu->>'ngay_ke_hoach' AS ngay_cu,
            a.gia_tri_moi->>'ngay_ke_hoach' AS ngay_moi,
            a.gia_tri_moi->>'ly_do' AS ly_do
     FROM audit_log a
     JOIN lenh_san_xuat ls ON ls.id = a.id_ban_ghi::uuid
     LEFT JOIN nguoi_dung nd ON nd.id = a.nguoi_thuc_hien_id
     LEFT JOIN chuyen_san_xuat csc ON csc.id = (a.gia_tri_cu->>'chuyen_id')::uuid
     LEFT JOIN chuyen_san_xuat csm ON csm.id = (a.gia_tri_moi->>'chuyen_id')::uuid
     WHERE a.ten_bang = 'lenh_san_xuat' AND a.hanh_dong IN ('RELEASE_2','REPLAN')
       AND (a.thoi_gian AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $1::date
     ORDER BY a.thoi_gian DESC`,
    [date]
  );
  return rows;
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

// Lịch sử xác nhận Test Run theo ngày (giờ VN) — từ lich_su_trang_thai (TEST_CNSP/TEST_QA, mức lệnh).
async function testRunHistoryByDate(date) {
  const sql = `
    SELECT l.tg_thuc_hien AS tg, nd.ho_ten AS nguoi, l.ly_do AS hanh_dong,
           ls.ma_lenh_san_xuat AS doi_tuong, kq.gia_tri_text AS chi_tiet
    FROM lich_su_trang_thai l
    JOIN ket_qua_checkpoint kq ON kq.id = l.ket_qua_checkpoint_id
    JOIN checkpoint cp ON cp.id = kq.checkpoint_id
    JOIN lenh_san_xuat ls ON ls.id = kq.lenh_san_xuat_id
    LEFT JOIN nguoi_dung nd ON nd.id = l.nguoi_thuc_hien_id
    WHERE cp.ma_checkpoint IN ('TEST_CNSP', 'TEST_QA')
      AND (l.tg_thuc_hien AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $1::date
    ORDER BY l.tg_thuc_hien DESC`;
  const { rows } = await query(sql, [date]);
  return rows;
}

module.exports = {
  listRelease1Candidates, release1HistoryByDate, nextMaLenh, nextMaLenhTx, createLenh,
  testedDotVaiIds, getDotVaiQty, addLenhDotVai, dotVaiAlreadyReleased,
  listTestRunCandidates, listRelease2Candidates, getLenhBasic, getLenhDotVai, getTestRuns,
  getLenhTestStatus, insertTestRun, upsertLenhResult, insertStatusLog, setLenhTrangThai,
  testRunHistoryByDate,
  listReplanCandidates, getLenhForReplan, updateLenhPlan, logPlanChange, planHistoryByDate,
  listReleasableSets, getOpenSetMembers, getSetForRelease, getSetMembersForRelease, markSetReleased, logGomSetReleased,
};
