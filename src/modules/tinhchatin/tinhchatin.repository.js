'use strict';

const { query } = require('../../config/db');
const { MA_TCIN_SQL } = require('../../utils/tinhChatIn');

// Áp luồng sản xuất mới cho phần in mang tính chất `ma` (mig 126) — bỏ qua phần in đã sửa tay hoặc đã có lệnh sống
//   (đã chạy theo luồng cũ; đổi thì dùng Quản trị phần in). Trả số phần in đổi.
async function apLuongChoPhanInTx(client, ma, luong) {
  const { rowCount } = await client.query(
    `UPDATE phan_in pin SET luong_sx = $2::varchar, la_in_kieng = ($2::varchar = 'IN_KIENG'), luong_sx_tg = CURRENT_TIMESTAMP
      WHERE ${MA_TCIN_SQL('pin.tinh_chat_in')} = $1 AND NOT pin.luong_sx_sua_tay
        AND pin.luong_sx IS DISTINCT FROM $2::varchar
        AND NOT EXISTS (SELECT 1 FROM dot_vai_ve dv JOIN lenh_sx_dot_vai lsd ON lsd.dot_vai_ve_id = dv.id
                          JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id
                         WHERE dv.phan_in_id = pin.id AND ls.trang_thai <> 'HUY')`.replace(/\s+/g, ' '),
    [ma, luong]
  );
  return rowCount;
}

async function coBang() {
  const { rows } = await query("SELECT to_regclass('public.tinh_chat_in') AS bang");
  return !!rows[0].bang;
}

// Danh mục đang dùng + người / giờ sửa gần nhất.
async function danhMuc() {
  const { rows } = await query(
    `SELECT t.id, t.ma_chuan, t.ten, t.luong, t.bo_qua, t.ghi_chu, t.updated_date, nd.ho_ten AS nguoi_sua
       FROM tinh_chat_in t LEFT JOIN nguoi_dung nd ON nd.id = t.updated_by
      WHERE t.dang_hoat_dong`.replace(/\s+/g, ' ')
  );
  return rows;
}

// Số phần in còn sống theo tính chất (kèm tên để nhận ra tính chất chưa có trong danh mục).
async function demPhanIn() {
  const { rows } = await query(
    `SELECT ${MA_TCIN_SQL('pi.tinh_chat_in')} AS ma, min(btrim(pi.tinh_chat_in)) AS ten, count(*)::int AS so_phan_in
       FROM phan_in pi
      WHERE pi.dang_hoat_dong AND btrim(COALESCE(pi.tinh_chat_in, '')) <> ''
      GROUP BY 1`.replace(/\s+/g, ' ')
  );
  return rows;
}

// Số đợt ERP gửi trong dữ liệu thô còn giữ (job dọn xóa sau khoảng 10 ngày) — gồm cả dòng đang bị bỏ qua.
async function demDotErp() {
  const cot = "COALESCE(r.payload->>'tinhchatin', r.payload->>'Tinhchatin')";
  const { rows } = await query(
    `SELECT ${MA_TCIN_SQL(cot)} AS ma, min(btrim(${cot})) AS ten, count(*)::int AS so_dot
       FROM erp_phieu_nhan_vai_raw r
      WHERE r.payload IS NOT NULL AND btrim(COALESCE(${cot}, '')) <> ''
      GROUP BY 1`.replace(/\s+/g, ' ')
  );
  return rows;
}

// Số phần in còn sống của 1 tính chất (chặn xóa khỏi danh mục).
async function demPhanInCua(client, ma) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM phan_in pi WHERE pi.dang_hoat_dong AND ${MA_TCIN_SQL('pi.tinh_chat_in')} = $1`, [ma]
  );
  return rows[0].n;
}

// Đọc + khóa các dòng (kể cả dòng đã ẩn — thêm lại thì bật lại, không đẻ dòng trùng).
async function docTheoMaTx(client, dsMa) {
  const { rows } = await client.query(
    `SELECT id, ma_chuan, ten, luong, bo_qua, ghi_chu, dang_hoat_dong FROM tinh_chat_in WHERE ma_chuan = ANY($1::text[]) FOR UPDATE`, [dsMa]
  );
  return rows;
}

async function docTheoIdTx(client, id) {
  const { rows } = await client.query(
    'SELECT id, ma_chuan, ten, luong, bo_qua, ghi_chu, dang_hoat_dong FROM tinh_chat_in WHERE id = $1 FOR UPDATE', [id]
  );
  return rows[0] || null;
}

async function themTx(client, d, actorId) {
  const { rows } = await client.query(
    `INSERT INTO tinh_chat_in (ma_chuan, ten, luong, bo_qua, ghi_chu, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id`.replace(/\s+/g, ' '),
    [d.ma_chuan, d.ten, d.luong, d.bo_qua, d.ghi_chu, actorId || null]
  );
  return rows[0].id;
}

async function suaTx(client, id, d, actorId) {
  await client.query(
    `UPDATE tinh_chat_in SET luong = $2, bo_qua = $3, ghi_chu = $4, dang_hoat_dong = true,
            updated_by = $5, updated_date = CURRENT_TIMESTAMP WHERE id = $1`.replace(/\s+/g, ' '),
    [id, d.luong, d.bo_qua, d.ghi_chu, actorId || null]
  );
}

async function anTx(client, id, actorId) {
  await client.query(
    'UPDATE tinh_chat_in SET dang_hoat_dong = false, updated_by = $2, updated_date = CURRENT_TIMESTAMP WHERE id = $1',
    [id, actorId || null]
  );
}

async function logTx(client, id, hanhDong, cu, moi, actorId) {
  await client.query(
    `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_cu, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ('tinh_chat_in', $1, $2, $3::jsonb, $4::jsonb, $5, clock_timestamp(), $5)`.replace(/\s+/g, ' '),
    [String(id), hanhDong, cu ? JSON.stringify(cu) : null, moi ? JSON.stringify(moi) : null, actorId || null]
  );
}

module.exports = { coBang, danhMuc, demPhanIn, demDotErp, demPhanInCua, docTheoMaTx, docTheoIdTx, themTx, suaTx, anTx, logTx, apLuongChoPhanInTx };
