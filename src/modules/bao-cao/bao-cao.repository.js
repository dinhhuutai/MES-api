'use strict';

const { query } = require('../../config/db');

// ---- Báo cáo (bao_cao) ----
async function nextMa() {
  const { rows } = await query(
    `SELECT 'BC' || LPAD((COALESCE(MAX(NULLIF(regexp_replace(ma_bao_cao,'\\D','','g'),''))::int,0)+1)::text, 4, '0') AS ma
     FROM bao_cao`
  );
  return rows[0].ma;
}

async function create({ maBaoCao, tenBaoCao, moTa, nguoiDungId, noiDungJson, kyTu, kyDen }, actorId) {
  const { rows } = await query(
    `INSERT INTO bao_cao (ma_bao_cao, ten_bao_cao, mo_ta, nguoi_dung_id, noi_dung_json, ky_tu, ky_den, created_by)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8) RETURNING id`,
    [maBaoCao, tenBaoCao, moTa || null, nguoiDungId, JSON.stringify(noiDungJson || {}), kyTu || null, kyDen || null, actorId]
  );
  return rows[0].id;
}

// list báo cáo: của tôi (mine=userId) hoặc tất cả (all=true).
async function list({ search = '', userId, all = false }) {
  const { rows } = await query(
    `SELECT b.id, b.ma_bao_cao, b.ten_bao_cao, b.mo_ta, b.ky_tu, b.ky_den,
            b.nguoi_dung_id, u.ho_ten AS nguoi_tao, b.updated_date, b.created_date,
            (b.noi_dung_truoc_json IS NOT NULL) AS co_the_hoan_tac
     FROM bao_cao b
     LEFT JOIN nguoi_dung u ON u.id = b.nguoi_dung_id
     WHERE b.dang_hoat_dong = true
       AND ($3 = true OR b.nguoi_dung_id = $2)
       AND ($1 = '' OR b.ma_bao_cao ILIKE '%'||$1||'%' OR b.ten_bao_cao ILIKE '%'||$1||'%')
     ORDER BY b.updated_date DESC NULLS LAST, b.created_date DESC`.replace(/\s+/g, ' '),
    [search, userId, all]
  );
  return rows;
}

async function findById(id) {
  const { rows } = await query(
    `SELECT b.id, b.ma_bao_cao, b.ten_bao_cao, b.mo_ta, b.nguoi_dung_id, u.ho_ten AS nguoi_tao,
            b.noi_dung_json, b.ky_tu, b.ky_den, b.dang_hoat_dong,
            (b.noi_dung_truoc_json IS NOT NULL) AS co_the_hoan_tac, b.luu_truoc_luc
     FROM bao_cao b LEFT JOIN nguoi_dung u ON u.id = b.nguoi_dung_id
     WHERE b.id = $1`.replace(/\s+/g, ' '),
    [id]
  );
  return rows[0] || null;
}

// Lưu: đẩy noi_dung_json hiện tại → noi_dung_truoc_json (undo 1 bước) rồi ghi mới.
async function update(id, { tenBaoCao, moTa, noiDungJson, kyTu, kyDen }, actorId) {
  await query(
    `UPDATE bao_cao SET
       ten_bao_cao = COALESCE($2, ten_bao_cao),
       mo_ta = $3,
       noi_dung_truoc_json = noi_dung_json,
       luu_truoc_luc = CURRENT_TIMESTAMP,
       noi_dung_json = $4::jsonb,
       ky_tu = $5, ky_den = $6,
       updated_by = $7, updated_date = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [id, tenBaoCao ?? null, moTa ?? null, JSON.stringify(noiDungJson || {}), kyTu || null, kyDen || null, actorId]
  );
}

// Hoàn tác: khôi phục noi_dung_truoc_json (nếu có), xóa bản trước.
async function undo(id, actorId) {
  const { rowCount } = await query(
    `UPDATE bao_cao SET
       noi_dung_json = noi_dung_truoc_json,
       noi_dung_truoc_json = NULL, luu_truoc_luc = NULL,
       updated_by = $2, updated_date = CURRENT_TIMESTAMP
     WHERE id = $1 AND noi_dung_truoc_json IS NOT NULL`,
    [id, actorId]
  );
  return rowCount > 0;
}

async function softDelete(id, actorId) {
  await query(
    'UPDATE bao_cao SET dang_hoat_dong = false, updated_by = $2, updated_date = CURRENT_TIMESTAMP WHERE id = $1',
    [id, actorId]
  );
}

// ---- Audit (dùng audit_log) ----
async function audit(tenBang, idBanGhi, hanhDong, cu, moi, actorId) {
  await query(
    `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_cu, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,CURRENT_TIMESTAMP,$6)`,
    [tenBang, String(idBanGhi), hanhDong, cu ? JSON.stringify(cu) : null, moi ? JSON.stringify(moi) : null, actorId]
  );
}

async function historyByDate(baoCaoId, date) {
  const { rows } = await query(
    `SELECT a.thoi_gian AS tg, nd.ho_ten AS nguoi, a.hanh_dong, a.gia_tri_moi
     FROM audit_log a LEFT JOIN nguoi_dung nd ON nd.id = a.nguoi_thuc_hien_id
     WHERE a.ten_bang = 'bao_cao' AND a.id_ban_ghi = $1
       AND (a.thoi_gian AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $2::date
     ORDER BY a.thoi_gian DESC`.replace(/\s+/g, ' '),
    [String(baoCaoId), date]
  );
  return rows;
}

// ---- Áp dụng theo phòng ban ----
async function listPhongBanApDung() {
  const { rows } = await query(
    `SELECT pb.id AS phong_ban_id, pb.ma_phong_ban, pb.ten_phong_ban,
            hh.id AS ap_dung_id, hh.bao_cao_id AS hh_bao_cao_id,
            hhb.ma_bao_cao AS hh_ma, hhb.ten_bao_cao AS hh_ten,
            hh.ngay_duyet AS hh_ngay, hhu.ho_ten AS hh_nguoi_duyet
     FROM phong_ban pb
     LEFT JOIN LATERAL (
       SELECT x.* FROM bao_cao_phong_ban x
       WHERE x.phong_ban_id = pb.id AND x.trang_thai = 'DA_DUYET'
       ORDER BY x.ngay_duyet DESC NULLS LAST, x.created_date DESC LIMIT 1
     ) hh ON true
     LEFT JOIN bao_cao hhb ON hhb.id = hh.bao_cao_id
     LEFT JOIN nguoi_dung hhu ON hhu.id = hh.nguoi_duyet_id
     WHERE pb.dang_hoat_dong = true
     ORDER BY pb.ten_phong_ban`.replace(/\s+/g, ' ')
  );
  return rows;
}

async function listChoDuyet() {
  const { rows } = await query(
    `SELECT x.id, x.phong_ban_id, pb.ten_phong_ban, x.bao_cao_id,
            b.ma_bao_cao, b.ten_bao_cao, x.ghi_chu, x.created_date, u.ho_ten AS nguoi_de_xuat
     FROM bao_cao_phong_ban x
     JOIN phong_ban pb ON pb.id = x.phong_ban_id
     JOIN bao_cao b ON b.id = x.bao_cao_id
     LEFT JOIN nguoi_dung u ON u.id = x.nguoi_de_xuat_id
     WHERE x.trang_thai = 'CHO_DUYET'
     ORDER BY x.created_date DESC`.replace(/\s+/g, ' ')
  );
  return rows;
}

async function createDeXuat({ phongBanId, baoCaoId, ghiChu }, actorId) {
  const { rows } = await query(
    `INSERT INTO bao_cao_phong_ban (phong_ban_id, bao_cao_id, trang_thai, nguoi_de_xuat_id, ghi_chu, created_by)
     VALUES ($1,$2,'CHO_DUYET',$3,$4,$3) RETURNING id`,
    [phongBanId, baoCaoId, actorId, ghiChu || null]
  );
  return rows[0].id;
}

async function getDeXuat(id) {
  const { rows } = await query('SELECT * FROM bao_cao_phong_ban WHERE id = $1', [id]);
  return rows[0] || null;
}

async function duyet(id, actorId) {
  await query(
    `UPDATE bao_cao_phong_ban SET trang_thai = 'DA_DUYET', nguoi_duyet_id = $2, ngay_duyet = CURRENT_TIMESTAMP,
       updated_by = $2, updated_date = CURRENT_TIMESTAMP
     WHERE id = $1 AND trang_thai = 'CHO_DUYET'`,
    [id, actorId]
  );
}

async function tuChoi(id, lyDo, actorId) {
  await query(
    `UPDATE bao_cao_phong_ban SET trang_thai = 'TU_CHOI', nguoi_duyet_id = $2, ngay_duyet = CURRENT_TIMESTAMP,
       ly_do_tu_choi = $3, updated_by = $2, updated_date = CURRENT_TIMESTAMP
     WHERE id = $1 AND trang_thai = 'CHO_DUYET'`,
    [id, actorId, lyDo || null]
  );
}

// Hủy áp dụng: gỡ báo cáo hiện hành khỏi phòng ban (DA_DUYET → HUY). Trả số dòng bị gỡ.
async function huyApDung(phongBanId, actorId) {
  const { rowCount } = await query(
    `UPDATE bao_cao_phong_ban SET trang_thai = 'HUY', updated_by = $2, updated_date = CURRENT_TIMESTAMP
     WHERE phong_ban_id = $1 AND trang_thai = 'DA_DUYET'`,
    [phongBanId, actorId]
  );
  return rowCount;
}

async function hienHanh(phongBanId) {
  const { rows } = await query(
    `SELECT b.id, b.ma_bao_cao, b.ten_bao_cao, b.noi_dung_json, b.ky_tu, b.ky_den
     FROM bao_cao_phong_ban x JOIN bao_cao b ON b.id = x.bao_cao_id
     WHERE x.phong_ban_id = $1 AND x.trang_thai = 'DA_DUYET'
     ORDER BY x.ngay_duyet DESC NULLS LAST, x.created_date DESC LIMIT 1`.replace(/\s+/g, ' '),
    [phongBanId]
  );
  return rows[0] || null;
}

module.exports = {
  nextMa, create, list, findById, update, undo, softDelete,
  audit, historyByDate,
  listPhongBanApDung, listChoDuyet, createDeXuat, getDeXuat, duyet, tuChoi, huyApDung, hienHanh,
};
