'use strict';

const { query } = require('../../config/db');

// DANH MỤC KIẾNG (mig 126) — chọn khi in tem công đoạn IN của phần in kiếng.
async function danhSach({ ca = false } = {}) {
  const { rows } = await query(
    `SELECT k.id, k.ma_hang_hoa, k.ten, k.dvt, k.ghi_chu, k.dang_hoat_dong, k.updated_date, nd.ho_ten AS nguoi_sua,
            (SELECT count(*) FROM tem t WHERE t.loai_kieng_id = k.id)::int AS so_tem
       FROM loai_kieng k LEFT JOIN nguoi_dung nd ON nd.id = k.updated_by
      ${ca ? '' : 'WHERE k.dang_hoat_dong'}
      ORDER BY k.dang_hoat_dong DESC, k.ma_hang_hoa`.replace(/\s+/g, ' ')
  );
  return rows;
}

async function theoId(id) {
  const { rows } = await query('SELECT id, ma_hang_hoa, ten, dvt, dang_hoat_dong FROM loai_kieng WHERE id = $1', [id]);
  return rows[0] || null;
}

async function theoMa(ma) {
  const { rows } = await query('SELECT id, ma_hang_hoa, ten, dvt, dang_hoat_dong FROM loai_kieng WHERE ma_hang_hoa = $1', [ma]);
  return rows[0] || null;
}

async function them(d, actorId) {
  const { rows } = await query(
    `INSERT INTO loai_kieng (ma_hang_hoa, ten, dvt, ghi_chu, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$5) RETURNING id`,
    [d.ma_hang_hoa, d.ten, d.dvt, d.ghi_chu, actorId]
  );
  return rows[0].id;
}

async function sua(id, d, actorId) {
  await query(
    `UPDATE loai_kieng SET ma_hang_hoa=$2, ten=$3, dvt=$4, ghi_chu=$5, dang_hoat_dong=$6,
            updated_by=$7, updated_date=CURRENT_TIMESTAMP WHERE id=$1`.replace(/\s+/g, ' '),
    [id, d.ma_hang_hoa, d.ten, d.dvt, d.ghi_chu, d.dang_hoat_dong, actorId]
  );
}

async function ghiVet(id, hanhDong, cu, moi, actorId) {
  await query(
    `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_cu, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ('loai_kieng', $1, $2, $3::jsonb, $4::jsonb, $5, CURRENT_TIMESTAMP, $5)`,
    [String(id), hanhDong, cu ? JSON.stringify(cu) : null, moi ? JSON.stringify(moi) : null, actorId]
  );
}

// Loại kiếng + hệ số của tem in kiếng GẦN NHẤT của lệnh — điền sẵn ô ở sidebar (nhớ theo lệnh, như Ngày ca).
async function ganNhatCuaLenh(lenhId) {
  const { rows } = await query(
    `SELECT t.loai_kieng_id, t.he_so_kieng::float AS he_so_kieng
       FROM tem t JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
      WHERE ps.lenh_san_xuat_id = $1 AND t.loai_kieng_id IS NOT NULL AND t.trang_thai <> 'HUY'
      ORDER BY t.created_date DESC LIMIT 1`.replace(/\s+/g, ' '),
    [lenhId]
  );
  return rows[0] || null;
}

module.exports = { danhSach, theoId, theoMa, them, sua, ghiVet, ganNhatCuaLenh };
