'use strict';

// ─── THEO DÕI SẢN XUẤT THEO TỔ — đọc dữ liệu thô (21/10/2026, người dùng gửi ảnh "Tổng nhà máy / Chi tiết tổ /
// Bảng theo dõi sản xuất chuyền") ──────────────────────────────────────────────────────────────────────────────
// Trả DỮ LIỆU MỨC LỆNH; FE (`features/production/utils/theoDoiTo.js`) tự cộng lên chuyền → tổ → nhà máy và chia
// giờ — 1 nguồn số cho cả 3 tầng.
//   · KẾ HOẠCH ngày D = lệnh có NGÀY SX KẾ HOẠCH (chọn ở Release 1) = D, theo CHUYỀN KẾ HOẠCH của lệnh, SL = SL
//     release (người dùng chốt: "theo số liệu kế hoạch ở Release 1"). Bỏ lệnh HUY / GIA_CONG. Gồm cả lệnh chưa chạy.
//     ⚠ KHÁC Báo cáo sản xuất (KH theo ngày bấm Xác nhận chạy, chỉ lệnh đang/đã in) — cố ý, đừng ép 2 nơi bằng nhau.
//   · THỰC TẾ ngày D = tem sản xuất (nhãn 15, tem gốc, chưa HUY, bỏ tem script `HT-`, phiếu thật) thuộc NGÀY SX D —
//     CÙNG LUẬT Báo cáo sản xuất (`baoCaoSanXuat.TEM_CUA_NGAY`: ngày ca = D, tem cũ không ngày ca theo lúc in), theo
//     CHUYỀN CHẠY của phiếu; giờ = giờ KẾT THÚC SX nhập ở ô In tem (`MOC_TEM`), không nhập ⇒ lúc in tem.
//     ⇒ Thực tế của chuyền = Σ cột "SL in TT" Báo cáo sản xuất cùng ngày (kể cả lệnh kế hoạch ngày khác).
//   · Lệnh hiện = lệnh kế hoạch ngày D ∪ lệnh có tem trong ngày D. Chuyền thuộc nhóm loại GIA_CONG bị loại.
//   · Tổ của chuyền = `chuyen_san_xuat.to_in_id` (mig 117) — chưa chạy mig ⇒ `co_cot_to=false`, FE gom "Chưa gán tổ".
// Cache RAM 15s theo ngày (FE tự tải lại theo socket + mỗi 30s).

const { query } = require('../../config/db');
const { coCot, PHIEU_THAT, TEM_THAT, TEM_CUA_NGAY, MOC_TEM } = require('./baoCaoSanXuat');
const { PHAN_INFO_LATERAL } = require('../planning/planning.repository');
const { chuyenCoCotTo } = require('../chuyen/chuyen.repository');

const { nhoDoc } = require('../../utils/cacheDoc');

const CACHE_MS = 15000;

async function docLenh(ngay, { coNgayCa, coGoc }) {
  const den = coNgayCa ? MOC_TEM('t.gio_sx_kt') : 't.created_date';
  const sql = `WITH tt AS (
      SELECT ps.lenh_san_xuat_id AS lenh_id, COALESCE(ps.chuyen_id, ls.chuyen_id) AS chuyen_id,
             EXTRACT(HOUR FROM (${den}) AT TIME ZONE 'Asia/Ho_Chi_Minh')::int AS gio, SUM(t.so_luong)::int AS sl
        FROM tem t
        JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
        JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
       WHERE t.trang_thai <> 'HUY' AND ${TEM_THAT} ${coGoc ? 'AND t.tem_goc_id IS NULL' : ''}
         AND ${TEM_CUA_NGAY(coNgayCa)} AND ps.trang_thai <> 'HUY' AND ${PHIEU_THAT}
       GROUP BY 1, 2, 3),
    ids AS (
      SELECT id AS lenh_id FROM lenh_san_xuat WHERE ngay_ke_hoach = $1::date AND trang_thai NOT IN ('HUY', 'GIA_CONG')
      UNION SELECT lenh_id FROM tt)
    SELECT ls.id AS lenh_id, ls.ma_lenh_san_xuat, ls.trang_thai, ls.chuyen_id AS chuyen_kh_id,
           (ls.ngay_ke_hoach = $1::date AND ls.trang_thai NOT IN ('HUY', 'GIA_CONG')) AS la_ke_hoach,
           ls.so_luong_release, ls.tg_bd_kh, ls.tg_kt_kh, to_char(ls.ngay_ke_hoach, 'YYYY-MM-DD') AS ngay_kh,
           info.ten_khach_hang, info.ma_don_hang, info.ma_hang, info.ma_phan, info.mau_vai, info.kich_vai, info.kich_phim,
           (SELECT string_agg(DISTINCT pin.ma_phan, ', ') FROM lenh_sx_dot_vai lsd
              JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id JOIN phan_in pin ON pin.id = dv.phan_in_id
             WHERE lsd.lenh_san_xuat_id = ls.id) AS phan_list,
           (SELECT json_agg(json_build_object('chuyen_id', tt.chuyen_id, 'gio', tt.gio, 'sl', tt.sl))
              FROM tt WHERE tt.lenh_id = ls.id) AS tt
      FROM ids JOIN lenh_san_xuat ls ON ls.id = ids.lenh_id
      ${PHAN_INFO_LATERAL}`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [ngay]);
  return rows;
}

async function docChuyen(coTo) {
  const { rows } = await query(
    `SELECT cs.id, cs.ma_chuyen, cs.ten_chuyen, cs.dang_hoat_dong, lc.ma_loai,
            ${coTo ? 'cs.to_in_id' : 'NULL::uuid AS to_in_id'}
       FROM chuyen_san_xuat cs LEFT JOIN loai_chuyen lc ON lc.id = cs.loai_chuyen_id
      WHERE COALESCE(lc.ma_loai, '') <> 'GIA_CONG'
      ORDER BY cs.ma_chuyen`.replace(/\s+/g, ' ')
  );
  return rows;
}

async function docTo() {
  const { rows } = await query('SELECT id, ma_to, ten_to FROM to_in ORDER BY ma_to');
  return rows;
}

// Cache theo PHIÊN BẢN DỮ LIỆU (`utils/cacheDoc`, 29/10/2026) — in tem / mọi thao tác ghi xóa ngay (cache riêng 15 s cũ
//   trả số cũ khi trang tải lại theo socket).
function theoDoiTo(ngay) {
  return nhoDoc('theo-doi-to', { ngay }, () => dungTheoDoiTo(ngay), CACHE_MS);
}

async function dungTheoDoiTo(ngay) {
  const [coNgayCa, coGoc, coTo] = await Promise.all([
    coCot('tem', 'ngay_ca'), coCot('tem', 'tem_goc_id'), chuyenCoCotTo(),
  ]);
  const [lenh, chuyen, to] = await Promise.all([docLenh(ngay, { coNgayCa, coGoc }), docChuyen(coTo), docTo()]);
  // Bỏ phần thực tế / kế hoạch trên chuyền GIA_CONG (không có trong `chuyen`) — giống Báo cáo sản xuất.
  const coChuyen = new Set(chuyen.map((x) => x.id));
  const lenhSach = lenh.map((l) => ({
    ...l,
    la_ke_hoach: l.la_ke_hoach && coChuyen.has(l.chuyen_kh_id),
    tt: (l.tt || []).filter((x) => coChuyen.has(x.chuyen_id)),
  })).filter((l) => l.la_ke_hoach || l.tt.length);
  return { ngay, co_cot_to: coTo, to, chuyen, lenh: lenhSach };
}

module.exports = { theoDoiTo };
