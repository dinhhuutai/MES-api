'use strict';

const { query } = require('../../config/db');
const { lenhPhanInMatch } = require('../../utils/search');

// SL vải đã ĐƯA VÀO đợt SX của 1 đợt vải = Σ lenh_sx_dot_vai.so_luong các lệnh non-HUY gắn đợt đó
// (mig 052: SL đưa vào theo TỪNG đợt nằm ở junction — đúng cả khi 1 lệnh gồm nhiều đợt).
const DA_REL = `COALESCE((SELECT SUM(COALESCE(lsd.so_luong,0)) FROM lenh_sx_dot_vai lsd
    JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id
    WHERE lsd.dot_vai_ve_id = dv.id AND ls.trang_thai <> 'HUY'),0)`;

// ----- RELEASE 1: đợt vải của phần in đã READY, CÒN phần chưa release (SL vải về − đã release > 0) -----
// Release theo số lượng: 1 đợt có thể release nhiều lần → nhiều lệnh; đợt ở lại pool tới khi release đủ.
async function listRelease1Candidates({ search = '', offset = 0, limit = 50 }) {
  const SEARCH = `($1 = '' OR pin.ma_phan ILIKE '%'||$1||'%' OR kh.ten_khach_hang ILIKE '%'||$1||'%'
                  OR mh.ma_hang ILIKE '%'||$1||'%' OR pin.mau_vai ILIKE '%'||$1||'%'
                  OR pin.kich_vai ILIKE '%'||$1||'%' OR pin.kich_phim ILIKE '%'||$1||'%'
                  OR dv.ma_dot_vai ILIKE '%'||$1||'%' OR dv.id::text ILIKE '%'||$1||'%')`;
  const FROM = `
    FROM dot_vai_ve dv
    JOIN phan_in pin ON pin.id = dv.phan_in_id
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    LEFT JOIN loai_dot_vai ldv ON ldv.id = dv.loai_dot_vai_id
    WHERE pin.dang_hoat_dong AND dv.trang_thai <> 'DA_HUY'
      AND EXISTS (SELECT 1 FROM ket_qua_checkpoint kq JOIN checkpoint cp ON cp.id = kq.checkpoint_id
                  WHERE kq.phan_in_id = pin.id AND cp.ma_checkpoint = 'QC_XAC_NHAN' AND kq.trang_thai = 'DAT')
      AND (COALESCE(dv.so_luong_vai_ve,0) - ${DA_REL}) > 0
      AND NOT EXISTS (SELECT 1 FROM gom_set_dot_vai gsd JOIN gom_set gs ON gs.id = gsd.gom_set_id
                      WHERE gsd.dot_vai_ve_id = dv.id AND gs.trang_thai = 'MO')
      AND ${SEARCH}`;

  const dataSql = `
    SELECT dv.id AS dot_vai_id, dv.ma_dot_vai, dv.so_luong_vai_ve, dv.ngay_vai_ve, dv.han_giao_hang,
           pin.id AS phan_in_id, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim,
           pin.so_luong_don_hang, ldv.ten_loai AS loai_dot_vai,
           mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang,
           ${DA_REL}::int AS da_release,
           (COALESCE(dv.so_luong_vai_ve,0) - ${DA_REL})::int AS con_release
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

// SL đã đưa vào / còn lại của từng đợt vải (cho createRelease1 validate + prefill).
async function getDotVaiRemaining(dotVaiIds) {
  const { rows } = await query(
    `SELECT dv.id::text AS id, COALESCE(dv.so_luong_vai_ve,0)::int AS so_luong,
            COALESCE((SELECT SUM(COALESCE(lsd.so_luong,0)) FROM lenh_sx_dot_vai lsd
                      JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id
                      WHERE lsd.dot_vai_ve_id = dv.id AND ls.trang_thai <> 'HUY'),0)::int AS da_release
     FROM dot_vai_ve dv WHERE dv.id = ANY($1::uuid[])`,
    [dotVaiIds]
  );
  return rows.map((r) => ({ id: r.id, so_luong: r.so_luong, da_release: r.da_release, con_release: Math.max(0, r.so_luong - r.da_release) }));
}

// Thông tin đợt vải để SOẠN đợt sản xuất (mig 052): con_dua theo junction so_luong + màu + READY (QC).
async function getDotVaiForCompose(dotVaiIds) {
  const { rows } = await query(
    `SELECT dv.id::text AS id, dv.phan_in_id::text AS phan_in_id, dv.ma_dot_vai,
            pin.mau_vai, dv.can_lam_lai_ready, pin.la_in_kieng,
            COALESCE(dv.so_luong_vai_ve,0)::int AS so_luong,
            COALESCE((SELECT SUM(COALESCE(lsd.so_luong,0)) FROM lenh_sx_dot_vai lsd
                      JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id
                      WHERE lsd.dot_vai_ve_id = dv.id AND ls.trang_thai <> 'HUY'),0)::int AS da_dua,
            EXISTS (SELECT 1 FROM ket_qua_checkpoint kq JOIN checkpoint cp ON cp.id = kq.checkpoint_id
                    WHERE kq.phan_in_id = dv.phan_in_id AND cp.ma_checkpoint = 'QC_XAC_NHAN' AND kq.trang_thai = 'DAT') AS qc_done
     FROM dot_vai_ve dv JOIN phan_in pin ON pin.id = dv.phan_in_id
     WHERE dv.id = ANY($1::uuid[])`,
    [dotVaiIds]
  );
  return rows.map((r) => ({ ...r, con_dua: Math.max(0, r.so_luong - r.da_dua) }));
}

// Phần in ĐANG IN TEM (có phiếu DANG_CHAY) — dùng quyết định đi tắt Test Run (điểm 5/6). IPS-safe 1 dòng.
async function phanInDangChay(phanInIds) {
  if (!phanInIds || phanInIds.length === 0) return [];
  const sql = `SELECT DISTINCT dv.phan_in_id::text AS phan_in_id
    FROM phieu_san_xuat ps
    JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id AND ls.trang_thai <> 'HUY'
    JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
    JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
    WHERE ps.trang_thai = 'DANG_CHAY' AND dv.phan_in_id = ANY($1::uuid[])`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [phanInIds]);
  return rows.map((r) => r.phan_in_id);
}

// ===== GỘP SỐ LƯỢNG ĐỢT VẢI (migration 050) =====
// Ứng viên gộp: đợt vải của phần in đã QC (READY xong), CHƯA release lần nào (da_release=0),
// còn SL (>0), không nằm trong set đang mở, chưa bị gộp ẩn (trang_thai<>'DA_GOP').
// Gộp chỉ trong CÙNG phần in nên trả kèm phan_in_id để FE nhóm.
async function listGopCandidates({ search = '' }) {
  const SEARCH = `($1 = '' OR pin.ma_phan ILIKE '%'||$1||'%' OR kh.ten_khach_hang ILIKE '%'||$1||'%'
                  OR mh.ma_hang ILIKE '%'||$1||'%' OR pin.mau_vai ILIKE '%'||$1||'%'
                  OR pin.kich_vai ILIKE '%'||$1||'%' OR pin.kich_phim ILIKE '%'||$1||'%'
                  OR dv.ma_dot_vai ILIKE '%'||$1||'%')`;
  const sql = `
    SELECT dv.id AS dot_vai_id, dv.ma_dot_vai, dv.so_luong_vai_ve::int AS so_luong_vai_ve,
           dv.ngay_vai_ve, dv.han_giao_hang,
           pin.id AS phan_in_id, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.so_luong_don_hang,
           ldv.ten_loai AS loai_dot_vai, mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang
    FROM dot_vai_ve dv
    JOIN phan_in pin ON pin.id = dv.phan_in_id
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    LEFT JOIN loai_dot_vai ldv ON ldv.id = dv.loai_dot_vai_id
    WHERE COALESCE(dv.trang_thai,'') NOT IN ('DA_GOP','DA_HUY') AND pin.dang_hoat_dong
      AND COALESCE(dv.so_luong_vai_ve,0) > 0
      AND EXISTS (SELECT 1 FROM ket_qua_checkpoint kq JOIN checkpoint cp ON cp.id = kq.checkpoint_id
                  WHERE kq.phan_in_id = pin.id AND cp.ma_checkpoint = 'QC_XAC_NHAN' AND kq.trang_thai = 'DAT')
      AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai lsd JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id
                      WHERE lsd.dot_vai_ve_id = dv.id AND ls.trang_thai <> 'HUY')
      AND NOT EXISTS (SELECT 1 FROM gom_set_dot_vai gsd JOIN gom_set gs ON gs.id = gsd.gom_set_id
                      WHERE gsd.dot_vai_ve_id = dv.id AND gs.trang_thai = 'MO')
      AND ${SEARCH}
    ORDER BY pin.mau_vai, pin.ma_phan, dv.ngay_vai_ve NULLS LAST, dv.ma_dot_vai`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [search]);
  return rows;
}

// Chi tiết đợt vải để validate gộp (trong transaction dùng client). da_release>0 → không cho gộp.
async function getDotVaiForMerge(client, dotVaiIds) {
  const run = client || { query };
  const { rows } = await run.query(
    `SELECT dv.id::text AS id, dv.phan_in_id::text AS phan_in_id, dv.ma_dot_vai,
            COALESCE(dv.so_luong_vai_ve,0)::int AS so_luong_vai_ve, COALESCE(dv.trang_thai,'') AS trang_thai,
            COALESCE((SELECT SUM(ls.so_luong_release) FROM lenh_sx_dot_vai lsd
                      JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id
                      WHERE lsd.dot_vai_ve_id = dv.id AND ls.trang_thai <> 'HUY'),0)::int AS da_release
     FROM dot_vai_ve dv WHERE dv.id = ANY($1::uuid[])`,
    [dotVaiIds]
  );
  return rows;
}

// Cộng/trừ SL đợt vải (delta có thể âm). Trả về SL sau.
async function adjustDotVaiQty(client, dotVaiId, delta, actorId) {
  const { rows } = await client.query(
    `UPDATE dot_vai_ve SET so_luong_vai_ve = COALESCE(so_luong_vai_ve,0) + $2,
       updated_by = $3, updated_date = CURRENT_TIMESTAMP
     WHERE id = $1 RETURNING COALESCE(so_luong_vai_ve,0)::int AS so_luong`,
    [dotVaiId, delta, actorId]
  );
  return rows[0].so_luong;
}

// Đợt vải về 0 sau khi gộp/trừ → ẩn khỏi hệ thống (trang_thai='DA_GOP').
async function markDotVaiGop(client, dotVaiId, actorId) {
  await client.query(
    "UPDATE dot_vai_ve SET trang_thai='DA_GOP', updated_by=$2, updated_date=CURRENT_TIMESTAMP WHERE id=$1",
    [dotVaiId, actorId]
  );
}

async function insertGopHistory(client, h, actorId) {
  await client.query(
    `INSERT INTO lich_su_gop_dot_vai
       (dot_dich_id, dot_nguon_id, phan_in_id, so_luong_gop, so_luong_dich_truoc, so_luong_dich_sau,
        so_luong_nguon_truoc, so_luong_nguon_sau, nguon_het, nguoi_thuc_hien_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
    [h.dotDichId, h.dotNguonId, h.phanInId || null, h.soLuongGop,
     h.soLuongDichTruoc, h.soLuongDichSau, h.soLuongNguonTruoc, h.soLuongNguonSau, !!h.nguonHet, actorId]
  );
}

// Lịch sử gộp theo ngày (giờ VN) — cho HistoryPanel.
async function gopHistoryByDate(date) {
  const sql = `
    SELECT h.thoi_gian AS tg, nd.ho_ten AS nguoi,
           dvd.ma_dot_vai AS dot_dich, dvn.ma_dot_vai AS dot_nguon,
           pin.ma_phan, pin.mau_vai, mh.ma_hang, kh.ten_khach_hang,
           h.so_luong_gop, h.so_luong_dich_truoc, h.so_luong_dich_sau, h.nguon_het
    FROM lich_su_gop_dot_vai h
    LEFT JOIN nguoi_dung nd ON nd.id = h.nguoi_thuc_hien_id
    LEFT JOIN dot_vai_ve dvd ON dvd.id = h.dot_dich_id
    LEFT JOIN dot_vai_ve dvn ON dvn.id = h.dot_nguon_id
    LEFT JOIN phan_in pin ON pin.id = h.phan_in_id
    LEFT JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    LEFT JOIN don_hang dh ON dh.id = mh.don_hang_id
    LEFT JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    WHERE (h.thoi_gian AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $1::date
    ORDER BY h.thoi_gian DESC`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [date]);
  return rows;
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
       (workflow_version_id, ma_lenh_san_xuat, chuyen_id, so_luong_release, ngay_ke_hoach, trang_thai,
        giai_doan, lenh_lien_ket_id, tg_bd_kh, tg_kt_kh, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [data.versionId, data.maLenh, data.chuyenId, data.soLuongRelease, data.ngayKeHoach || null,
     data.trangThai || 'RELEASE_1', data.giaiDoan || 'IN', data.lenhLienKetId || null,
     data.tgBdKh || null, data.tgKtKh || null, actorId]
  );
  return rows[0].id;
}

// In kiếng: kích hoạt đợt EP_UI (holding CHO_IN_XONG) của 1 đợt IN vừa chạy hoàn tất → chờ chạy (RELEASE_2).
async function activateEpUi(inLenhId, actorId) {
  const { rows } = await query(
    `UPDATE lenh_san_xuat SET trang_thai='RELEASE_2', updated_by=$2, updated_date=CURRENT_TIMESTAMP
     WHERE lenh_lien_ket_id=$1 AND giai_doan='EP_UI' AND trang_thai='CHO_IN_XONG'
     RETURNING id, ma_lenh_san_xuat`,
    [inLenhId, actorId]
  );
  return rows[0] || null;
}

// Giai đoạn + liên kết của 1 lệnh (cho vòng ép ủi).
async function getLenhGiaiDoan(lenhId) {
  const { rows } = await query('SELECT id, giai_doan, lenh_lien_ket_id FROM lenh_san_xuat WHERE id=$1', [lenhId]);
  return rows[0] || null;
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

async function addLenhDotVai(client, lenhId, dotVaiId, actorId, soLuong = null) {
  await client.query(
    `INSERT INTO lenh_sx_dot_vai (lenh_san_xuat_id, dot_vai_ve_id, so_luong, created_by)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (lenh_san_xuat_id, dot_vai_ve_id) DO UPDATE SET so_luong = EXCLUDED.so_luong`,
    [lenhId, dotVaiId, soLuong, actorId]
  );
}

async function dotVaiAlreadyReleased(dotVaiIds) {
  const { rows } = await query(
    `SELECT lsd.dot_vai_ve_id FROM lenh_sx_dot_vai lsd JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id
     WHERE lsd.dot_vai_ve_id = ANY($1::uuid[]) AND ls.trang_thai <> 'HUY'`,
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
            ldv.ten_loai AS loai_dot_vai,
            mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang,
            EXISTS (SELECT 1 FROM ket_qua_checkpoint kq JOIN checkpoint cp ON cp.id = kq.checkpoint_id
                    WHERE kq.phan_in_id = pin.id AND cp.ma_checkpoint = 'QC_XAC_NHAN' AND kq.trang_thai = 'DAT') AS qc_done
     FROM gom_set gs
     JOIN gom_set_dot_vai gsd ON gsd.gom_set_id = gs.id
     JOIN dot_vai_ve dv ON dv.id = gsd.dot_vai_ve_id
     JOIN phan_in pin ON pin.id = dv.phan_in_id
     LEFT JOIN loai_dot_vai ldv ON ldv.id = dv.loai_dot_vai_id
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
            EXISTS (SELECT 1 FROM lenh_sx_dot_vai lsd JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id
                    WHERE lsd.dot_vai_ve_id = dv.id AND ls.trang_thai <> 'HUY') AS da_release
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
           dv.so_luong_vai_ve, dv.ngay_vai_ve, dv.han_giao_hang, ldv.ten_loai AS loai_dot_vai
    FROM lenh_sx_dot_vai lsd
    JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
    JOIN phan_in pin ON pin.id = dv.phan_in_id
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    LEFT JOIN loai_dot_vai ldv ON ldv.id = dv.loai_dot_vai_id
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
           info.so_luong_don_hang, info.so_luong_vai_ve, info.ngay_vai_ve,
           (SELECT min(dvh.han_giao_hang) FROM lenh_sx_dot_vai lsh JOIN dot_vai_ve dvh ON dvh.id=lsh.dot_vai_ve_id WHERE lsh.lenh_san_xuat_id=ls.id) AS han_giao_hang,
           info.loai_dot_vai,
           EXISTS (SELECT 1 FROM ket_qua_checkpoint k WHERE k.lenh_san_xuat_id = ls.id AND k.checkpoint_id = $1 AND k.trang_thai='DAT') AS cnsp_done,
           EXISTS (SELECT 1 FROM ket_qua_checkpoint k WHERE k.lenh_san_xuat_id = ls.id AND k.checkpoint_id = $2 AND k.trang_thai='DAT') AS qa_done,
           (SELECT count(*) FROM test_run tr WHERE tr.lenh_san_xuat_id = ls.id)::int AS so_lan_test,
           (SELECT count(*) FROM lenh_sx_dot_vai lsd WHERE lsd.lenh_san_xuat_id = ls.id)::int AS so_dot_vai,
           (SELECT count(DISTINCT dv.phan_in_id) FROM lenh_sx_dot_vai lsd2 JOIN dot_vai_ve dv ON dv.id = lsd2.dot_vai_ve_id WHERE lsd2.lenh_san_xuat_id = ls.id)::int AS so_phan_in
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

// ----- LẬP KẾ HOẠCH LẠI (lệnh đang Test Run (RELEASE_1) hoặc đã RELEASE_2, chưa bắt đầu sản xuất) -----
async function listReplanCandidates({ search = '', offset = 0, limit = 50 }) {
  const FROM = `
    FROM lenh_san_xuat ls
    LEFT JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
    ${PHAN_INFO_LATERAL}
    WHERE ls.trang_thai IN ('RELEASE_1','RELEASE_2')
      AND NOT EXISTS (SELECT 1 FROM phieu_san_xuat ps WHERE ps.lenh_san_xuat_id = ls.id)
      AND ($1 = '' OR ls.ma_lenh_san_xuat ILIKE '%'||$1||'%' OR ${lenhPhanInMatch('ls.id', '$1')})`;
  const dataSql = `
    SELECT ls.id, ls.ma_lenh_san_xuat, ls.so_luong_release, ls.ngay_ke_hoach, ls.chuyen_id, ls.trang_thai,
           cs.ma_chuyen, cs.ten_chuyen,
           info.ten_khach_hang, info.ma_don_hang, info.ma_hang,
           info.mau_vai, info.kich_vai, info.kich_phim, info.ma_phan,
           info.so_luong_don_hang, info.so_luong_vai_ve, info.ngay_vai_ve, info.han_giao_hang,
           info.loai_dot_vai,
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

// ----- HỦY LỆNH / HOÀN TÁC RELEASE (lệnh RELEASE_1/RELEASE_2 chưa bắt đầu sản xuất) -----
async function listCancelableLenh({ search = '', offset = 0, limit = 50 }) {
  const FROM = `
    FROM lenh_san_xuat ls
    LEFT JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
    ${PHAN_INFO_LATERAL}
    WHERE ls.trang_thai IN ('RELEASE_1','RELEASE_2')
      AND NOT EXISTS (SELECT 1 FROM phieu_san_xuat ps WHERE ps.lenh_san_xuat_id = ls.id)
      AND ($1 = '' OR ls.ma_lenh_san_xuat ILIKE '%'||$1||'%' OR ${lenhPhanInMatch('ls.id', '$1')})`;
  const dataSql = `
    SELECT ls.id, ls.ma_lenh_san_xuat, ls.trang_thai, ls.so_luong_release, ls.ngay_ke_hoach, ls.created_date,
           cs.ma_chuyen, cs.ten_chuyen,
           info.ten_khach_hang, info.ma_don_hang, info.ma_hang,
           info.mau_vai, info.kich_vai, info.kich_phim, info.ma_phan,
           info.so_luong_don_hang, info.so_luong_vai_ve,
           EXISTS (SELECT 1 FROM ket_qua_checkpoint k JOIN checkpoint c ON c.id=k.checkpoint_id
                   WHERE k.lenh_san_xuat_id=ls.id AND c.ma_checkpoint IN ('TEST_CNSP','TEST_QA') AND k.trang_thai='DAT') AS co_test,
           (SELECT count(*) FROM lenh_sx_dot_vai lsd WHERE lsd.lenh_san_xuat_id = ls.id)::int AS so_dot_vai
    ${FROM}
    ORDER BY ls.created_date DESC
    LIMIT $2 OFFSET $3`;
  const countSql = `SELECT count(*)::int AS total ${FROM}`;
  const [data, count] = await Promise.all([
    query(dataSql, [search, limit, offset]),
    query(countSql, [search]),
  ]);
  return { rows: data.rows, total: count.rows[0].total };
}

async function getLenhForCancel(lenhId) {
  const { rows } = await query(
    `SELECT ls.id, ls.ma_lenh_san_xuat, ls.trang_thai,
            EXISTS (SELECT 1 FROM phieu_san_xuat ps WHERE ps.lenh_san_xuat_id = ls.id) AS co_phieu,
            EXISTS (SELECT 1 FROM gom_set gs WHERE gs.lenh_san_xuat_id = ls.id) AS tu_set
     FROM lenh_san_xuat ls WHERE ls.id = $1`,
    [lenhId]
  );
  return rows[0] || null;
}

// Xóa mềm lệnh: trang_thai → HUY (đợt vải quay lại pool Release 1). Test ket_qua của lệnh cũng HUY.
async function cancelLenhOrder(client, lenhId, actorId) {
  await client.query(
    "UPDATE lenh_san_xuat SET trang_thai='HUY', updated_by=$2, updated_date=CURRENT_TIMESTAMP WHERE id=$1",
    [lenhId, actorId]
  );
  await client.query(
    `UPDATE ket_qua_checkpoint SET trang_thai='HUY', updated_by=$2, updated_date=CURRENT_TIMESTAMP
     WHERE lenh_san_xuat_id=$1 AND trang_thai='DAT'`,
    [lenhId, actorId]
  );
  // Mở lại set đã release qua lệnh này (nếu có) để có thể gom/release lại.
  await client.query(
    "UPDATE gom_set SET trang_thai='MO', lenh_san_xuat_id=NULL, updated_by=$2, updated_date=CURRENT_TIMESTAMP WHERE lenh_san_xuat_id=$1 AND trang_thai='DA_RELEASE'",
    [lenhId, actorId]
  );
}

// Hủy (xóa mềm) xác nhận QC_XAC_NHAN (READY) của các phần in thuộc đợt vải — khi hoàn tác "về READY".
async function cancelReadyQcForDotVai(client, dotVaiIds, actorId) {
  await client.query(
    `UPDATE ket_qua_checkpoint SET trang_thai='HUY', nguoi_xac_nhan_id=NULL, tg_xac_nhan=NULL,
       updated_by=$2, updated_date=CURRENT_TIMESTAMP
     WHERE trang_thai='DAT'
       AND checkpoint_id IN (SELECT id FROM checkpoint WHERE ma_checkpoint='QC_XAC_NHAN')
       AND phan_in_id IN (SELECT DISTINCT phan_in_id FROM dot_vai_ve WHERE id = ANY($1::uuid[]))`,
    [dotVaiIds, actorId]
  );
}

async function logLenhCancel(lenhId, maLenh, lyDo, actorId) {
  await query(
    `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ('lenh_san_xuat', $1, 'HUY_LENH', $2::jsonb, $3, CURRENT_TIMESTAMP, $3)`,
    [String(lenhId), JSON.stringify({ ma_lenh: maLenh, ly_do: lyDo || null }), actorId]
  );
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

// Trạng thái Test Run của lệnh + NGƯỜI + GIỜ xác nhận từng mục (CNSP/QA) — cho sidebar hiển thị.
// Mỗi (lenh, checkpoint) chỉ có tối đa 1 dòng ket_qua_checkpoint nên LEFT JOIN không nhân dòng.
async function getLenhTestStatus(lenhId, cnspId, qaId) {
  const { rows } = await query(
    `SELECT
       (cn.id IS NOT NULL) AS cnsp_done, cnu.ho_ten AS cnsp_nguoi, cn.tg_xac_nhan AS cnsp_tg,
       (qa.id IS NOT NULL) AS qa_done, qau.ho_ten AS qa_nguoi, qa.tg_xac_nhan AS qa_tg
     FROM (SELECT 1) x
     LEFT JOIN ket_qua_checkpoint cn ON cn.lenh_san_xuat_id=$1 AND cn.checkpoint_id=$2 AND cn.trang_thai='DAT'
     LEFT JOIN nguoi_dung cnu ON cnu.id = cn.nguoi_xac_nhan_id
     LEFT JOIN ket_qua_checkpoint qa ON qa.lenh_san_xuat_id=$1 AND qa.checkpoint_id=$3 AND qa.trang_thai='DAT'
     LEFT JOIN nguoi_dung qau ON qau.id = qa.nguoi_xac_nhan_id`,
    [lenhId, cnspId, qaId]
  );
  return rows[0];
}

const INSERT_TEST_RUN_SQL =
  `INSERT INTO test_run (lenh_san_xuat_id, lan_test, so_luong, ket_qua, tg_bd_test, ghi_chu, created_by)
   VALUES ($1,
           (SELECT COALESCE(MAX(lan_test),0)+1 FROM test_run WHERE lenh_san_xuat_id=$1),
           $2,$3,CURRENT_TIMESTAMP,$4,$5)
   RETURNING id, lan_test`;

async function insertTestRun(lenhId, { soLuong, ketQua, ghiChu }, actorId) {
  const { rows } = await query(INSERT_TEST_RUN_SQL, [lenhId, soLuong ?? null, ketQua ?? null, ghiChu ?? null, actorId]);
  return rows[0];
}

// Bản transaction (dùng khi ghi lần test đạt cùng lúc với xác nhận QA).
async function insertTestRunTx(client, lenhId, { soLuong, ketQua, ghiChu }, actorId) {
  const { rows } = await client.query(INSERT_TEST_RUN_SQL, [lenhId, soLuong ?? null, ketQua ?? null, ghiChu ?? null, actorId]);
  return rows[0];
}

async function upsertLenhResult(client, { lenhId, checkpointId, trangThai, nguoiXacNhanId, actorId, giaTriText = null, ghiChu = null }) {
  const ex = await client.query(
    'SELECT id FROM ket_qua_checkpoint WHERE lenh_san_xuat_id=$1 AND checkpoint_id=$2',
    [lenhId, checkpointId]
  );
  if (ex.rows[0]) {
    await client.query(
      `UPDATE ket_qua_checkpoint SET trang_thai=$2, nguoi_xac_nhan_id=$3, tg_xac_nhan=CURRENT_TIMESTAMP,
         gia_tri_text=COALESCE($5, gia_tri_text), ghi_chu=COALESCE($6, ghi_chu),
         updated_by=$4, updated_date=CURRENT_TIMESTAMP WHERE id=$1`,
      [ex.rows[0].id, trangThai, nguoiXacNhanId, actorId, giaTriText, ghiChu]
    );
    return ex.rows[0].id;
  }
  const { rows } = await client.query(
    `INSERT INTO ket_qua_checkpoint (checkpoint_id, lenh_san_xuat_id, trang_thai, nguoi_xac_nhan_id, tg_xac_nhan, gia_tri_text, ghi_chu, created_by)
     VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP,$6,$7,$5) RETURNING id`,
    [checkpointId, lenhId, trangThai, nguoiXacNhanId, actorId, giaTriText, ghiChu]
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

// Hủy (xóa mềm) 1 xác nhận Test Run mức lệnh (TEST_CNSP/TEST_QA): DAT → HUY.
async function cancelLenhResult(client, lenhId, checkpointId, actorId) {
  const { rowCount } = await client.query(
    `UPDATE ket_qua_checkpoint SET trang_thai = 'HUY', nguoi_xac_nhan_id = NULL, tg_xac_nhan = NULL,
       updated_by = $3, updated_date = CURRENT_TIMESTAMP
     WHERE lenh_san_xuat_id = $1 AND checkpoint_id = $2 AND trang_thai = 'DAT'`,
    [lenhId, checkpointId, actorId]
  );
  return rowCount > 0;
}

// Ghi audit hủy xác nhận Test Run (đọc ở "Lịch sử kế hoạch" nếu cần).
async function logTestCancel(lenhId, maCheckpoint, actorId) {
  await query(
    `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ('lenh_san_xuat', $1, 'HUY_XAC_NHAN_TEST', $2::jsonb, $3, CURRENT_TIMESTAMP, $3)`,
    [String(lenhId), JSON.stringify({ checkpoint: maCheckpoint }), actorId]
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

// ===== Danh sách "đã hoàn thành" theo ngày (giờ VN) cho DonePanel — hình dạng đối tượng =====
const DONE_INFO = `info.ten_khach_hang, info.ma_don_hang, info.ma_hang,
                   info.mau_vai, info.kich_vai, info.kich_phim`;

// Release 1: lệnh sản xuất được tạo trong ngày (mỗi đợt vải 1 lệnh).
async function release1DoneByDate(date) {
  const sql = `
    SELECT ls.created_date AS tg, nd.ho_ten AS nguoi, ls.ma_lenh_san_xuat AS ma,
           ls.so_luong_release AS so_luong, ${DONE_INFO}
    FROM lenh_san_xuat ls
    LEFT JOIN nguoi_dung nd ON nd.id = ls.created_by
    ${PHAN_INFO_LATERAL}
    WHERE (ls.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $1::date
    ORDER BY ls.created_date DESC`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [date]);
  return rows;
}

// Release 2 / Lập kế hoạch lại: audit_log (RELEASE_2 | REPLAN) trong ngày.
async function planDoneByDate(date, hanhDong) {
  const sql = `
    SELECT a.thoi_gian AS tg, nd.ho_ten AS nguoi, ls.ma_lenh_san_xuat AS ma,
           ls.so_luong_release AS so_luong, ${DONE_INFO}
    FROM audit_log a
    JOIN lenh_san_xuat ls ON ls.id = a.id_ban_ghi::uuid
    LEFT JOIN nguoi_dung nd ON nd.id = a.nguoi_thuc_hien_id
    ${PHAN_INFO_LATERAL}
    WHERE a.ten_bang = 'lenh_san_xuat' AND a.hanh_dong = $2
      AND (a.thoi_gian AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $1::date
    ORDER BY a.thoi_gian DESC`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [date, hanhDong]);
  return rows;
}

// Test Run CNSP / QA: lệnh được xác nhận (lich_su_trang_thai) trong ngày theo checkpoint.
async function testDoneByDate(date, maCheckpoint) {
  const sql = `
    SELECT l.tg_thuc_hien AS tg, nd.ho_ten AS nguoi, ls.ma_lenh_san_xuat AS ma,
           ls.so_luong_release AS so_luong, ${DONE_INFO}
    FROM lich_su_trang_thai l
    JOIN ket_qua_checkpoint kq ON kq.id = l.ket_qua_checkpoint_id
    JOIN checkpoint cp ON cp.id = kq.checkpoint_id
    JOIN lenh_san_xuat ls ON ls.id = kq.lenh_san_xuat_id
    LEFT JOIN nguoi_dung nd ON nd.id = l.nguoi_thuc_hien_id
    ${PHAN_INFO_LATERAL}
    WHERE cp.ma_checkpoint = $2
      AND (l.tg_thuc_hien AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $1::date
    ORDER BY l.tg_thuc_hien DESC`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [date, maCheckpoint]);
  return rows;
}

// ----- CÀI ĐẶT CA THEO TUẦN (migration 046) — best-effort nếu bảng chưa tạo -----
async function listCaTuan() {
  try {
    const { rows } = await query(
      `SELECT id, nam, tuan, loai_ca, ghi_chu, updated_date
       FROM cai_dat_ca_tuan ORDER BY nam DESC, tuan DESC`.replace(/\s+/g, ' ')
    );
    return rows;
  } catch (e) { return []; }
}

// Map "nam-tuan" → loai_ca (để suy ca hàng loạt). Rỗng nếu bảng chưa có.
async function caModeMap() {
  const map = new Map();
  try {
    const { rows } = await query('SELECT nam, tuan, loai_ca FROM cai_dat_ca_tuan');
    rows.forEach((r) => map.set(`${r.nam}-${r.tuan}`, r.loai_ca));
  } catch (e) { /* bảng chưa tạo → mặc định NGAN ở nơi dùng */ }
  return map;
}

async function upsertCaTuan({ nam, tuan, loaiCa, ghiChu }, actorId) {
  const { rows } = await query(
    `INSERT INTO cai_dat_ca_tuan (nam, tuan, loai_ca, ghi_chu, created_by, updated_by, updated_date)
     VALUES ($1,$2,$3,$4,$5,$5, now())
     ON CONFLICT (nam, tuan) DO UPDATE
       SET loai_ca = EXCLUDED.loai_ca, ghi_chu = EXCLUDED.ghi_chu,
           updated_by = EXCLUDED.updated_by, updated_date = now()
     RETURNING id, nam, tuan, loai_ca, ghi_chu`.replace(/\s+/g, ' '),
    [nam, tuan, loaiCa, ghiChu || null, actorId]
  );
  return rows[0];
}

// DANH SÁCH RELEASE theo NGÀY KẾ HOẠCH (mỗi đợt SX ≠HUY = 1 dòng) — cho modal/report + Excel/In.
// SLNV = Σ SL vải về của các đợt trong lệnh; SL đã in/giao suy từ tem của lệnh. IPS-safe (SQL 1 dòng).
async function releaseListByDate(date) {
  const sql = `
    SELECT ls.id AS lenh_id, ls.ma_lenh_san_xuat, ls.so_luong_release, ls.ngay_ke_hoach,
           ls.tg_bd_kh, ls.tg_kt_kh, ls.giai_doan,
           cs.ma_chuyen, cs.ten_chuyen,
           pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.so_luong_don_hang,
           mh.ma_hang, mh.ten_ma_hang, dh.ma_don_hang, dh.so_po, kh.ten_khach_hang,
           u.ho_ten AS owner,
           COALESCE((SELECT SUM(dv.so_luong_vai_ve) FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id=lsd.dot_vai_ve_id WHERE lsd.lenh_san_xuat_id=ls.id),0)::int AS slnv,
           COALESCE((SELECT SUM(t.so_luong) FROM phieu_san_xuat ps JOIN tem t ON t.phieu_san_xuat_id=ps.id WHERE ps.lenh_san_xuat_id=ls.id AND t.trang_thai<>'HUY'),0)::int AS sl_da_in,
           COALESCE((SELECT SUM(t.sl_da_giao) FROM phieu_san_xuat ps JOIN tem t ON t.phieu_san_xuat_id=ps.id WHERE ps.lenh_san_xuat_id=ls.id AND t.trang_thai<>'HUY'),0)::int AS sl_da_giao
    FROM lenh_san_xuat ls
    LEFT JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
    JOIN LATERAL (SELECT dv.phan_in_id FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id=lsd.dot_vai_ve_id WHERE lsd.lenh_san_xuat_id=ls.id LIMIT 1) pv ON true
    JOIN phan_in pin ON pin.id = pv.phan_in_id
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    LEFT JOIN nguoi_dung u ON u.id = ls.created_by
    WHERE ls.trang_thai <> 'HUY' AND ls.ngay_ke_hoach = $1::date
    ORDER BY cs.ten_chuyen NULLS LAST, kh.ten_khach_hang, dh.ma_don_hang, pin.mau_vai, ls.created_date`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [date]);
  return rows;
}

module.exports = {
  releaseListByDate,
  listCaTuan, caModeMap, upsertCaTuan,
  listRelease1Candidates, release1HistoryByDate, nextMaLenh, nextMaLenhTx, createLenh,
  release1DoneByDate, planDoneByDate, testDoneByDate,
  testedDotVaiIds, getDotVaiQty, getDotVaiRemaining, getDotVaiForCompose, phanInDangChay, addLenhDotVai, dotVaiAlreadyReleased,
  activateEpUi, getLenhGiaiDoan,
  listGopCandidates, getDotVaiForMerge, adjustDotVaiQty, markDotVaiGop, insertGopHistory, gopHistoryByDate,
  listTestRunCandidates, listRelease2Candidates, getLenhBasic, getLenhDotVai, getTestRuns,
  getLenhTestStatus, insertTestRun, insertTestRunTx, upsertLenhResult, insertStatusLog, setLenhTrangThai,
  testRunHistoryByDate,
  listReplanCandidates, getLenhForReplan, updateLenhPlan, logPlanChange, planHistoryByDate,
  listCancelableLenh, getLenhForCancel, cancelLenhOrder, cancelReadyQcForDotVai, logLenhCancel,
  listReleasableSets, getOpenSetMembers, getSetForRelease, getSetMembersForRelease, markSetReleased, logGomSetReleased,
};
