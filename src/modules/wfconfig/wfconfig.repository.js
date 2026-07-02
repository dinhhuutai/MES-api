'use strict';

const { query } = require('../../config/db');

// ============ WORKFLOW VERSION ============
async function listVersions() {
  const { rows } = await query(
    `SELECT wv.id, wv.ma_version, wv.ten_version, wv.ngay_hieu_luc, wv.ngay_het_hieu_luc,
            wv.la_hien_hanh, wv.trang_thai,
            (SELECT count(*) FROM tram t WHERE t.workflow_version_id = wv.id)::int AS so_tram
     FROM workflow_version wv ORDER BY wv.la_hien_hanh DESC, wv.ngay_hieu_luc DESC NULLS LAST`
  );
  return rows;
}
async function createVersion(d, actor) {
  const { rows } = await query(
    `INSERT INTO workflow_version (ma_version, ten_version, ngay_hieu_luc, ngay_het_hieu_luc, trang_thai, la_hien_hanh, created_by)
     VALUES ($1,$2,$3,$4,$5,false,$6) RETURNING id`,
    [d.maVersion, d.tenVersion, d.ngayHieuLuc || null, d.ngayHetHieuLuc || null, d.trangThai || 'DRAFT', actor]
  );
  return rows[0].id;
}
async function updateVersion(id, d, actor) {
  await query(
    `UPDATE workflow_version SET ten_version=COALESCE($2,ten_version), ngay_hieu_luc=$3, ngay_het_hieu_luc=$4,
       trang_thai=COALESCE($5,trang_thai), updated_by=$6, updated_date=CURRENT_TIMESTAMP WHERE id=$1`,
    [id, d.tenVersion ?? null, d.ngayHieuLuc ?? null, d.ngayHetHieuLuc ?? null, d.trangThai ?? null, actor]
  );
}
async function clearHienHanh(client, actor) {
  await client.query('UPDATE workflow_version SET la_hien_hanh=false, updated_by=$1 WHERE la_hien_hanh=true', [actor]);
}
async function setHienHanh(client, id, actor) {
  await client.query(
    "UPDATE workflow_version SET la_hien_hanh=true, trang_thai='ACTIVE', updated_by=$2, updated_date=CURRENT_TIMESTAMP WHERE id=$1",
    [id, actor]
  );
}

// ============ TRAM ============
async function listTrams(versionId) {
  const { rows } = await query(
    `SELECT t.id, t.ma_tram, t.ten_tram, t.thu_tu, t.thoi_gian_quy_dinh_phut, t.canh_bao_truoc_phut, t.dang_hoat_dong,
            (SELECT count(*) FROM checkpoint cp WHERE cp.tram_id = t.id)::int AS so_checkpoint
     FROM tram t WHERE t.workflow_version_id = $1 ORDER BY t.thu_tu, t.ma_tram`,
    [versionId]
  );
  return rows;
}
async function createTram(d, actor) {
  const { rows } = await query(
    `INSERT INTO tram (workflow_version_id, ma_tram, ten_tram, thu_tu, thoi_gian_quy_dinh_phut, canh_bao_truoc_phut, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [d.versionId, d.maTram, d.tenTram, d.thuTu ?? null, d.thoiGianQuyDinhPhut ?? null, d.canhBaoTruocPhut ?? null, actor]
  );
  return rows[0].id;
}
async function updateTram(id, d, actor) {
  await query(
    `UPDATE tram SET ten_tram=COALESCE($2,ten_tram), thu_tu=$3, thoi_gian_quy_dinh_phut=$4, canh_bao_truoc_phut=$5,
       updated_by=$6, updated_date=CURRENT_TIMESTAMP WHERE id=$1`,
    [id, d.tenTram ?? null, d.thuTu ?? null, d.thoiGianQuyDinhPhut ?? null, d.canhBaoTruocPhut ?? null, actor]
  );
}
async function setTramActive(id, active, actor) {
  await query('UPDATE tram SET dang_hoat_dong=$2, updated_by=$3, updated_date=CURRENT_TIMESTAMP WHERE id=$1', [id, active, actor]);
}

// ============ CHECKPOINT ============
async function listCheckpoints(tramId) {
  const { rows } = await query(
    `SELECT cp.id, cp.ma_checkpoint, cp.ten_checkpoint, cp.mo_ta, cp.bat_buoc, cp.thu_tu,
            cp.cau_hinh_json, cp.thoi_gian_quy_dinh_phut, cp.canh_bao_truoc_phut, cp.dang_hoat_dong,
            cp.loai_checkpoint_id, lc.ma_loai AS loai_checkpoint
     FROM checkpoint cp LEFT JOIN loai_checkpoint lc ON lc.id = cp.loai_checkpoint_id
     WHERE cp.tram_id = $1 ORDER BY cp.thu_tu, cp.ma_checkpoint`,
    [tramId]
  );
  return rows;
}
async function createCheckpoint(d, actor) {
  const { rows } = await query(
    `INSERT INTO checkpoint (tram_id, loai_checkpoint_id, ma_checkpoint, ten_checkpoint, mo_ta, bat_buoc, thu_tu,
                             cau_hinh_json, thoi_gian_quy_dinh_phut, canh_bao_truoc_phut, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [d.tramId, d.loaiCheckpointId || null, d.maCheckpoint, d.tenCheckpoint, d.moTa || null,
     d.batBuoc === true, d.thuTu ?? null, d.cauHinhJson || null, d.thoiGianQuyDinhPhut ?? null, d.canhBaoTruocPhut ?? null, actor]
  );
  return rows[0].id;
}
async function updateCheckpoint(id, d, actor) {
  await query(
    `UPDATE checkpoint SET ten_checkpoint=COALESCE($2,ten_checkpoint), mo_ta=$3, bat_buoc=$4, thu_tu=$5,
       cau_hinh_json=$6, loai_checkpoint_id=$7, thoi_gian_quy_dinh_phut=$8, canh_bao_truoc_phut=$9,
       updated_by=$10, updated_date=CURRENT_TIMESTAMP WHERE id=$1`,
    [id, d.tenCheckpoint ?? null, d.moTa ?? null, d.batBuoc === true, d.thuTu ?? null,
     d.cauHinhJson ?? null, d.loaiCheckpointId ?? null, d.thoiGianQuyDinhPhut ?? null, d.canhBaoTruocPhut ?? null, actor]
  );
}
async function setCheckpointActive(id, active, actor) {
  await query('UPDATE checkpoint SET dang_hoat_dong=$2, updated_by=$3, updated_date=CURRENT_TIMESTAMP WHERE id=$1', [id, active, actor]);
}

// ============ LUAT CHUYEN TRAM ============
async function listRules(versionId) {
  const { rows } = await query(
    `SELECT l.id, l.tu_tram_id, l.den_tram_id, l.cho_phep_override, l.bat_buoc_dat_het_dk, l.mo_ta, l.dang_hoat_dong,
            t1.ma_tram AS tu_tram, t2.ma_tram AS den_tram,
            (SELECT count(*) FROM dieu_kien_chuyen_tram d WHERE d.luat_chuyen_tram_id = l.id)::int AS so_dieu_kien
     FROM luat_chuyen_tram l
     LEFT JOIN tram t1 ON t1.id = l.tu_tram_id
     LEFT JOIN tram t2 ON t2.id = l.den_tram_id
     WHERE l.workflow_version_id = $1 ORDER BY t1.thu_tu NULLS FIRST, t2.thu_tu`,
    [versionId]
  );
  return rows;
}
async function createRule(d, actor) {
  const { rows } = await query(
    `INSERT INTO luat_chuyen_tram (workflow_version_id, tu_tram_id, den_tram_id, cho_phep_override, bat_buoc_dat_het_dk, mo_ta, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [d.versionId, d.tuTramId, d.denTramId, d.choPhepOverride === true, d.batBuocDatHetDk !== false, d.moTa || null, actor]
  );
  return rows[0].id;
}
async function updateRule(id, d, actor) {
  await query(
    `UPDATE luat_chuyen_tram SET cho_phep_override=$2, bat_buoc_dat_het_dk=$3, mo_ta=$4,
       updated_by=$5, updated_date=CURRENT_TIMESTAMP WHERE id=$1`,
    [id, d.choPhepOverride === true, d.batBuocDatHetDk !== false, d.moTa ?? null, actor]
  );
}
async function setRuleActive(id, active, actor) {
  await query('UPDATE luat_chuyen_tram SET dang_hoat_dong=$2, updated_by=$3, updated_date=CURRENT_TIMESTAMP WHERE id=$1', [id, active, actor]);
}

// ============ DIEU KIEN CHUYEN TRAM (cần DELETE) ============
async function listConditions(ruleId) {
  const { rows } = await query(
    `SELECT id, ten_dieu_kien, loai_dieu_kien, nguon_du_lieu, phep_so_sanh, gia_tri_dieu_kien, bat_buoc, thu_tu
     FROM dieu_kien_chuyen_tram WHERE luat_chuyen_tram_id = $1 ORDER BY thu_tu, ten_dieu_kien`,
    [ruleId]
  );
  return rows;
}
async function createCondition(d, actor) {
  const { rows } = await query(
    `INSERT INTO dieu_kien_chuyen_tram (luat_chuyen_tram_id, ten_dieu_kien, loai_dieu_kien, nguon_du_lieu, phep_so_sanh, gia_tri_dieu_kien, bat_buoc, thu_tu, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [d.ruleId, d.tenDieuKien, d.loaiDieuKien || null, d.nguonDuLieu || null, d.phepSoSanh || null,
     d.giaTriDieuKien || null, d.batBuoc !== false, d.thuTu ?? null, actor]
  );
  return rows[0].id;
}
async function deleteCondition(id) {
  await query('DELETE FROM dieu_kien_chuyen_tram WHERE id = $1', [id]);
}

// ============ OWNER (cần DELETE) ============
async function listTramOwners(tramId) {
  const { rows } = await query(
    `SELECT o.id, o.phong_ban_id, o.user_id, o.role_id, o.loai, pb.ten_phong_ban, u.ho_ten, r.ten_role
     FROM tram_owner o
     LEFT JOIN phong_ban pb ON pb.id = o.phong_ban_id
     LEFT JOIN nguoi_dung u ON u.id = o.user_id
     LEFT JOIN vai_tro r ON r.id = o.role_id
     WHERE o.tram_id = $1 ORDER BY o.loai DESC, o.created_date`,
    [tramId]
  );
  return rows;
}
async function addTramOwner(d, actor) {
  await query(
    'INSERT INTO tram_owner (tram_id, phong_ban_id, user_id, role_id, loai, created_by) VALUES ($1,$2,$3,$4,$5,$6)',
    [d.tramId, d.phongBanId || null, d.userId || null, d.roleId || null,
     d.loai === 'CHIU_TRACH_NHIEM' ? 'CHIU_TRACH_NHIEM' : 'XU_LY', actor]
  );
}
async function removeTramOwner(id) { await query('DELETE FROM tram_owner WHERE id = $1', [id]); }

async function listCheckpointOwners(checkpointId) {
  const { rows } = await query(
    `SELECT o.id, o.phong_ban_id, o.user_id, o.role_id, o.loai, o.bat_buoc, pb.ten_phong_ban, u.ho_ten, r.ten_role
     FROM checkpoint_owner o
     LEFT JOIN phong_ban pb ON pb.id = o.phong_ban_id
     LEFT JOIN nguoi_dung u ON u.id = o.user_id
     LEFT JOIN vai_tro r ON r.id = o.role_id
     WHERE o.checkpoint_id = $1 ORDER BY o.loai DESC, o.created_date`,
    [checkpointId]
  );
  return rows;
}
async function addCheckpointOwner(d, actor) {
  await query(
    'INSERT INTO checkpoint_owner (checkpoint_id, phong_ban_id, user_id, role_id, loai, bat_buoc, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [d.checkpointId, d.phongBanId || null, d.userId || null, d.roleId || null,
     d.loai === 'CHIU_TRACH_NHIEM' ? 'CHIU_TRACH_NHIEM' : 'XU_LY', d.batBuoc === true, actor]
  );
}
async function removeCheckpointOwner(id) { await query('DELETE FROM checkpoint_owner WHERE id = $1', [id]); }

// allTrams cho dropdown (theo version)
async function allTrams(versionId) {
  const { rows } = await query(
    'SELECT id, ma_tram, ten_tram FROM tram WHERE workflow_version_id=$1 ORDER BY thu_tu', [versionId]
  );
  return rows;
}

// ============ TRANG THAI ============
async function listStatuses({ search = '', nhom = '' }) {
  const { rows } = await query(
    `SELECT id, ma_trang_thai, ten_trang_thai, nhom_trang_thai, ghi_chu, dang_hoat_dong
     FROM trang_thai
     WHERE ($1='' OR ten_trang_thai ILIKE '%'||$1||'%' OR ma_trang_thai ILIKE '%'||$1||'%')
       AND ($2='' OR nhom_trang_thai=$2)
     ORDER BY nhom_trang_thai NULLS FIRST, ma_trang_thai`,
    [search, nhom]
  );
  return rows;
}
async function createStatus(d, actor) {
  const { rows } = await query(
    `INSERT INTO trang_thai (ma_trang_thai, ten_trang_thai, nhom_trang_thai, ghi_chu, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [d.maTrangThai, d.tenTrangThai, d.nhomTrangThai || null, d.ghiChu || null, actor]
  );
  return rows[0].id;
}
async function updateStatus(id, d, actor) {
  await query(
    `UPDATE trang_thai SET ten_trang_thai=COALESCE($2,ten_trang_thai), nhom_trang_thai=$3, ghi_chu=$4,
       updated_by=$5, updated_date=CURRENT_TIMESTAMP WHERE id=$1`,
    [id, d.tenTrangThai ?? null, d.nhomTrangThai ?? null, d.ghiChu ?? null, actor]
  );
}
async function setStatusActive(id, active, actor) {
  await query('UPDATE trang_thai SET dang_hoat_dong=$2, updated_by=$3, updated_date=CURRENT_TIMESTAMP WHERE id=$1', [id, active, actor]);
}

module.exports = {
  listVersions, createVersion, updateVersion, clearHienHanh, setHienHanh,
  listTrams, createTram, updateTram, setTramActive, allTrams,
  listCheckpoints, createCheckpoint, updateCheckpoint, setCheckpointActive,
  listRules, createRule, updateRule, setRuleActive,
  listConditions, createCondition, deleteCondition,
  listTramOwners, addTramOwner, removeTramOwner,
  listCheckpointOwners, addCheckpointOwner, removeCheckpointOwner,
  listStatuses, createStatus, updateStatus, setStatusActive,
};
