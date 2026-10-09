'use strict';

// ─── BÁO CÁO SỬA HÀNG — đọc dữ liệu thô (09/10/2026) ──────────────────────────────────────────────
// Luật + cách gom: `utils/baoCaoSuaHang.js` (hàm thuần). Ở đây chỉ ĐỌC:
//   1. 1 dòng / TEM GỐC (không tem 17, tem ≠ HUY) từng có hàng sửa (lượt KCS có hư / lượt Sửa trước cuối kỳ), còn
//      liên quan tới kỳ (còn chờ sửa hôm nay HOẶC có sự kiện từ đầu kỳ) — kèm sổ cái sửa, mốc vào sửa
//      (`siSoTram.MOC_VAO_TEM.SUA`, cùng nguồn màn Sửa), chuyền chạy phiếu, phần in của lệnh (gộp chuỗi), và MỌI sự
//      kiện của tem (json): lượt KCS có hư · lượt Sửa · OQC trả về Sửa · hủy/mở tem sửa · tổng Phân loại lỗi.
//      Lấy cả sự kiện ngoài kỳ — cần để dựng số dư đầu kỳ và khớp sổ cái hiện tại.
//   2. SLA trạm SUA của workflow hiện hành (đồng hồ nghẽn — như màn Sửa).
//   · Gửi 1 dòng (IPS), không `--` trong chuỗi SQL. Cache RAM 15s theo khoảng ngày.

const { query } = require('../../config/db');
const { dungBaoCaoSuaHang } = require('../../utils/baoCaoSuaHang');
const { MOC_VAO_TEM } = require('../../utils/siSoTram');
const { coPhanLoaiLoi } = require('./baoCaoKiemHang');

const VN = "AT TIME ZONE 'Asia/Ho_Chi_Minh'";
const W0 = `(($1::date + time '06:00') ${VN})`;
const W1 = `(($2::date + 1 + time '06:00') ${VN})`;
const chuaHuy = (bang, a) => `NOT EXISTS (SELECT 1 FROM audit_log zh WHERE zh.ten_bang = '${bang}'
  AND zh.hanh_dong = 'HUY_XAC_NHAN' AND zh.id_ban_ghi = ${a}.id::text)`;
const TEM_SUA_AUDIT = "('HUY_TEM_SUA','MO_TEM_SUA')";

async function docTem(tuNgay, denNgay) {
  const pllSql = (await coPhanLoaiLoi())
    ? `LEFT JOIN LATERAL (SELECT sum(c.so_luong_sua)::int AS pll_sua, sum(c.so_luong_huy)::int AS pll_huy
      FROM phan_loai_loi p JOIN phan_loai_loi_ct c ON c.phan_loai_loi_id = p.id WHERE p.tem_id = t.id) pll ON true`
    : 'LEFT JOIN LATERAL (SELECT NULL::int AS pll_sua, NULL::int AS pll_huy) pll ON true';
  const sql = `WITH tk AS (SELECT k.tem_id FROM kcs k WHERE COALESCE(k.so_luong_loi,0) > 0 AND k.created_date < ${W1}
      UNION SELECT s.tem_id FROM sua s WHERE s.created_date < ${W1})
    SELECT t.id AS tem_id, t.ma_tem, t.sl_kcs_sua, t.sl_sua_dat, t.sl_sua_huy, ${MOC_VAO_TEM.SUA('t')} AS tg_vao,
      ls.ma_lenh_san_xuat, cs.ma_chuyen, cs.ten_chuyen, lc.ma_loai AS ma_loai_chuyen,
      pi.phan_in_ids, pi.ma_phan, pi.khach, pi.po, pi.ma_hang, pi.mau_vai, pll.pll_sua, pll.pll_huy,
      (SELECT json_agg(json_build_object('tg', k.created_date, 'hu', k.so_luong_loi) ORDER BY k.created_date)
        FROM kcs k WHERE k.tem_id = t.id AND COALESCE(k.so_luong_loi,0) > 0 AND ${chuaHuy('kcs', 'k')}) AS kcs,
      (SELECT json_agg(json_build_object('id', s.id, 'tg', s.created_date, 'dat', s.so_luong_sua_dat,
          'huy', s.so_luong_sua_huy, 'ghi_chu', s.ghi_chu, 'nguoi_sua', s.nguoi_sua, 'nguoi', nd.ho_ten) ORDER BY s.created_date)
        FROM sua s LEFT JOIN nguoi_dung nd ON nd.id = s.created_by WHERE s.tem_id = t.id AND ${chuaHuy('sua', 's')}) AS sua,
      (SELECT json_agg(r.created_date ORDER BY r.created_date) FROM qc_tra_ve r
        WHERE r.tem_id = t.id AND r.loai = 'OQC_SUA') AS tra_ve,
      (SELECT json_agg(json_build_object('tg', a.thoi_gian, 'hd', a.hanh_dong, 'sl', a.gia_tri_moi->>'sl') ORDER BY a.thoi_gian)
        FROM audit_log a WHERE a.ten_bang = 'tem' AND a.id_ban_ghi = t.id::text AND a.hanh_dong IN ${TEM_SUA_AUDIT}) AS huy_tem
    FROM (SELECT DISTINCT tem_id FROM tk) x
    JOIN tem t ON t.id = x.tem_id AND t.tem_goc_id IS NULL AND t.trang_thai <> 'HUY'
    LEFT JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
    LEFT JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
    LEFT JOIN chuyen_san_xuat cs ON cs.id = COALESCE(ps.chuyen_id, ls.chuyen_id)
    LEFT JOIN loai_chuyen lc ON lc.id = cs.loai_chuyen_id
    ${pllSql}
    LEFT JOIN LATERAL (SELECT array_agg(DISTINCT pin.id::text) AS phan_in_ids, string_agg(DISTINCT pin.ma_phan, ', ') AS ma_phan,
        string_agg(DISTINCT kh.ten_khach_hang, ', ') AS khach, string_agg(DISTINCT dh.ma_don_hang, ', ') AS po,
        string_agg(DISTINCT mh.ma_hang, ', ') AS ma_hang, string_agg(DISTINCT pin.mau_vai, ', ') AS mau_vai
      FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id JOIN phan_in pin ON pin.id = dv.phan_in_id
      LEFT JOIN ma_hang mh ON mh.id = pin.ma_hang_id LEFT JOIN don_hang dh ON dh.id = mh.don_hang_id
      LEFT JOIN khach_hang kh ON kh.id = dh.khach_hang_id
      WHERE lsd.lenh_san_xuat_id = COALESCE(ls.lenh_lien_ket_id, ls.id)) pi ON true
    WHERE (COALESCE(t.sl_kcs_sua,0) - COALESCE(t.sl_sua_dat,0) - COALESCE(t.sl_sua_huy,0)) > 0
      OR EXISTS (SELECT 1 FROM kcs k2 WHERE k2.tem_id = t.id AND COALESCE(k2.so_luong_loi,0) > 0 AND k2.created_date >= ${W0})
      OR EXISTS (SELECT 1 FROM sua s2 WHERE s2.tem_id = t.id AND s2.created_date >= ${W0})
      OR EXISTS (SELECT 1 FROM qc_tra_ve r2 WHERE r2.tem_id = t.id AND r2.loai = 'OQC_SUA' AND r2.created_date >= ${W0})
      OR EXISTS (SELECT 1 FROM audit_log a2 WHERE a2.ten_bang = 'tem' AND a2.id_ban_ghi = t.id::text
        AND a2.hanh_dong IN ${TEM_SUA_AUDIT} AND a2.thoi_gian >= ${W0})`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [tuNgay, denNgay]);
  return rows;
}

async function docSlaSua() {
  const { rows } = await query(`SELECT tr.thoi_gian_quy_dinh_phut AS sla FROM tram tr
    JOIN workflow_version wv ON wv.id = tr.workflow_version_id AND wv.la_hien_hanh
    WHERE tr.ma_tram = 'SUA' LIMIT 1`.replace(/\s+/g, ' '));
  return rows[0] ? rows[0].sla : null;
}

const CACHE_MS = 15000;
const cache = new Map(); // `tu|den` → { het, hua }

// Lưu PROMISE ⇒ nhiều người mở cùng lúc chỉ chạy 1 lượt; lỗi thì bỏ cache ngay.
async function baoCaoSuaHang(tuNgay, denNgay) {
  const k = `${tuNgay}|${denNgay}`;
  const now = Date.now();
  const c = cache.get(k);
  if (c && c.het > now) return c.hua;
  const hua = Promise.all([docTem(tuNgay, denNgay), docSlaSua()])
    .then(([rows, slaPhut]) => dungBaoCaoSuaHang({ tuNgay, denNgay, slaPhut, rows }));
  cache.set(k, { het: now + CACHE_MS, hua });
  hua.catch(() => cache.delete(k));
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  return hua;
}

module.exports = { baoCaoSuaHang };
