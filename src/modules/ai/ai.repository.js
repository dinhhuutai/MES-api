'use strict';

// Nhật ký hỏi đáp Agent MES THLA (mig 138: ai_hoi_thoai, ai_tin_nhan). claude_agent_mes chỉ SELECT/INSERT/UPDATE
// ⇒ xóa cuộc trò chuyện = xóa MỀM (trang_thai 'DA_XOA').

const { query } = require('../../config/db');

let coBangCache = { tg: 0, co: false };
/** Mig 138 đã chạy chưa (cache 60 giây). */
async function coBangAi() {
  if (Date.now() - coBangCache.tg < 60000) return coBangCache.co;
  const { rows } = await query(
    "SELECT to_regclass('public.ai_hoi_thoai') IS NOT NULL AND to_regclass('public.ai_tin_nhan') IS NOT NULL AS co");
  coBangCache = { tg: Date.now(), co: !!rows[0].co };
  return coBangCache.co;
}

// Mốc 00:00 hôm nay giờ Việt Nam.
const DAU_NGAY_VN = "(date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh')";

async function demCauHoiHomNay(userId) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM ai_tin_nhan t JOIN ai_hoi_thoai h ON h.id = t.hoi_thoai_id
      WHERE h.nguoi_dung_id = $1 AND t.vai_tro = 'NGUOI_DUNG' AND t.created_date >= ${DAU_NGAY_VN}`, [userId]);
  return rows[0].n;
}

async function layHoiThoai(id, userId) {
  const { rows } = await query(
    "SELECT * FROM ai_hoi_thoai WHERE id = $1 AND nguoi_dung_id = $2 AND trang_thai <> 'DA_XOA'", [id, userId]);
  return rows[0] || null;
}

async function taoHoiThoai(userId, tieuDe, nhaCungCap, model) {
  const { rows } = await query(
    `INSERT INTO ai_hoi_thoai (nguoi_dung_id, tieu_de, nha_cung_cap, model, created_by)
     VALUES ($1, $2, $3, $4, $1) RETURNING *`, [userId, String(tieuDe || '').slice(0, 200), nhaCungCap, model]);
  return rows[0];
}

async function themTinNhan(t) {
  const { rows } = await query(
    `INSERT INTO ai_tin_nhan (hoi_thoai_id, vai_tro, noi_dung, cong_cu, model, token_vao, token_ra, thoi_gian_ms, loi, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, vai_tro, noi_dung, cong_cu, loi, danh_gia, created_date`,
    [t.hoiThoaiId, t.vaiTro, t.noiDung || null, t.congCu ? JSON.stringify(t.congCu) : null, t.model || null,
      t.tokenVao ?? null, t.tokenRa ?? null, t.thoiGianMs ?? null, t.loi || null, t.userId || null]);
  return rows[0];
}

async function capNhatTongHoiThoai(id, { cauHoi = 0, tokenVao = 0, tokenRa = 0 }, userId) {
  await query(
    `UPDATE ai_hoi_thoai SET so_cau_hoi = so_cau_hoi + $2, tong_token_vao = tong_token_vao + $3,
            tong_token_ra = tong_token_ra + $4, tg_cuoi = now(), updated_date = now(), updated_by = $5
      WHERE id = $1`, [id, cauHoi, tokenVao, tokenRa, userId]);
}

/** Tin nhắn gần nhất (NGUOI_DUNG/AI) của 1 cuộc trò chuyện — làm ngữ cảnh gửi model. */
async function lichSuGanNhat(hoiThoaiId, soTin = 12) {
  const { rows } = await query(
    `SELECT vai_tro, noi_dung FROM (
       SELECT vai_tro, noi_dung, created_date FROM ai_tin_nhan
        WHERE hoi_thoai_id = $1 AND loi IS NULL AND noi_dung IS NOT NULL
        ORDER BY created_date DESC LIMIT $2) x
      ORDER BY created_date`, [hoiThoaiId, soTin]);
  return rows;
}

async function dsHoiThoai(userId, gioiHan = 30) {
  const { rows } = await query(
    `SELECT id, tieu_de, so_cau_hoi, tg_cuoi, created_date FROM ai_hoi_thoai
      WHERE nguoi_dung_id = $1 AND trang_thai <> 'DA_XOA'
      ORDER BY COALESCE(tg_cuoi, created_date) DESC LIMIT $2`, [userId, gioiHan]);
  return rows;
}

async function dsTinNhan(hoiThoaiId) {
  const { rows } = await query(
    `SELECT id, vai_tro, noi_dung, cong_cu, loi, danh_gia, created_date FROM ai_tin_nhan
      WHERE hoi_thoai_id = $1 ORDER BY created_date`, [hoiThoaiId]);
  return rows;
}

async function xoaMemHoiThoai(id, userId) {
  const { rowCount } = await query(
    `UPDATE ai_hoi_thoai SET trang_thai = 'DA_XOA', updated_date = now(), updated_by = $2
      WHERE id = $1 AND nguoi_dung_id = $2 AND trang_thai <> 'DA_XOA'`, [id, userId]);
  return rowCount > 0;
}

async function danhGiaTinNhan(tinNhanId, userId, danhGia, ghiChu) {
  const { rowCount } = await query(
    `UPDATE ai_tin_nhan t SET danh_gia = $3, ghi_chu_danh_gia = $4, updated_date = now(), updated_by = $2
       FROM ai_hoi_thoai h
      WHERE t.id = $1 AND h.id = t.hoi_thoai_id AND h.nguoi_dung_id = $2 AND t.vai_tro = 'AI'`,
    [tinNhanId, userId, danhGia, ghiChu ? String(ghiChu).slice(0, 500) : null]);
  return rowCount > 0;
}

// Mẫu robot người dùng chọn (mig 138, `nguoi_dung.ai_mau_robot`). Đọc qua to_jsonb ⇒ chạy cả khi chưa có cột.
async function layMauRobot(userId) {
  const { rows } = await query("SELECT to_jsonb(nd)->>'ai_mau_robot' AS mau FROM nguoi_dung nd WHERE nd.id = $1", [userId]);
  return rows[0] ? rows[0].mau : null;
}

async function datMauRobot(userId, mau) {
  await query('UPDATE nguoi_dung SET ai_mau_robot = $2, updated_date = now(), updated_by = $1 WHERE id = $1', [userId, mau]);
}

// Chỗ hiện robot của từng người (MOI_TRANG · TRANG_CHU · AN) — KHÔNG có cột: lưu ở audit_log
// `ten_bang='ai_hien'`, `id_ban_ghi` = id người dùng, dòng MỚI NHẤT thắng (index idx_audit_log_bang) ⇒ không cần migration.
async function layCheDoHien(userId) {
  const { rows } = await query(
    `SELECT gia_tri_moi->>'hien' AS hien FROM audit_log
      WHERE ten_bang = 'ai_hien' AND id_ban_ghi = $1 AND hanh_dong = 'DOI_AI_HIEN'
      ORDER BY thoi_gian DESC, created_date DESC LIMIT 1`, [String(userId)]);
  return rows[0] ? rows[0].hien : null;
}

async function datCheDoHien(userId, hien, cu) {
  await query(
    `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_cu, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ('ai_hien', $1, 'DOI_AI_HIEN', $2::jsonb, $3::jsonb, $4, clock_timestamp(), $4)`,
    [String(userId), cu ? JSON.stringify({ hien: cu }) : null, JSON.stringify({ hien }), userId]);
}

module.exports = {
  layMauRobot, datMauRobot, layCheDoHien, datCheDoHien,
  coBangAi, demCauHoiHomNay, layHoiThoai, taoHoiThoai, themTinNhan, capNhatTongHoiThoai,
  lichSuGanNhat, dsHoiThoai, dsTinNhan, xoaMemHoiThoai, danhGiaTinNhan,
};
