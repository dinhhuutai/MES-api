'use strict';

// ─── BÁO CÁO PHÂN LOẠI LỖI — đọc dữ liệu thô (11/10/2026) ─────────────────────────────────────────
// Luật + cách dựng: `utils/baoCaoPhanLoaiLoi.js` (hàm thuần). Ở đây chỉ ĐỌC, 2 lượt nối tiếp:
//   1. Lượt KCS của các tem có lượt trong kỳ — DÙNG LẠI câu đọc của Báo cáo kiểm hàng (`baoCaoKiemHang.docLuot`:
//      chuyền, phần in, thợ in, cờ `trong_ky`) ⇒ 2 báo cáo luôn cùng tập tem + cùng SL kiểm.
//   2. Chi tiết phiếu Phân loại lỗi của các tem đó + danh mục mã lỗi (song song).
//   · Gửi 1 dòng (IPS), không `--` trong chuỗi SQL. Cache RAM 15s theo khoảng ngày.
//   · Bảng `phan_loai_loi` (mig 075) chưa có ở môi trường cũ ⇒ coi như chưa phân loại (không lỗi).

const { query } = require('../../config/db');
const { nhoDoc } = require('../../utils/cacheDoc');
const { dungBaoCaoPhanLoaiLoi } = require('../../utils/baoCaoPhanLoaiLoi');
const { docLuot, coPhanLoaiLoi } = require('./baoCaoKiemHang');

async function docPhieu(temIds) {
  if (!temIds.length || !(await coPhanLoaiLoi())) return [];
  const sql = `SELECT p.tem_id, ll.ma_loi, ll.ten_loi, ll.nhom_loi, bp.ma_bien_phap, bp.ten_bien_phap,
      c.so_luong_sua, c.so_luong_huy, c.ghi_chu, COALESCE(p.updated_date, p.created_date) AS tg_phan_loai,
      nd.ho_ten AS nguoi_phan_loai
    FROM phan_loai_loi p JOIN phan_loai_loi_ct c ON c.phan_loai_loi_id = p.id
    LEFT JOIN loai_loi ll ON ll.id = c.loai_loi_id
    LEFT JOIN bien_phap_xu_ly bp ON bp.id = c.bien_phap_id
    LEFT JOIN nguoi_dung nd ON nd.id = COALESCE(p.updated_by, p.created_by)
    WHERE p.tem_id = ANY($1::uuid[])
    ORDER BY p.tem_id, c.thu_tu NULLS LAST, c.created_date`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [temIds]);
  return rows;
}

async function docDanhMuc() {
  const { rows } = await query('SELECT ma_loi, ten_loi, nhom_loi, dang_hoat_dong FROM loai_loi ORDER BY ma_loi');
  return rows;
}

const CACHE_MS = 15000;

async function dungMoi(tuNgay, denNgay) {
  const luot = await docLuot(tuNgay, denNgay);
  const temIds = [...new Set(luot.map((r) => String(r.tem_id)))];
  const [pll, danhMuc] = await Promise.all([docPhieu(temIds), docDanhMuc()]);
  return dungBaoCaoPhanLoaiLoi({ tuNgay, denNgay, luot, pll, danhMuc });
}

// Nhiều người mở cùng lúc chỉ chạy 1 lượt. Cache theo PHIÊN BẢN DỮ LIỆU (`utils/cacheDoc`, 29/10/2026) — mọi thao tác ghi
//   xóa ngay ⇒ trang tải lại theo socket thấy số mới.
function baoCaoPhanLoaiLoi(tuNgay, denNgay) {
  return nhoDoc('bao-cao-phan-loai-loi', { tuNgay, denNgay }, () => dungMoi(tuNgay, denNgay), CACHE_MS);
}

module.exports = { baoCaoPhanLoaiLoi };
