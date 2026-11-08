'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// GẮN THÔNG TIN PHẦN IN VÀO DÒNG SIDEBAR "LỊCH SỬ" (08/11/2026, người dùng: "trong các modal lịch sử cho
// thêm thông tin từ khách hàng đến kích film").
//
// Mỗi dòng lịch sử (READY · QC READY · Release 1 · KH tạm · Test Run · Release 2 / Lập lại KH · KCS · Sửa ·
// OQC · QC in-line · Giao hàng) đã mang `ma_phan` (1 code phần, hoặc danh sách "A, B" khi lệnh gom set) ⇒
// tra 1 LẦN cho cả danh sách rồi gắn: `ten_khach_hang` · `ma_don_hang` · `ma_hang` · `mau_vai` · `kich_vai` ·
// `kich_phim` (gom set ⇒ các giá trị KHÁC NHAU nối ", ").
//   · Trường dòng đã có sẵn (vd READY có `ma_hang`) thì GIỮ — chỉ điền ô trống.
//   · Từ mig 121 cùng code phần có thể có 2 phần in (khác màu mực) — đơn / mã hàng / màu vải / kích của 2 phần
//     in đó là 1 dòng đơn ERP nên giống nhau ⇒ lấy phần in đang hoạt động, mới nhất.
//   · Tính năng phụ ⇒ FAIL-OPEN: tra lỗi thì trả nguyên danh sách (sidebar vẫn hiện như cũ).
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../config/db');

const TRUONG = ['ten_khach_hang', 'ma_don_hang', 'ma_hang', 'mau_vai', 'kich_vai', 'kich_phim'];

const tachMa = (s) => String(s == null ? '' : s).split(/\s*[,;]\s*/).map((x) => x.trim()).filter(Boolean);

const SQL = `
  SELECT DISTINCT ON (pin.ma_phan) pin.ma_phan, kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang,
         pin.mau_vai, pin.kich_vai, pin.kich_phim
  FROM phan_in pin
  JOIN ma_hang mh ON mh.id = pin.ma_hang_id
  JOIN don_hang dh ON dh.id = mh.don_hang_id
  LEFT JOIN khach_hang kh ON kh.id = dh.khach_hang_id
  WHERE pin.ma_phan = ANY($1::text[])
  ORDER BY pin.ma_phan, pin.dang_hoat_dong DESC, pin.created_date DESC`.replace(/\s+/g, ' ');

/**
 * @param {Array<object>} rows  dòng lịch sử có `ma_phan`
 * @returns {Promise<Array<object>>} cùng mảng (đã gắn trường)
 */
async function ganThongTinPhanIn(rows) {
  const ds = Array.isArray(rows) ? rows : [];
  const ma = [...new Set(ds.flatMap((r) => tachMa(r && r.ma_phan)))];
  if (!ma.length) return ds;
  let theoMa;
  try {
    const { rows: kq } = await query(SQL, [ma]);
    theoMa = new Map(kq.map((x) => [x.ma_phan, x]));
  } catch (e) {
    console.warn(`[lich-su] Không gắn được thông tin phần in: ${e.message}`);
    return ds;
  }
  for (const r of ds) {
    if (!r) continue;
    const info = tachMa(r.ma_phan).map((m) => theoMa.get(m)).filter(Boolean);
    if (!info.length) continue;
    for (const k of TRUONG) {
      if (r[k] != null && String(r[k]).trim() !== '') continue;
      const v = [...new Set(info.map((x) => x[k]).filter((x) => x != null && String(x).trim() !== ''))];
      r[k] = v.join(', ');
    }
  }
  return ds;
}

module.exports = { ganThongTinPhanIn, TRUONG };
