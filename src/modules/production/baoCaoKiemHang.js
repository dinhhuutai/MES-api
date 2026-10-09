'use strict';

// ─── BÁO CÁO KẾT QUẢ KIỂM HÀNG — đọc dữ liệu thô (02/10/2026) ─────────────────────────────────────
// Luật + cách gom: `utils/baoCaoKiemHang.js` (hàm thuần). Ở đây chỉ ĐỌC 1 câu:
//   MỌI lượt KCS chưa hủy xác nhận của các TEM có ít nhất 1 lượt trong khoảng ngày SX
//   [tuNgay 06:00 → denNgay+1 06:00) giờ VN — lượt ngoài kỳ của cùng tem cũng lấy (cờ `trong_ky`) để chia
//   phần hủy của phiếu Phân loại lỗi theo tem cho đúng. Kèm chuyền (phiếu → lệnh), phần in (gộp chuỗi),
//   người kiểm, tổng sửa/hủy đã phân loại của tem.
//   · Gửi 1 dòng (IPS), không `--` trong chuỗi SQL. Cache RAM 15s theo khoảng ngày.

const { query } = require('../../config/db');
const { dungBaoCaoKiemHang } = require('../../utils/baoCaoKiemHang');

const VN = "AT TIME ZONE 'Asia/Ho_Chi_Minh'";
const W0 = `(($1::date + time '06:00') ${VN})`;
const W1 = `(($2::date + 1 + time '06:00') ${VN})`;
const CHUA_HUY = `NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.ten_bang = 'kcs' AND a.hanh_dong = 'HUY_XAC_NHAN'
  AND a.id_ban_ghi = k.id::text)`;

// Bảng Phân loại lỗi (mig 075) có thể chưa có ở môi trường cũ (vd THLA_TEST) ⇒ dò trước, thiếu thì coi như
// chưa phân loại (hư = sửa). Cache khi ĐÃ có bảng (chạy migration xong nhận ngay, khỏi restart).
let _coPll = false;
async function coPhanLoaiLoi() {
  if (_coPll) return true;
  const { rows } = await query(`SELECT count(*)::int n FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('phan_loai_loi', 'phan_loai_loi_ct')`.replace(/\s+/g, ' '));
  _coPll = rows[0].n === 2;
  return _coPll;
}

async function docLuot(tuNgay, denNgay) {
  const pllSql = (await coPhanLoaiLoi())
    ? `LEFT JOIN LATERAL (SELECT sum(c.so_luong_sua)::int AS pll_sua, sum(c.so_luong_huy)::int AS pll_huy
      FROM phan_loai_loi p JOIN phan_loai_loi_ct c ON c.phan_loai_loi_id = p.id WHERE p.tem_id = k.tem_id) pll ON true`
    : 'LEFT JOIN LATERAL (SELECT NULL::int AS pll_sua, NULL::int AS pll_huy) pll ON true';
  const sql = `WITH tk AS (SELECT DISTINCT k.tem_id FROM kcs k WHERE k.created_date >= ${W0} AND k.created_date < ${W1})
    SELECT k.id, k.tem_id, k.created_date AS tg_kiem, k.so_luong_dat, k.so_luong_loi, k.so_luong_huy,
      (k.created_date >= ${W0} AND k.created_date < ${W1}) AS trong_ky,
      to_char(((k.created_date ${VN}) - interval '6 hours')::date, 'YYYY-MM-DD') AS ngay_sx,
      t.ma_tem, ls.ma_lenh_san_xuat, cs.ma_chuyen, cs.ten_chuyen, lc.ma_loai AS ma_loai_chuyen,
      nd.ho_ten AS nguoi_kiem, pll.pll_sua, pll.pll_huy,
      pi.ma_phan, pi.khach, pi.po, pi.ma_hang, pi.mau_vai
    FROM kcs k JOIN tk ON tk.tem_id = k.tem_id
    JOIN tem t ON t.id = k.tem_id AND t.trang_thai <> 'HUY'
    LEFT JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
    LEFT JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
    LEFT JOIN chuyen_san_xuat cs ON cs.id = COALESCE(ps.chuyen_id, ls.chuyen_id)
    LEFT JOIN loai_chuyen lc ON lc.id = cs.loai_chuyen_id
    LEFT JOIN nguoi_dung nd ON nd.id = k.created_by
    ${pllSql}
    LEFT JOIN LATERAL (SELECT string_agg(DISTINCT pin.ma_phan, ', ') AS ma_phan,
        string_agg(DISTINCT kh.ten_khach_hang, ', ') AS khach, string_agg(DISTINCT dh.ma_don_hang, ', ') AS po,
        string_agg(DISTINCT mh.ma_hang, ', ') AS ma_hang, string_agg(DISTINCT pin.mau_vai, ', ') AS mau_vai
      FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id JOIN phan_in pin ON pin.id = dv.phan_in_id
      LEFT JOIN ma_hang mh ON mh.id = pin.ma_hang_id LEFT JOIN don_hang dh ON dh.id = mh.don_hang_id
      LEFT JOIN khach_hang kh ON kh.id = dh.khach_hang_id
      WHERE lsd.lenh_san_xuat_id = COALESCE(ls.lenh_lien_ket_id, ls.id)) pi ON true
    WHERE ${CHUA_HUY}
    ORDER BY k.tem_id, k.created_date`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [tuNgay, denNgay]);
  return rows;
}

const CACHE_MS = 15000;
const cache = new Map(); // `tu|den` → { het, hua }

// Lưu PROMISE ⇒ nhiều người mở cùng lúc chỉ chạy 1 lượt; lỗi thì bỏ cache ngay.
async function baoCaoKiemHang(tuNgay, denNgay) {
  const k = `${tuNgay}|${denNgay}`;
  const now = Date.now();
  const c = cache.get(k);
  if (c && c.het > now) return c.hua;
  const hua = docLuot(tuNgay, denNgay).then((rows) => dungBaoCaoKiemHang({ tuNgay, denNgay, rows }));
  cache.set(k, { het: now + CACHE_MS, hua });
  hua.catch(() => cache.delete(k));
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  return hua;
}

module.exports = { baoCaoKiemHang, coPhanLoaiLoi };
