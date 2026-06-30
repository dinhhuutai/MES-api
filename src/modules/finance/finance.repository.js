'use strict';

const { query, withTransaction } = require('../../config/db');

// Gửi SQL 1 dòng (tránh IPS/WAF reset query đa dòng tới DB public — xem note ở orders.repository).
const oneLine = (s) => s.replace(/\s+/g, ' ').trim();

// Danh sách đơn hàng kèm trạng thái công nợ (1 query, tổng qua COUNT(*) OVER()).
async function listDonHang({ search = '', status = '', offset = 0, limit = 20 }) {
  const sql = oneLine(`
    SELECT dh.id AS don_hang_id, dh.ma_don_hang, dh.so_po, dh.ten_don_hang, dh.trang_thai AS trang_thai_don,
           kh.ma_khach_hang, kh.ten_khach_hang,
           count(DISTINCT pin.id)::int AS so_phan_in,
           COALESCE(SUM(pin.so_luong_don_hang), 0)::int AS tong_sl,
           cn.tong_tien, cn.da_thu, cn.ghi_chu,
           COALESCE(cn.trang_thai, 'CHUA') AS trang_thai_cong_no,
           cn.ngay_xac_nhan, nd.ho_ten AS nguoi_xac_nhan,
           COUNT(*) OVER()::int AS total_count
    FROM don_hang dh
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    LEFT JOIN ma_hang mh ON mh.don_hang_id = dh.id
    LEFT JOIN phan_in pin ON pin.ma_hang_id = mh.id
    LEFT JOIN cong_no cn ON cn.don_hang_id = dh.id
    LEFT JOIN nguoi_dung nd ON nd.id = cn.nguoi_xac_nhan_id
    WHERE ($1 = '' OR kh.ten_khach_hang ILIKE '%'||$1||'%' OR dh.ma_don_hang ILIKE '%'||$1||'%'
           OR dh.so_po ILIKE '%'||$1||'%' OR kh.ma_khach_hang ILIKE '%'||$1||'%' OR mh.ma_hang ILIKE '%'||$1||'%')
      AND ($2 = '' OR COALESCE(cn.trang_thai, 'CHUA') = $2)
    GROUP BY dh.id, kh.ma_khach_hang, kh.ten_khach_hang, cn.tong_tien, cn.da_thu, cn.ghi_chu,
             cn.trang_thai, cn.ngay_xac_nhan, nd.ho_ten
    ORDER BY (COALESCE(cn.trang_thai, 'CHUA') = 'CLOSED_FINANCE'), kh.ten_khach_hang, dh.ma_don_hang
    LIMIT $3 OFFSET $4`);
  const { rows } = await query(sql, [search, status, limit, offset]);
  return { rows, total: rows.length ? rows[0].total_count : 0 };
}

async function getCongNo(donHangId) {
  const sql = oneLine(`
    SELECT dh.id AS don_hang_id, dh.ma_don_hang, dh.so_po, dh.ten_don_hang, dh.trang_thai AS trang_thai_don,
           kh.ma_khach_hang, kh.ten_khach_hang,
           cn.tong_tien, cn.da_thu, cn.ghi_chu, COALESCE(cn.trang_thai, 'CHUA') AS trang_thai_cong_no,
           cn.ngay_xac_nhan, nd.ho_ten AS nguoi_xac_nhan
    FROM don_hang dh
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    LEFT JOIN cong_no cn ON cn.don_hang_id = dh.id
    LEFT JOIN nguoi_dung nd ON nd.id = cn.nguoi_xac_nhan_id
    WHERE dh.id = $1`);
  const { rows } = await query(sql, [donHangId]);
  return rows[0] || null;
}

async function upsertCongNo(donHangId, { tongTien, daThu, ghiChu }, actorId) {
  const sql = oneLine(`
    INSERT INTO cong_no (don_hang_id, tong_tien, da_thu, ghi_chu, created_by)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (don_hang_id) DO UPDATE SET
      tong_tien = EXCLUDED.tong_tien, da_thu = EXCLUDED.da_thu, ghi_chu = EXCLUDED.ghi_chu,
      updated_by = $5, updated_date = CURRENT_TIMESTAMP
    RETURNING id`);
  const { rows } = await query(sql, [donHangId, tongTien ?? null, daThu ?? 0, ghiChu ?? null, actorId]);
  return rows[0].id;
}

// Xác nhận đóng tài chính: cong_no + don_hang = CLOSED_FINANCE + ghi audit (1 transaction).
async function confirm(donHangId, actorId) {
  return withTransaction(async (client) => {
    await client.query(oneLine(`
      UPDATE cong_no SET trang_thai = 'CLOSED_FINANCE', ngay_xac_nhan = CURRENT_TIMESTAMP,
        nguoi_xac_nhan_id = $2, updated_by = $2, updated_date = CURRENT_TIMESTAMP
      WHERE don_hang_id = $1`), [donHangId, actorId]);
    await client.query(`UPDATE don_hang SET trang_thai = 'CLOSED_FINANCE', updated_by = $2, updated_date = CURRENT_TIMESTAMP WHERE id = $1`,
      [donHangId, actorId]);
    await client.query(oneLine(`
      INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
      VALUES ('don_hang', $1, 'CLOSED_FINANCE', '{}'::jsonb, $2, CURRENT_TIMESTAMP, $2)`), [String(donHangId), actorId]);
  });
}

async function historyByDate(date) {
  const sql = oneLine(`
    SELECT cn.ngay_xac_nhan AS tg, nd.ho_ten AS nguoi, dh.ma_don_hang, kh.ten_khach_hang,
           cn.tong_tien, cn.da_thu
    FROM cong_no cn
    JOIN don_hang dh ON dh.id = cn.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    LEFT JOIN nguoi_dung nd ON nd.id = cn.nguoi_xac_nhan_id
    WHERE cn.trang_thai = 'CLOSED_FINANCE'
      AND (cn.ngay_xac_nhan AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $1::date
    ORDER BY cn.ngay_xac_nhan DESC`);
  const { rows } = await query(sql, [date]);
  return rows;
}

module.exports = { listDonHang, getCongNo, upsertCongNo, confirm, historyByDate };
