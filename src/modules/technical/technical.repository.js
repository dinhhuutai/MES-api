'use strict';

const { query } = require('../../config/db');

// Danh sách phần in CHƯA hoàn thành READY (QC chưa xác nhận).
async function listCandidates({ search = '', readyIds = [], ktId, qcId, offset = 0, limit = 20 }) {
  const SEARCH = `($1 = '' OR pin.ma_phan ILIKE '%'||$1||'%' OR kh.ten_khach_hang ILIKE '%'||$1||'%'
                  OR dh.ma_don_hang ILIKE '%'||$1||'%' OR pin.mau_vai ILIKE '%'||$1||'%')`;
  const JOINS = `
    FROM phan_in pin
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id`;

  const dataSql = `
    SELECT pin.id, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim,
           mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang,
           EXISTS (SELECT 1 FROM ket_qua_checkpoint k WHERE k.phan_in_id = pin.id AND k.checkpoint_id = $3 AND k.trang_thai = 'DAT') AS kt_done,
           EXISTS (SELECT 1 FROM ket_qua_checkpoint k WHERE k.phan_in_id = pin.id AND k.checkpoint_id = ANY($2::uuid[])) AS co_du_lieu
    ${JOINS}
    WHERE ${SEARCH}
      AND NOT EXISTS (SELECT 1 FROM ket_qua_checkpoint k
                      WHERE k.phan_in_id = pin.id AND k.checkpoint_id = $4 AND k.trang_thai = 'DAT')
    ORDER BY pin.created_date DESC
    LIMIT $5 OFFSET $6`;
  const countSql = `
    SELECT count(*)::int AS total
    ${JOINS}
    WHERE ${SEARCH}
      AND NOT EXISTS (SELECT 1 FROM ket_qua_checkpoint k
                      WHERE k.phan_in_id = pin.id AND k.checkpoint_id = $2 AND k.trang_thai = 'DAT')`;

  const [data, count] = await Promise.all([
    query(dataSql, [search, readyIds, ktId, qcId, limit, offset]),
    query(countSql, [search, qcId]),
  ]);
  return { rows: data.rows, total: count.rows[0].total };
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
            cp.cau_hinh_json, lc.ma_loai AS loai_checkpoint,
            kq.id AS ket_qua_id, kq.trang_thai, kq.gia_tri_text, kq.gia_tri_json,
            kq.nguoi_xac_nhan_id, kq.tg_xac_nhan
     FROM checkpoint cp
     LEFT JOIN loai_checkpoint lc ON lc.id = cp.loai_checkpoint_id
     LEFT JOIN ket_qua_checkpoint kq ON kq.checkpoint_id = cp.id AND kq.phan_in_id = $2
     WHERE cp.tram_id = $1 AND cp.dang_hoat_dong = true
     ORDER BY cp.thu_tu`,
    [tramId, phanInId]
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

async function insertStatusLog(client, { ketQuaId, trangThaiMoiId, nguoiId, lyDo }) {
  await client.query(
    `INSERT INTO lich_su_trang_thai
       (ket_qua_checkpoint_id, trang_thai_moi_id, ly_do, nguoi_thuc_hien_id, tg_thuc_hien, created_by)
     VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP,$4)`,
    [ketQuaId, trangThaiMoiId, lyDo || null, nguoiId]
  );
}

module.exports = {
  listCandidates, getPhanInBasic, getResults, findResultId, upsertResult, insertStatusLog,
};
