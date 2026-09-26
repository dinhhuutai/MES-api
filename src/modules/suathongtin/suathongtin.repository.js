'use strict';

const { query } = require('../../config/db');
const { mauTim } = require('../../utils/timKiem');
const { LOAI_GN } = require('../../utils/traVeGn');

// ─────────────────────────────────────────────────────────────────────────────
// PHẦN IN CHỜ SỬA THÔNG TIN (READY trả về Giao nhận) — xem `utils/traVeGn.js`.
// ⚠ Chú thích để NGOÀI chuỗi SQL: các câu dưới gửi gộp 1 dòng (bẫy IPS §9), `--` sẽ nuốt đuôi câu.
// ─────────────────────────────────────────────────────────────────────────────

// Nguồn trả về (Kỹ thuật / QC) + ghi chú lúc GN xác nhận lại nằm ở audit_log, khóa = qc_tra_ve.id.
const AUDIT_NGUON = `(SELECT a.gia_tri_moi->>'nguon' FROM audit_log a
   WHERE a.ten_bang = 'qc_tra_ve' AND a.id_ban_ghi = q.id::text AND a.hanh_dong = 'TRA_VE_GN'
   ORDER BY a.thoi_gian DESC LIMIT 1)`;
const AUDIT_GHI_CHU_XN = `(SELECT a.gia_tri_moi->>'ghi_chu' FROM audit_log a
   WHERE a.ten_bang = 'qc_tra_ve' AND a.id_ban_ghi = q.id::text AND a.hanh_dong IN ('GN_XAC_NHAN_LAI','GN_HUY_DOT_VAI')
   ORDER BY a.thoi_gian DESC LIMIT 1)`;
// Cách GN xử lý lượt trả về: 'GN_XAC_NHAN_LAI' (sửa xong, về READY) | 'GN_HUY_DOT_VAI' (hủy vải, không in).
const AUDIT_KIEU_XU_LY = `(SELECT a.hanh_dong FROM audit_log a
   WHERE a.ten_bang = 'qc_tra_ve' AND a.id_ban_ghi = q.id::text AND a.hanh_dong IN ('GN_XAC_NHAN_LAI','GN_HUY_DOT_VAI')
   ORDER BY a.thoi_gian DESC LIMIT 1)`;

const COT_PIN = `pin.id AS phan_in_id, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.tinh_chat_in,
  pin.so_luong_don_hang, pin.barcode AS barcode_phan_in, pin.dang_hoat_dong,
  mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang,
  (SELECT min(d.han_giao_hang) FROM dot_vai_ve d WHERE d.phan_in_id = pin.id AND d.trang_thai NOT IN ('DA_GOP','DA_HUY')) AS han_giao_hang,
  (SELECT sum(d.so_luong_vai_ve)::int FROM dot_vai_ve d WHERE d.phan_in_id = pin.id AND d.trang_thai NOT IN ('DA_GOP','DA_HUY')) AS so_luong_vai_ve,
  (SELECT string_agg(DISTINCT ldv.ten_loai, ', ') FROM dot_vai_ve d JOIN loai_dot_vai ldv ON ldv.id = d.loai_dot_vai_id
     WHERE d.phan_in_id = pin.id AND d.trang_thai NOT IN ('DA_GOP','DA_HUY')) AS loai_dot_vai,
  (SELECT h.phuong_an_in FROM hskt_phan_in hp JOIN ho_so_ky_thuat h ON h.id = hp.hskt_id
     WHERE hp.phan_in_id = pin.id AND hp.dang_hoat_dong AND h.dang_hoat_dong ORDER BY h.phien_ban DESC LIMIT 1) AS phuong_an_in`;

// Danh sách lượt trả về GN. trangThai: CHO (đang chờ GN sửa) | DA (đã xác nhận lại) | '' (tất cả).
// Khoảng ngày lọc theo NGÀY TRẢ VỀ (giờ VN), để trống = mọi ngày.
async function danhSach({ search = '', trangThai = 'CHO', tuNgay = null, denNgay = null }) {
  const sql = `
    SELECT q.id, q.ly_do, q.checklist_list, q.da_xu_ly, q.created_date AS tg_tra_ve,
           CASE WHEN q.da_xu_ly THEN q.updated_date END AS tg_xu_ly,
           nd.ho_ten AS nguoi_tra_ve, nd2.ho_ten AS nguoi_xu_ly,
           ${AUDIT_NGUON} AS nguon, ${AUDIT_GHI_CHU_XN} AS ghi_chu_xac_nhan, ${AUDIT_KIEU_XU_LY} AS kieu_xu_ly,
           ${COT_PIN}
    FROM qc_tra_ve q
    JOIN phan_in pin ON pin.id = q.phan_in_id
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    LEFT JOIN nguoi_dung nd ON nd.id = q.created_by
    LEFT JOIN nguoi_dung nd2 ON nd2.id = q.updated_by
    WHERE q.loai = '${LOAI_GN}'
      AND ($2 = '' OR ($2 = 'CHO' AND q.da_xu_ly = false) OR ($2 = 'DA' AND q.da_xu_ly = true))
      AND ($3::date IS NULL OR (q.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= $3::date)
      AND ($4::date IS NULL OR (q.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date <= $4::date)
      AND ($1 = '' OR pin.ma_phan ~* $1 OR kh.ten_khach_hang ~* $1 OR dh.ma_don_hang ~* $1
           OR mh.ma_hang ~* $1 OR pin.mau_vai ~* $1 OR pin.kich_vai ~* $1 OR pin.kich_phim ~* $1
           OR q.ly_do ~* $1)
    ORDER BY q.da_xu_ly, q.created_date DESC
    LIMIT 2000`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(),
    [mauTim(search), trangThai || '', tuNgay || null, denNgay || null]);
  return rows;
}

// Các lượt trả về GN ĐANG CHỜ của 1 phần in (mới nhất trước).
async function dangCho(phanInId) {
  const sql = `
    SELECT q.id, q.ly_do, q.checklist_list, q.created_date AS tg_tra_ve, nd.ho_ten AS nguoi_tra_ve,
           ${AUDIT_NGUON} AS nguon
    FROM qc_tra_ve q LEFT JOIN nguoi_dung nd ON nd.id = q.created_by
    WHERE q.loai = '${LOAI_GN}' AND q.phan_in_id = $1 AND q.da_xu_ly = false
    ORDER BY q.created_date DESC`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [phanInId]);
  return rows;
}

// Lịch sử trả về GN của 1 phần in (mọi lượt) — hiện trong SidePanel.
async function lichSu(phanInId) {
  const sql = `
    SELECT q.id, q.ly_do, q.checklist_list, q.da_xu_ly, q.created_date AS tg_tra_ve,
           CASE WHEN q.da_xu_ly THEN q.updated_date END AS tg_xu_ly,
           nd.ho_ten AS nguoi_tra_ve, nd2.ho_ten AS nguoi_xu_ly,
           ${AUDIT_NGUON} AS nguon, ${AUDIT_GHI_CHU_XN} AS ghi_chu_xac_nhan, ${AUDIT_KIEU_XU_LY} AS kieu_xu_ly
    FROM qc_tra_ve q
    LEFT JOIN nguoi_dung nd ON nd.id = q.created_by
    LEFT JOIN nguoi_dung nd2 ON nd2.id = q.updated_by
    WHERE q.loai = '${LOAI_GN}' AND q.phan_in_id = $1
    ORDER BY q.created_date DESC LIMIT 50`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [phanInId]);
  return rows;
}

async function getPhanInCoBan(phanInId) {
  const { rows } = await query('SELECT id, ma_phan, dang_hoat_dong FROM phan_in WHERE id = $1', [phanInId]);
  return rows[0] || null;
}

async function insertTraVe(client, { phanInId, checklistList, lyDo }, actorId) {
  const { rows } = await client.query(
    `INSERT INTO qc_tra_ve (loai, phan_in_id, checklist_list, ly_do, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, created_date`,
    [LOAI_GN, phanInId, checklistList || null, lyDo, actorId]
  );
  return rows[0];
}

// GN xác nhận lại: tắt MỌI cờ đang chờ của phần in (có thể bị trả về 2 lần liên tiếp từ KT và QC).
// ⚠ Ghi `updated_by` — `resolveReturns` dùng chung KHÔNG ghi người, mà trang này cần biết AI xác nhận lại.
async function xuLyHet(client, phanInId, actorId) {
  const { rows } = await client.query(
    `UPDATE qc_tra_ve SET da_xu_ly = true, updated_date = CURRENT_TIMESTAMP, updated_by = $2
      WHERE loai = $3 AND phan_in_id = $1 AND da_xu_ly = false RETURNING id`,
    [phanInId, actorId, LOAI_GN]
  );
  return rows.map((r) => r.id);
}

async function ghiAudit(client, id, hanhDong, moi, actorId) {
  await client.query(
    `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ('qc_tra_ve', $1, $2, $3::jsonb, $4, CURRENT_TIMESTAMP, $4)`,
    [String(id), hanhDong, JSON.stringify(moi || {}), actorId]
  );
}

// Đợt vải CÒN SỐNG của phần in, kèm cờ đã release (đợt đã có lệnh ≠ HUY thì không hủy được).
async function dotVaiSong(phanInId) {
  const { rows } = await query(
    `SELECT dv.id, dv.ma_dot_vai, EXISTS (SELECT 1 FROM lenh_sx_dot_vai lsd JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id WHERE lsd.dot_vai_ve_id = dv.id AND ls.trang_thai <> 'HUY') AS da_release FROM dot_vai_ve dv WHERE dv.phan_in_id = $1 AND dv.trang_thai NOT IN ('DA_GOP','DA_HUY') ORDER BY dv.created_date`,
    [phanInId]);
  return rows;
}

async function dotVaiThuocPhanIn(dotVaiId) {
  const { rows } = await query('SELECT phan_in_id FROM dot_vai_ve WHERE id = $1', [dotVaiId]);
  return rows[0]?.phan_in_id || null;
}

module.exports = { danhSach, dangCho, lichSu, getPhanInCoBan, insertTraVe, xuLyHet, ghiAudit, dotVaiThuocPhanIn, dotVaiSong };
