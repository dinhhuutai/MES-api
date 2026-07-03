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

// Điều kiện lọc theo GIAI ĐOẠN của phần in (derive từ trạng thái runtime — không phụ thuộc ton_tram/029).
// GIAI ĐOẠN khớp với MÀN HÌNH: phần in ĐÃ RELEASE (có lệnh ≠ HUY, trạng thái RELEASE_1) → Test Run;
// QC xong nhưng CHƯA release → Release 1; chưa QC → READY. Lệnh 'HUY' (đã hủy chuyển trạm) coi như chưa release.
// Một phần in có thể ở nhiều giai đoạn (nhiều đợt vải/tem rải rác).
function stageCondition(stage) {
  const LJ = "SELECT 1 FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve d ON d.id=lsd.dot_vai_ve_id AND d.phan_in_id=pin.id JOIN lenh_san_xuat ls ON ls.id=lsd.lenh_san_xuat_id";
  const anyLenh = `EXISTS (${LJ} WHERE ls.trang_thai <> 'HUY')`;
  const lenhStatus = (st) => `EXISTS (${LJ} WHERE ls.trang_thai='${st}')`;
  const tem = (list) => `EXISTS (${LJ} JOIN phieu_san_xuat ps ON ps.lenh_san_xuat_id=ls.id JOIN tem t ON t.phieu_san_xuat_id=ps.id WHERE ls.trang_thai <> 'HUY' AND t.trang_thai <> 'HUY' AND t.trang_thai IN (${list.map((s) => `'${s}'`).join(',')}))`;
  const phieuChay = `EXISTS (${LJ} JOIN phieu_san_xuat ps ON ps.lenh_san_xuat_id=ls.id WHERE ls.trang_thai <> 'HUY' AND ps.trang_thai='DANG_CHAY')`;
  const qcDone = "EXISTS (SELECT 1 FROM ket_qua_checkpoint kq JOIN checkpoint c ON c.id=kq.checkpoint_id WHERE kq.phan_in_id=pin.id AND c.ma_checkpoint='QC_XAC_NHAN' AND kq.trang_thai='DAT')";
  const techAny = "EXISTS (SELECT 1 FROM ket_qua_checkpoint kq JOIN checkpoint c ON c.id=kq.checkpoint_id WHERE kq.phan_in_id=pin.id AND c.ma_checkpoint IN ('KHUON','FILM','MUC','HSKT','QC_XAC_NHAN') AND kq.trang_thai='DAT')";
  switch (stage) {
    case 'ERP': return `NOT ${anyLenh} AND NOT ${techAny}`;
    case 'READY': return `NOT ${anyLenh} AND ${techAny} AND NOT ${qcDone}`;
    case 'RELEASE_1': return `NOT ${anyLenh} AND ${qcDone}`;
    case 'TEST_RUN': return lenhStatus('RELEASE_1');
    case 'RELEASE_2': return lenhStatus('RELEASE_2');
    case 'SAN_XUAT': return phieuChay;
    case 'CHO_KHO': return tem(['IN', 'DANG_PHOI']);
    case 'KCS': return tem(['DA_KHO']);
    case 'SUA': return tem(['CHO_SUA']);
    case 'OQC': return tem(['CHO_OQC']);
    case 'GIAO': return tem(['OQC_DAT']);
    case 'DA_GIAO': return tem(['DA_GIAO']);
    default: return null;
  }
}

// Danh sách "phần in vải về": GỘP theo phần in (mỗi dòng = 1 phần in), kèm mảng đợt vải về.
// Hỗ trợ: tìm nhanh (search), lọc nhiều trường cùng lúc (filters, AND), lọc theo giai đoạn (stage).
async function listVaiVe({ search = '', filters = {}, stage = '', offset = 0, limit = 20 }) {
  const params = [];
  const add = (v) => { params.push(v); return `$${params.length}`; };
  const cond = [];

  if (search) {
    const p = add(search);
    cond.push(`(pin.ma_phan ILIKE '%'||${p}||'%' OR kh.ten_khach_hang ILIKE '%'||${p}||'%'
      OR dh.ma_don_hang ILIKE '%'||${p}||'%' OR mh.ma_hang ILIKE '%'||${p}||'%'
      OR pin.mau_vai ILIKE '%'||${p}||'%' OR pin.kich_vai ILIKE '%'||${p}||'%' OR pin.kich_phim ILIKE '%'||${p}||'%'
      OR EXISTS (SELECT 1 FROM dot_vai_ve dvs WHERE dvs.phan_in_id=pin.id AND dvs.ma_dot_vai ILIKE '%'||${p}||'%'))`);
  }
  // Lọc từng trường (AND với nhau).
  const FIELD = { khach: 'kh.ten_khach_hang', don: 'dh.ma_don_hang', maHang: 'mh.ma_hang',
    codePhan: 'pin.ma_phan', mauVai: 'pin.mau_vai', kichVai: 'pin.kich_vai', kichPhim: 'pin.kich_phim' };
  for (const [k, col] of Object.entries(FIELD)) {
    if (filters[k]) { const p = add(filters[k]); cond.push(`${col} ILIKE '%'||${p}||'%'`); }
  }
  // Lọc theo NGÀY VẢI VỀ (khoảng): phần in có ≥1 đợt vải với ngay_vai_ve trong khoảng.
  if (filters.ngayVaiTu || filters.ngayVaiDen) {
    const parts = ['dvd.phan_in_id = pin.id'];
    if (filters.ngayVaiTu) parts.push(`dvd.ngay_vai_ve >= ${add(filters.ngayVaiTu)}::date`);
    if (filters.ngayVaiDen) parts.push(`dvd.ngay_vai_ve <= ${add(filters.ngayVaiDen)}::date`);
    cond.push(`EXISTS (SELECT 1 FROM dot_vai_ve dvd WHERE ${parts.join(' AND ')})`);
  }
  const sc = stageCondition(stage);
  if (sc) cond.push(`(${sc})`);
  cond.push("dh.trang_thai IS DISTINCT FROM 'CLOSED_FINANCE'");

  const limitP = add(limit); const offsetP = add(offset);
  // 1 query duy nhất: tổng số phần in qua COUNT(*) OVER(). Gửi SQL 1 dòng (IPS-safe).
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
    WHERE ${cond.join(' AND ')}
    GROUP BY pin.id, mh.ma_hang, mh.ten_ma_hang, dh.ma_don_hang, dh.so_po, kh.ma_khach_hang, kh.ten_khach_hang
    ORDER BY kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang, pin.ma_phan
    LIMIT ${limitP} OFFSET ${offsetP}`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), params);
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
