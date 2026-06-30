'use strict';

const { query } = require('../../config/db');

// ----- Log đồng bộ -----
async function createSyncLog({ nguon, fromDate, tuDong }, actorId) {
  const { rows } = await query(
    `INSERT INTO erp_sync_log (nguon, from_date, tu_dong, trang_thai, created_by)
     VALUES ($1,$2,$3,'DANG_CHAY',$4) RETURNING id`,
    [nguon, fromDate || null, !!tuDong, actorId || null]
  );
  return rows[0].id;
}

async function finishSyncLog(id, { tong, soMoi, soCapNhat, soLoi, trangThai, thongDiep }) {
  await query(
    `UPDATE erp_sync_log SET tg_kt=CURRENT_TIMESTAMP, tong_ban_ghi=$2, so_moi=$3, so_cap_nhat=$4,
       so_loi=$5, trang_thai=$6, thong_diep=$7 WHERE id=$1`,
    [id, tong ?? 0, soMoi ?? 0, soCapNhat ?? 0, soLoi ?? 0, trangThai, thongDiep || null]
  );
}

async function listSyncHistory(limit = 50) {
  const { rows } = await query(
    `SELECT l.id, l.nguon, l.from_date, l.tg_bd, l.tg_kt, l.tong_ban_ghi, l.so_moi, l.so_cap_nhat,
            l.so_loi, l.trang_thai, l.tu_dong, l.thong_diep, nd.ho_ten AS nguoi
     FROM erp_sync_log l LEFT JOIN nguoi_dung nd ON nd.id = l.created_by
     ORDER BY l.tg_bd DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

// ----- Upsert cây dữ liệu (idempotent theo mã) -----
async function upsertKhachHang(client, { ma, ten }) {
  const { rows } = await client.query(
    `INSERT INTO khach_hang (ma_khach_hang, ten_khach_hang) VALUES ($1,$2)
     ON CONFLICT (ma_khach_hang) DO UPDATE SET ten_khach_hang = EXCLUDED.ten_khach_hang
     RETURNING id`,
    [ma, ten || ma]
  );
  return rows[0].id;
}

async function upsertDonHang(client, { maDon, khachHangId }) {
  const { rows } = await client.query(
    `INSERT INTO don_hang (khach_hang_id, ma_don_hang) VALUES ($1,$2)
     ON CONFLICT (ma_don_hang) DO UPDATE SET khach_hang_id = EXCLUDED.khach_hang_id
     RETURNING id`,
    [khachHangId, maDon]
  );
  return rows[0].id;
}

async function upsertMaHang(client, { donHangId, maHang, tenMaHang }) {
  const { rows } = await client.query(
    `INSERT INTO ma_hang (don_hang_id, ma_hang, ten_ma_hang) VALUES ($1,$2,$3)
     ON CONFLICT (don_hang_id, ma_hang) DO UPDATE SET ten_ma_hang = COALESCE(EXCLUDED.ten_ma_hang, ma_hang.ten_ma_hang)
     RETURNING id`,
    [donHangId, maHang, tenMaHang || null]
  );
  return rows[0].id;
}

async function upsertPhanIn(client, { maHangId, maPhan, mauVai, kichVai, kichPhim, soLuongDonHang }) {
  const { rows } = await client.query(
    `INSERT INTO phan_in (ma_hang_id, ma_phan, mau_vai, kich_vai, kich_phim, so_luong_don_hang)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (ma_phan) DO UPDATE SET
       mau_vai = EXCLUDED.mau_vai, kich_vai = EXCLUDED.kich_vai, kich_phim = EXCLUDED.kich_phim,
       so_luong_don_hang = EXCLUDED.so_luong_don_hang, updated_date = CURRENT_TIMESTAMP
     RETURNING id`,
    [maHangId, maPhan, mauVai || null, kichVai || null, kichPhim || null, soLuongDonHang ?? null]
  );
  return rows[0].id;
}

// Trả về { id, inserted } — inserted=true nếu là đợt vải mới (xmax=0).
async function upsertDotVai(client, { maDotVai, phanInId, ngayVaiVe, hanGiao, soLuong }) {
  const { rows } = await client.query(
    `INSERT INTO dot_vai_ve (phan_in_id, ma_dot_vai, ngay_vai_ve, han_giao_hang, so_luong_vai_ve, trang_thai)
     VALUES ($1,$2,$3,$4,$5,'NHAN_VAI')
     ON CONFLICT (ma_dot_vai) DO UPDATE SET
       ngay_vai_ve = EXCLUDED.ngay_vai_ve, han_giao_hang = EXCLUDED.han_giao_hang,
       so_luong_vai_ve = EXCLUDED.so_luong_vai_ve, updated_date = CURRENT_TIMESTAMP
     RETURNING id, (xmax = 0) AS inserted`,
    [phanInId, maDotVai, ngayVaiVe || null, hanGiao || null, soLuong ?? null]
  );
  return { id: rows[0].id, inserted: rows[0].inserted };
}

module.exports = {
  createSyncLog, finishSyncLog, listSyncHistory,
  upsertKhachHang, upsertDonHang, upsertMaHang, upsertPhanIn, upsertDotVai,
};
