'use strict';

const { query } = require('../../config/db');

// Ghi 1 lần điều hướng trang.
async function insertNav({ userId, duongDan, tieuDe, ip }) {
  await query(
    `INSERT INTO nhat_ky_dieu_huong (nguoi_dung_id, duong_dan, tieu_de, dia_chi_ip)
     VALUES ($1,$2,$3,$4)`,
    [userId, (duongDan || '').slice(0, 255), tieuDe ? tieuDe.slice(0, 255) : null, ip ? ip.slice(0, 64) : null]
  );
}

// Lịch sử điều hướng theo ngày (giờ VN). userId tùy chọn.
async function listHistory({ date, userId, limit = 500 }) {
  const params = [];
  const where = [];
  if (date) {
    params.push(date);
    where.push(`(h.thoi_gian AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $${params.length}`);
  }
  if (userId) {
    params.push(userId);
    where.push(`h.nguoi_dung_id = $${params.length}`);
  }
  params.push(limit);
  const { rows } = await query(
    `SELECT h.id, h.duong_dan, h.tieu_de, h.dia_chi_ip, h.thoi_gian,
            h.nguoi_dung_id, nd.ho_ten AS nguoi, nd.ten_dang_nhap AS username
     FROM nhat_ky_dieu_huong h
     JOIN nguoi_dung nd ON nd.id = h.nguoi_dung_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY h.thoi_gian DESC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

// ---- NHẬT KÝ THAO TÁC TOÀN HỆ THỐNG (gộp điều hướng + audit + xác nhận nghiệp vụ) ----
// Mỗi nguồn trả cùng 6 cột: tg, nguoi_id, loai, doi_tuong, hanh_dong, chi_tiet. KHÔNG dùng comment '--' (query gộp 1 dòng, IPS-safe).
const ACTIVITY_UNION = `
  SELECT h.thoi_gian AS tg, h.nguoi_dung_id AS nguoi_id, 'Điều hướng' AS loai,
         COALESCE(h.tieu_de, h.duong_dan) AS doi_tuong, 'Mở trang' AS hanh_dong, h.duong_dan AS chi_tiet
  FROM nhat_ky_dieu_huong h
  UNION ALL
  SELECT a.thoi_gian, COALESCE(a.nguoi_thuc_hien_id, a.created_by), 'Thao tác',
         a.ten_bang || COALESCE(' #' || a.id_ban_ghi, ''), a.hanh_dong, left(COALESCE(a.gia_tri_moi::text, ''), 400)
  FROM audit_log a
  UNION ALL
  SELECT COALESCE(k.tg_xac_nhan, k.created_date), COALESCE(k.nguoi_xac_nhan_id, k.created_by), 'Xác nhận',
         cp.ten_checkpoint || COALESCE(' · ' || pi.ma_phan, ' · ' || l.ma_lenh_san_xuat, ''),
         'Xác nhận checklist ' || COALESCE(k.trang_thai, ''), COALESCE(k.gia_tri_text, '')
  FROM ket_qua_checkpoint k JOIN checkpoint cp ON cp.id = k.checkpoint_id
  LEFT JOIN phan_in pi ON pi.id = k.phan_in_id LEFT JOIN lenh_san_xuat l ON l.id = k.lenh_san_xuat_id
  UNION ALL
  SELECT ls.created_date, ls.created_by, 'Release', 'Lệnh ' || ls.ma_lenh_san_xuat,
         'Release ' || ls.trang_thai, 'SL release ' || COALESCE(ls.so_luong_release, 0)
  FROM lenh_san_xuat ls WHERE ls.trang_thai <> 'HUY'
  UNION ALL
  SELECT ps.created_date, ps.created_by, 'Bắt đầu SX', 'Phiếu ' || ps.ma_phieu_san_xuat, 'Xác nhận chạy', ''
  FROM phieu_san_xuat ps
  UNION ALL
  SELECT lt.created_date, lt.created_by, 'In tem', 'Tem ' || t.ma_tem,
         'In tem' || CASE WHEN lt.so_lan_in > 1 THEN ' (lần ' || lt.so_lan_in || ')' ELSE '' END, COALESCE(lt.ly_do_in_lai, '')
  FROM log_tem lt JOIN tem t ON t.id = lt.tem_id
  UNION ALL
  SELECT k.created_date, k.created_by, 'KCS', 'Tem ' || t.ma_tem, 'Kiểm KCS',
         'Đạt ' || COALESCE(k.so_luong_dat, 0) || ' · Hư ' || COALESCE(k.so_luong_loi, 0) || ' · Hủy ' || COALESCE(k.so_luong_huy, 0)
  FROM kcs k JOIN tem t ON t.id = k.tem_id
  UNION ALL
  SELECT s.created_date, s.created_by, 'Sửa', 'Tem ' || t.ma_tem, 'Xác nhận sửa',
         'Sửa đạt ' || COALESCE(s.so_luong_sua_dat, 0) || ' · Hủy ' || COALESCE(s.so_luong_sua_huy, 0)
  FROM sua s JOIN tem t ON t.id = s.tem_id
  UNION ALL
  SELECT o.created_date, o.created_by, 'OQC', 'Tem ' || t.ma_tem, 'OQC ' || COALESCE(o.ket_qua, ''),
         'Bốc mẫu ' || COALESCE(o.so_luong_kiem, 0) || ' · Đạt ' || COALESCE(o.so_luong_dat, 0)
  FROM oqc o JOIN tem t ON t.id = o.tem_id
  UNION ALL
  SELECT q.created_date, q.created_by, 'QC in-line', 'Phiếu ' || ps.ma_phieu_san_xuat, 'QC in-line ' || COALESCE(q.ket_qua, ''), ''
  FROM qc_in_line q JOIN phieu_san_xuat ps ON ps.id = q.phieu_san_xuat_id
  UNION ALL
  SELECT COALESCE(gh.ngay_giao::timestamptz, gh.created_date), gh.created_by, 'Giao', 'Phiếu giao ' || gh.ma_phieu_giao,
         'Xác nhận giao', '' FROM giao_hang gh WHERE gh.trang_thai = 'DA_GIAO'`;

async function listActivity({ date, userId, loai, search, limit = 50, offset = 0 }) {
  const params = [];
  const conds = [];
  if (date) { params.push(date); conds.push(`(e.tg AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $${params.length}::date`); }
  if (userId) { params.push(userId); conds.push(`e.nguoi_id = $${params.length}`); }
  if (loai) { params.push(loai); conds.push(`e.loai = $${params.length}`); }
  if (search) {
    params.push(search); const i = params.length;
    conds.push(`(e.doi_tuong ILIKE '%'||$${i}||'%' OR e.hanh_dong ILIKE '%'||$${i}||'%' OR e.chi_tiet ILIKE '%'||$${i}||'%' OR nd.ho_ten ILIKE '%'||$${i}||'%' OR nd.ten_dang_nhap ILIKE '%'||$${i}||'%')`);
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  params.push(limit); const li = params.length;
  params.push(offset); const oi = params.length;
  const sql = `WITH e AS (${ACTIVITY_UNION})
    SELECT e.tg, e.loai, e.doi_tuong, e.hanh_dong, e.chi_tiet, e.nguoi_id,
           nd.ho_ten AS nguoi, nd.ten_dang_nhap AS username, count(*) OVER() AS total
    FROM e LEFT JOIN nguoi_dung nd ON nd.id = e.nguoi_id
    ${where} ORDER BY e.tg DESC NULLS LAST LIMIT $${li} OFFSET $${oi}`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), params);
  const total = rows[0] ? Number(rows[0].total) : 0;
  return { items: rows.map(({ total: _t, ...r }, idx) => ({ ...r, _k: offset + idx })), total };
}

module.exports = { insertNav, listHistory, listActivity };
