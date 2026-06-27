'use strict';

const { query } = require('../../config/db');

// Đọc cấu hình workflow động từ DB (KHÔNG hardcode) — dùng chung cho các module nghiệp vụ.

async function getActiveVersion() {
  const { rows } = await query(
    `SELECT id, ma_version, ten_version FROM workflow_version
     WHERE la_hien_hanh = true ORDER BY ngay_hieu_luc DESC NULLS LAST LIMIT 1`
  );
  return rows[0] || null;
}

async function getTramByMa(versionId, maTram) {
  const { rows } = await query(
    `SELECT id, ma_tram, ten_tram, thu_tu, thoi_gian_quy_dinh_phut
     FROM tram WHERE workflow_version_id = $1 AND ma_tram = $2`,
    [versionId, maTram]
  );
  return rows[0] || null;
}

async function getCheckpointsByTram(tramId) {
  const { rows } = await query(
    `SELECT cp.id, cp.ma_checkpoint, cp.ten_checkpoint, cp.bat_buoc, cp.thu_tu, cp.cau_hinh_json,
            lc.ma_loai AS loai_checkpoint
     FROM checkpoint cp
     LEFT JOIN loai_checkpoint lc ON lc.id = cp.loai_checkpoint_id
     WHERE cp.tram_id = $1 AND cp.dang_hoat_dong = true
     ORDER BY cp.thu_tu`,
    [tramId]
  );
  return rows;
}

async function getTrangThaiId(maTrangThai) {
  const { rows } = await query('SELECT id FROM trang_thai WHERE ma_trang_thai = $1', [maTrangThai]);
  return rows[0]?.id || null;
}

module.exports = { getActiveVersion, getTramByMa, getCheckpointsByTram, getTrangThaiId };
