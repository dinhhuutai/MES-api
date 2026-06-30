'use strict';

const { query } = require('../../config/db');

const BASE_JOINS = `
  FROM phan_in pin
  JOIN ma_hang mh ON mh.id = pin.ma_hang_id
  JOIN don_hang dh ON dh.id = mh.don_hang_id
  JOIN khach_hang kh ON kh.id = dh.khach_hang_id`;

function buildWhere(search, missingProfit) {
  let cond = `($1 = '' OR pin.ma_phan ILIKE '%'||$1||'%' OR kh.ten_khach_hang ILIKE '%'||$1||'%'
              OR dh.ma_don_hang ILIKE '%'||$1||'%' OR mh.ma_hang ILIKE '%'||$1||'%'
              OR pin.mau_vai ILIKE '%'||$1||'%' OR pin.kich_vai ILIKE '%'||$1||'%'
              OR pin.kich_phim ILIKE '%'||$1||'%')`;
  if (missingProfit) cond += ' AND pin.loi_nhuan IS NULL';
  return cond;
}

async function list({ search = '', missingProfit = false, offset = 0, limit = 20 }) {
  const where = buildWhere(search, missingProfit);
  const dataSql = `
    SELECT pin.id, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim,
           pin.tinh_chat_in, pin.do_in, pin.mau_in, pin.so_luong_don_hang, pin.loi_nhuan,
           mh.ma_hang, mh.ten_ma_hang,
           dh.ma_don_hang, dh.so_po,
           kh.ma_khach_hang, kh.ten_khach_hang,
           COALESCE(SUM(dv.so_luong_vai_ve), 0)::int AS tong_vai_ve,
           MIN(dv.han_giao_hang) AS han_giao_hang,
           MAX(dv.ngay_vai_ve) AS ngay_vai_ve,
           COUNT(dv.id)::int AS so_dot_vai
    ${BASE_JOINS}
    LEFT JOIN dot_vai_ve dv ON dv.phan_in_id = pin.id
    WHERE ${where}
    GROUP BY pin.id, mh.ma_hang, mh.ten_ma_hang, dh.ma_don_hang, dh.so_po, kh.ma_khach_hang, kh.ten_khach_hang
    ORDER BY pin.created_date DESC
    LIMIT $2 OFFSET $3`;
  const countSql = `SELECT count(*)::int AS total ${BASE_JOINS} WHERE ${where}`;

  const [data, count] = await Promise.all([
    query(dataSql, [search, limit, offset]),
    query(countSql, [search]),
  ]);
  return { rows: data.rows, total: count.rows[0].total };
}

// Danh sách "phần in vải về": GỘP theo phần in (mỗi dòng = 1 phần in), kèm mảng đợt vải về.
// Phần in có nhiều đợt → rowspan ở FE để dễ nhận biết. Phần in chưa có đợt vẫn hiển thị (dot_vai=[]).
// TODO(công nợ): khi có trạng thái "đã làm công nợ xong" trên đợt vải, thêm điều kiện loại đợt đó
//   ở LEFT JOIN (vd: AND dv.trang_thai <> 'CONG_NO_XONG'). Hiện hệ thống chưa lưu trạng thái này.
async function listVaiVe({ search = '', offset = 0, limit = 20 }) {
  const where = `($1 = '' OR pin.ma_phan ILIKE '%'||$1||'%' OR kh.ten_khach_hang ILIKE '%'||$1||'%'
              OR dh.ma_don_hang ILIKE '%'||$1||'%' OR mh.ma_hang ILIKE '%'||$1||'%'
              OR pin.mau_vai ILIKE '%'||$1||'%' OR pin.kich_vai ILIKE '%'||$1||'%'
              OR pin.kich_phim ILIKE '%'||$1||'%' OR dv.ma_dot_vai ILIKE '%'||$1||'%')`;
  // 1 query duy nhất: tổng số phần in qua COUNT(*) OVER() (tránh chạy song song 2 query nặng
  // làm rớt kết nối DB). Window count = số nhóm (phần in) trước LIMIT.
  const sql = `
    SELECT pin.id AS phan_in_id, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim,
           pin.so_luong_don_hang, pin.loi_nhuan,
           mh.ma_hang, mh.ten_ma_hang, dh.ma_don_hang, dh.so_po,
           kh.ma_khach_hang, kh.ten_khach_hang,
           count(dv.id)::int AS so_dot,
           COALESCE(json_agg(json_build_object(
             'dot_vai_id', dv.id, 'ma_dot_vai', dv.ma_dot_vai, 'so_luong_vai_ve', dv.so_luong_vai_ve,
             'ngay_vai_ve', dv.ngay_vai_ve, 'han_giao_hang', dv.han_giao_hang
           ) ORDER BY dv.ngay_vai_ve NULLS LAST, dv.ma_dot_vai)
           FILTER (WHERE dv.id IS NOT NULL), '[]') AS dot_vai,
           COUNT(*) OVER()::int AS total_count
    ${BASE_JOINS}
    LEFT JOIN dot_vai_ve dv ON dv.phan_in_id = pin.id
    WHERE ${where}
      AND dh.trang_thai IS DISTINCT FROM 'CLOSED_FINANCE'
    GROUP BY pin.id, mh.ma_hang, mh.ten_ma_hang, dh.ma_don_hang, dh.so_po, kh.ma_khach_hang, kh.ten_khach_hang
    ORDER BY kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang, pin.ma_phan
    LIMIT $2 OFFSET $3`;
  // Gửi SQL trên 1 dòng (thu gọn whitespace): tránh thiết bị IPS/WAF trên đường tới DB public
  // reset kết nối khi gặp pattern WHERE/json nhiều dòng ("Connection terminated unexpectedly").
  // An toàn vì query này không có literal chứa khoảng trắng có nghĩa.
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [search, limit, offset]);
  const total = rows.length ? rows[0].total_count : 0;
  return { rows, total };
}

async function findById(id) {
  const sql = `
    SELECT pin.id, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.tinh_chat_in,
           pin.do_in, pin.mau_in, pin.so_luong_don_hang, pin.loi_nhuan, pin.ghi_chu,
           mh.ma_hang, mh.ten_ma_hang,
           dh.ma_don_hang, dh.so_po, dh.ten_don_hang,
           kh.ma_khach_hang, kh.ten_khach_hang
    ${BASE_JOINS}
    WHERE pin.id = $1`;
  const { rows } = await query(sql, [id]);
  return rows[0] || null;
}

async function listDotVai(phanInId) {
  const sql = `
    SELECT dv.id, dv.ma_dot_vai, dv.ngay_vai_ve, dv.han_giao_hang, dv.so_luong_vai_ve,
           dv.so_luong_thieu, dv.so_luong_hu, dv.trang_thai, ldv.ten_loai AS loai_dot_vai
    FROM dot_vai_ve dv
    LEFT JOIN loai_dot_vai ldv ON ldv.id = dv.loai_dot_vai_id
    WHERE dv.phan_in_id = $1
    ORDER BY dv.ngay_vai_ve NULLS LAST, dv.ma_dot_vai`;
  const { rows } = await query(sql, [phanInId]);
  return rows;
}

async function setLoiNhuan(id, loiNhuan, actorId) {
  const { rowCount } = await query(
    'UPDATE phan_in SET loi_nhuan = $2, updated_by = $3, updated_date = CURRENT_TIMESTAMP WHERE id = $1',
    [id, loiNhuan, actorId]
  );
  return rowCount > 0;
}

// Ghi lịch sử đặt lợi nhuận vào audit_log (forward-only).
async function logProfitChange(id, oldVal, newVal, actorId) {
  await query(
    `INSERT INTO audit_log
       (ten_bang, id_ban_ghi, hanh_dong, gia_tri_cu, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ('phan_in', $1, 'SET_LOI_NHUAN', $2::jsonb, $3::jsonb, $4, CURRENT_TIMESTAMP, $4)`,
    [String(id), JSON.stringify({ loi_nhuan: oldVal ?? null }), JSON.stringify({ loi_nhuan: newVal ?? null }), actorId]
  );
}

async function profitHistoryByDate(date) {
  const { rows } = await query(
    `SELECT a.thoi_gian AS tg, nd.ho_ten AS nguoi, pin.ma_phan, mh.ma_hang,
            a.gia_tri_cu->>'loi_nhuan' AS cu, a.gia_tri_moi->>'loi_nhuan' AS moi
     FROM audit_log a
     JOIN phan_in pin ON pin.id = a.id_ban_ghi::uuid
     JOIN ma_hang mh ON mh.id = pin.ma_hang_id
     LEFT JOIN nguoi_dung nd ON nd.id = a.nguoi_thuc_hien_id
     WHERE a.ten_bang = 'phan_in' AND a.hanh_dong = 'SET_LOI_NHUAN'
       AND (a.thoi_gian AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $1::date
     ORDER BY a.thoi_gian DESC`,
    [date]
  );
  return rows;
}

module.exports = { list, listVaiVe, findById, listDotVai, setLoiNhuan, logProfitChange, profitHistoryByDate };
