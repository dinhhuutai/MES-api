'use strict';

const { query } = require('../../config/db');

// Đọc cấu hình READY (version + trạm + checkpoint) trong 1 query (giảm round-trip tới DB ở xa).
async function loadReadyConfig() {
  const sql = `
    WITH v AS (
      SELECT id, ma_version, ten_version FROM workflow_version
      WHERE la_hien_hanh = true ORDER BY ngay_hieu_luc DESC LIMIT 1
    )
    SELECT v.id AS version_id, v.ma_version, v.ten_version,
           t.id AS tram_id, t.ma_tram, t.ten_tram, t.thu_tu AS tram_thu_tu, t.thoi_gian_quy_dinh_phut, t.canh_bao_truoc_phut,
           cp.id AS cp_id, cp.ma_checkpoint, cp.ten_checkpoint, cp.bat_buoc, cp.thu_tu AS cp_thu_tu,
           cp.cau_hinh_json, lc.ma_loai AS loai_checkpoint
    FROM v
    LEFT JOIN tram t ON t.workflow_version_id = v.id AND t.ma_tram = 'READY'
    LEFT JOIN checkpoint cp ON cp.tram_id = t.id AND cp.dang_hoat_dong = true
    LEFT JOIN loai_checkpoint lc ON lc.id = cp.loai_checkpoint_id
    ORDER BY cp.thu_tu`;
  const { rows } = await query(sql);
  return rows;
}

// Danh sách phần in cho READY.
//  - inputIds: id 4 checkpoint kỹ thuật (KHUON/FILM/MUC/HSKT) → đếm n_tech_done.
//  - onlyQcReady=true: chỉ phần in đủ 4 mục & chưa QC (màn QC bên Chất lượng).
//  - mặc định: phần in chưa QC xong (màn Chuẩn bị kỹ thuật).
async function listCandidates({
  search = '', inputIds = [], qcId, khuonId, filmId, mucId, hsktId,
  onlyQcReady = false, offset = 0, limit = 20, readySla = null, readyCanhBao = null,
}) {
  const SEARCH = `($1 = '' OR pin.ma_phan ILIKE '%'||$1||'%' OR kh.ten_khach_hang ILIKE '%'||$1||'%'
                  OR dh.ma_don_hang ILIKE '%'||$1||'%' OR mh.ma_hang ILIKE '%'||$1||'%'
                  OR pin.mau_vai ILIKE '%'||$1||'%' OR pin.kich_vai ILIKE '%'||$1||'%'
                  OR pin.kich_phim ILIKE '%'||$1||'%')`;
  const doneExpr = (param) =>
    `EXISTS (SELECT 1 FROM ket_qua_checkpoint k WHERE k.phan_in_id = pin.id AND k.checkpoint_id = ${param} AND k.trang_thai = 'DAT')`;
  // withItems=true: kèm cờ tình trạng từng mục (cho bảng); dùng $6..$9.
  const selectBase = (withItems) => `
    SELECT pin.id, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim,
           mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang,
           (SELECT string_agg(DISTINCT gs.ma_set, ', ')
              FROM dot_vai_ve dv JOIN gom_set_dot_vai gsd ON gsd.dot_vai_ve_id = dv.id
              JOIN gom_set gs ON gs.id = gsd.gom_set_id AND gs.trang_thai = 'MO'
              WHERE dv.phan_in_id = pin.id) AS gom_set_list,
           (SELECT count(*) FROM ket_qua_checkpoint k
              WHERE k.phan_in_id = pin.id AND k.checkpoint_id = ANY($2::uuid[]) AND k.trang_thai = 'DAT')::int AS n_tech_done,
           ${doneExpr('$3')} AS qc_done${withItems ? `,
           ${doneExpr('$6')} AS khuon_done,
           ${doneExpr('$7')} AS film_done,
           ${doneExpr('$8')} AS muc_done,
           ${doneExpr('$9')} AS hskt_done` : ''},
           sla.tg_vao, sla.sla_phut, sla.canh_bao_truoc_phut
    FROM phan_in pin
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    LEFT JOIN LATERAL (
      -- Mốc "vào READY": ưu tiên ton_tram (029), fallback thời điểm đợt vải về (ERP sync) — đợt chưa release.
      SELECT COALESCE(
               (SELECT min(tt.tg_vao) FROM ton_tram tt JOIN dot_vai_ve d2 ON d2.id = tt.dot_vai_ve_id
                  JOIN tram tr ON tr.id = tt.tram_id
                  WHERE d2.phan_in_id = pin.id AND tr.ma_tram = 'READY'),
               (SELECT min(COALESCE(dv.created_date, dv.ngay_vai_ve::timestamptz)) FROM dot_vai_ve dv
                  WHERE dv.phan_in_id = pin.id
                    AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai lsd WHERE lsd.dot_vai_ve_id = dv.id))
             ) AS tg_vao,
             $10::int AS sla_phut, $11::int AS canh_bao_truoc_phut
    ) sla ON true
    WHERE ${SEARCH}`;

  // Mặc định (màn kỹ thuật): mọi phần in chưa QC xong.
  // onlyQcReady (màn QC): chỉ phần in ĐÃ ĐỦ 4 mục kỹ thuật & chưa QC.
  const OUTER_WHERE = onlyQcReady
    ? 'WHERE q.qc_done = false AND q.n_tech_done >= 4'
    : 'WHERE q.qc_done = false';

  // Gộp data + total vào 1 query bằng COUNT(*) OVER() (1 round-trip thay vì 2).
  const dataSql = `
    SELECT q.*, count(*) OVER()::int AS total_count
    FROM (${selectBase(true)}) q
    ${OUTER_WHERE}
    ORDER BY q.n_tech_done DESC, q.ma_phan
    LIMIT $4 OFFSET $5`;

  const { rows } = await query(dataSql, [search, inputIds, qcId, limit, offset, khuonId, filmId, mucId, hsktId, readySla, readyCanhBao]);
  const total = rows.length ? rows[0].total_count : 0;
  // Bỏ cột phụ total_count khỏi từng dòng trả về.
  const items = rows.map(({ total_count, ...r }) => r);
  return { rows: items, total };
}

// Lịch sử xác nhận theo ngày (giờ VN). scope: 'tech' (4 mục) | 'qc' (QC_XAC_NHAN).
async function historyByDate(date, maList) {
  const sql = `
    SELECT l.tg_thuc_hien AS tg, nd.ho_ten AS nguoi, l.ly_do AS hanh_dong,
           pin.ma_phan, mh.ma_hang, kh.ten_khach_hang, kq.gia_tri_text AS chi_tiet
    FROM lich_su_trang_thai l
    JOIN ket_qua_checkpoint kq ON kq.id = l.ket_qua_checkpoint_id
    JOIN checkpoint cp ON cp.id = kq.checkpoint_id
    JOIN tram t ON t.id = cp.tram_id
    JOIN phan_in pin ON pin.id = kq.phan_in_id
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    LEFT JOIN nguoi_dung nd ON nd.id = l.nguoi_thuc_hien_id
    WHERE t.ma_tram = 'READY' AND cp.ma_checkpoint = ANY($2)
      AND (l.tg_thuc_hien AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $1::date
    ORDER BY l.tg_thuc_hien DESC`;
  const { rows } = await query(sql, [date, maList]);
  return rows;
}

async function getPhanInBasic(phanInId) {
  const { rows } = await query(
    `SELECT pin.id, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim,
            mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang
     FROM phan_in pin
     JOIN ma_hang mh ON mh.id = pin.ma_hang_id
     JOIN don_hang dh ON dh.id = mh.don_hang_id
     JOIN khach_hang kh ON kh.id = dh.khach_hang_id
     WHERE pin.id = $1`,
    [phanInId]
  );
  return rows[0] || null;
}

// Kết quả checkpoint của phần in tại 1 trạm (merge cấu hình + kết quả hiện có).
async function getResults(tramId, phanInId) {
  const { rows } = await query(
    `SELECT cp.id AS checkpoint_id, cp.ma_checkpoint, cp.ten_checkpoint, cp.bat_buoc, cp.thu_tu,
            cp.cau_hinh_json, cp.thoi_gian_quy_dinh_phut, cp.canh_bao_truoc_phut, lc.ma_loai AS loai_checkpoint,
            kq.id AS ket_qua_id, kq.trang_thai, kq.gia_tri_text, kq.gia_tri_json,
            kq.nguoi_xac_nhan_id, kq.tg_xac_nhan, nx.ho_ten AS nguoi_xac_nhan_ten
     FROM checkpoint cp
     LEFT JOIN loai_checkpoint lc ON lc.id = cp.loai_checkpoint_id
     LEFT JOIN ket_qua_checkpoint kq ON kq.checkpoint_id = cp.id AND kq.phan_in_id = $2
     LEFT JOIN nguoi_dung nx ON nx.id = kq.nguoi_xac_nhan_id
     WHERE cp.tram_id = $1 AND cp.dang_hoat_dong = true
     ORDER BY cp.thu_tu`,
    [tramId, phanInId]
  );
  return rows;
}

// Trạng thái DAT của nhiều phần in cho 1 nhóm checkpoint (dùng cho bulk — 1 query).
async function getBulkStates(phanInIds, checkpointIds) {
  const { rows } = await query(
    `SELECT phan_in_id, checkpoint_id FROM ket_qua_checkpoint
     WHERE phan_in_id = ANY($1::uuid[]) AND checkpoint_id = ANY($2::uuid[]) AND trang_thai = 'DAT'`,
    [phanInIds, checkpointIds]
  );
  return rows;
}

async function findResultId(client, phanInId, checkpointId) {
  const { rows } = await client.query(
    'SELECT id, trang_thai FROM ket_qua_checkpoint WHERE phan_in_id = $1 AND checkpoint_id = $2',
    [phanInId, checkpointId]
  );
  return rows[0] || null;
}

// Upsert 1 kết quả checkpoint. Trả về id.
async function upsertResult(client, data) {
  const existing = await findResultId(client, data.phanInId, data.checkpointId);
  if (existing) {
    await client.query(
      `UPDATE ket_qua_checkpoint SET
         trang_thai = $2,
         gia_tri_text = COALESCE($3, gia_tri_text),
         nguoi_xac_nhan_id = COALESCE($4, nguoi_xac_nhan_id),
         tg_xac_nhan = COALESCE($5, tg_xac_nhan),
         updated_by = $6, updated_date = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [existing.id, data.trangThai, data.giaTriText ?? null, data.nguoiXacNhanId ?? null,
       data.tgXacNhan ?? null, data.actorId]
    );
    return existing.id;
  }
  const { rows } = await client.query(
    `INSERT INTO ket_qua_checkpoint
       (checkpoint_id, phan_in_id, trang_thai, gia_tri_text, nguoi_xac_nhan_id, tg_xac_nhan, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [data.checkpointId, data.phanInId, data.trangThai, data.giaTriText ?? null,
     data.nguoiXacNhanId ?? null, data.tgXacNhan ?? null, data.actorId]
  );
  return rows[0].id;
}

// Thời điểm phần in vào trạm READY — ưu tiên ton_tram (029), fallback thời điểm đợt vải về (ERP).
async function getReadyEntryTime(phanInId) {
  const { rows } = await query(
    `SELECT COALESCE(
              (SELECT min(tt.tg_vao) FROM ton_tram tt JOIN dot_vai_ve dv ON dv.id = tt.dot_vai_ve_id
                 JOIN tram t ON t.id = tt.tram_id WHERE dv.phan_in_id = $1 AND t.ma_tram = 'READY'),
              (SELECT min(COALESCE(dv.created_date, dv.ngay_vai_ve::timestamptz)) FROM dot_vai_ve dv
                 WHERE dv.phan_in_id = $1
                   AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai lsd WHERE lsd.dot_vai_ve_id = dv.id))
            ) AS ready_tg_vao`.replace(/\s+/g, ' '),
    [phanInId]
  );
  return rows[0]?.ready_tg_vao || null;
}

async function insertStatusLog(client, { ketQuaId, trangThaiMoiId, nguoiId, lyDo }) {
  await client.query(
    `INSERT INTO lich_su_trang_thai
       (ket_qua_checkpoint_id, trang_thai_moi_id, ly_do, nguoi_thuc_hien_id, tg_thuc_hien, created_by)
     VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP,$4)`,
    [ketQuaId, trangThaiMoiId, lyDo || null, nguoiId]
  );
}

module.exports = {
  loadReadyConfig, listCandidates, historyByDate, getPhanInBasic, getResults, getBulkStates,
  getReadyEntryTime, findResultId, upsertResult, insertStatusLog,
};
