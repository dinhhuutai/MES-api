'use strict';

// =====================================================================
// Catalog dữ liệu có sẵn cho báo cáo tự thiết kế (metric registry).
// Mỗi metric = 1 con số tổng hợp theo KỲ (từ ngày–đến ngày). fn(query, period) → Number.
//  - theo_ky=true : lọc theo kỳ; theo_ky=false : giá trị hiện tại (không theo kỳ).
// Lọc ngày VN: TIMESTAMPTZ dùng (col AT TIME ZONE 'Asia/Ho_Chi_Minh')::date; cột DATE dùng trực tiếp.
// Thêm metric mới = thêm 1 phần tử vào MẢNG dưới đây.
// =====================================================================

const { query } = require('../../config/db');

// Helper: lấy 1 số vô hướng từ 1 câu SQL trả về cột `v`.
async function scalar(sql, params = []) {
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), params);
  const v = rows[0] ? rows[0].v : 0;
  return v == null ? 0 : Number(v);
}

// Lọc theo kỳ cho cột TIMESTAMPTZ (vd created_date).
const TS = (col) => `(${col} AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $1 AND $2`;
// Lọc theo kỳ cho cột DATE (vd ngay_vai_ve, ngay_giao).
const DT = (col) => `${col} BETWEEN $1::date AND $2::date`;

// mỗi def: { ma, ten, mo_ta, nhom, kieu:'so', don_vi, theo_ky, run(period) }
const DEFS = [
  // ----- ĐƠN HÀNG -----
  { ma: 'SO_DON', ten: 'Số đơn hàng', nhom: 'Đơn hàng', don_vi: 'đơn',
    mo_ta: 'Số đơn hàng (don_hang) được tạo trong kỳ (theo created_date).',
    run: (p) => scalar(`SELECT count(*)::numeric AS v FROM don_hang WHERE ${TS('created_date')}`, [p.tu, p.den]) },
  { ma: 'SO_MA_HANG', ten: 'Số mã hàng', nhom: 'Đơn hàng', don_vi: 'mã',
    mo_ta: 'Số mã hàng (ma_hang) được tạo trong kỳ.',
    run: (p) => scalar(`SELECT count(*)::numeric AS v FROM ma_hang WHERE ${TS('created_date')}`, [p.tu, p.den]) },
  { ma: 'SO_PHAN_IN', ten: 'Số phần in', nhom: 'Đơn hàng', don_vi: 'phần',
    mo_ta: 'Số phần in (phan_in) được tạo trong kỳ.',
    run: (p) => scalar(`SELECT count(*)::numeric AS v FROM phan_in WHERE ${TS('created_date')}`, [p.tu, p.den]) },
  { ma: 'TONG_SL_DON', ten: 'Tổng SL đặt', nhom: 'Đơn hàng', don_vi: 'pcs',
    mo_ta: 'Tổng số lượng đặt hàng (sum phan_in.so_luong_don_hang) của phần in tạo trong kỳ.',
    run: (p) => scalar(`SELECT COALESCE(sum(so_luong_don_hang),0)::numeric AS v FROM phan_in WHERE ${TS('created_date')}`, [p.tu, p.den]) },

  // ----- VẢI VỀ -----
  { ma: 'SO_DOT_VAI', ten: 'Số đợt vải về', nhom: 'Vải về', don_vi: 'đợt',
    mo_ta: 'Số đợt vải về (dot_vai_ve) theo ngày vải về (ngay_vai_ve) trong kỳ.',
    run: (p) => scalar(`SELECT count(*)::numeric AS v FROM dot_vai_ve WHERE ${DT('ngay_vai_ve')}`, [p.tu, p.den]) },
  { ma: 'TONG_SL_VAI_VE', ten: 'Tổng SL vải về', nhom: 'Vải về', don_vi: 'pcs',
    mo_ta: 'Tổng số lượng vải về (sum dot_vai_ve.so_luong_vai_ve) theo ngày vải về trong kỳ.',
    run: (p) => scalar(`SELECT COALESCE(sum(so_luong_vai_ve),0)::numeric AS v FROM dot_vai_ve WHERE ${DT('ngay_vai_ve')}`, [p.tu, p.den]) },

  // ----- SẢN XUẤT -----
  { ma: 'SO_LENH_SX', ten: 'Số lệnh sản xuất', nhom: 'Sản xuất', don_vi: 'lệnh',
    mo_ta: 'Số lệnh sản xuất (lenh_san_xuat) tạo trong kỳ.',
    run: (p) => scalar(`SELECT count(*)::numeric AS v FROM lenh_san_xuat WHERE ${TS('created_date')}`, [p.tu, p.den]) },
  { ma: 'SO_PHIEU_SX', ten: 'Số phiếu sản xuất', nhom: 'Sản xuất', don_vi: 'phiếu',
    mo_ta: 'Số phiếu sản xuất (phieu_san_xuat) tạo trong kỳ.',
    run: (p) => scalar(`SELECT count(*)::numeric AS v FROM phieu_san_xuat WHERE ${TS('created_date')}`, [p.tu, p.den]) },
  { ma: 'TONG_SL_IN', ten: 'Tổng SL in', nhom: 'Sản xuất', don_vi: 'pcs',
    mo_ta: 'Tổng số lượng đã in (sum tem.so_luong, loại tem HUY) theo ngày tạo tem trong kỳ.',
    run: (p) => scalar(`SELECT COALESCE(sum(so_luong),0)::numeric AS v FROM tem WHERE trang_thai <> 'HUY' AND ${TS('created_date')}`, [p.tu, p.den]) },
  { ma: 'SO_TEM_IN', ten: 'Số tem in', nhom: 'Sản xuất', don_vi: 'tem',
    mo_ta: 'Số tem đã in (loại tem HUY) tạo trong kỳ.',
    run: (p) => scalar(`SELECT count(*)::numeric AS v FROM tem WHERE trang_thai <> 'HUY' AND ${TS('created_date')}`, [p.tu, p.den]) },

  // ----- CHẤT LƯỢNG -----
  { ma: 'SO_KCS', ten: 'Số lần KCS', nhom: 'Chất lượng', don_vi: 'lần',
    mo_ta: 'Số lần kiểm KCS (kcs) trong kỳ.',
    run: (p) => scalar(`SELECT count(*)::numeric AS v FROM kcs WHERE ${TS('created_date')}`, [p.tu, p.den]) },
  { ma: 'TONG_DAT_KCS', ten: 'SL đạt KCS', nhom: 'Chất lượng', don_vi: 'pcs',
    mo_ta: 'Tổng số lượng đạt khi KCS (sum kcs.so_luong_dat) trong kỳ.',
    run: (p) => scalar(`SELECT COALESCE(sum(so_luong_dat),0)::numeric AS v FROM kcs WHERE ${TS('created_date')}`, [p.tu, p.den]) },
  { ma: 'TONG_LOI_KCS', ten: 'SL lỗi KCS', nhom: 'Chất lượng', don_vi: 'pcs',
    mo_ta: 'Tổng số lượng lỗi khi KCS (sum kcs.so_luong_loi) trong kỳ.',
    run: (p) => scalar(`SELECT COALESCE(sum(so_luong_loi),0)::numeric AS v FROM kcs WHERE ${TS('created_date')}`, [p.tu, p.den]) },
  { ma: 'SO_OQC_DAT', ten: 'OQC đạt', nhom: 'Chất lượng', don_vi: 'lần',
    mo_ta: 'Số lần OQC kết quả ĐẠT (oqc.ket_qua=DAT) trong kỳ.',
    run: (p) => scalar(`SELECT count(*)::numeric AS v FROM oqc WHERE ket_qua = 'DAT' AND ${TS('created_date')}`, [p.tu, p.den]) },
  { ma: 'SO_OQC_KHONG_DAT', ten: 'OQC không đạt', nhom: 'Chất lượng', don_vi: 'lần',
    mo_ta: 'Số lần OQC kết quả KHÔNG ĐẠT (oqc.ket_qua=KHONG_DAT) trong kỳ.',
    run: (p) => scalar(`SELECT count(*)::numeric AS v FROM oqc WHERE ket_qua = 'KHONG_DAT' AND ${TS('created_date')}`, [p.tu, p.den]) },
  { ma: 'TONG_LOI_INLINE', ten: 'SL lỗi QC in-line', nhom: 'Chất lượng', don_vi: 'pcs',
    mo_ta: 'Tổng số lượng lỗi QC in-line (sum qc_in_line.so_luong_loi) trong kỳ.',
    run: (p) => scalar(`SELECT COALESCE(sum(so_luong_loi),0)::numeric AS v FROM qc_in_line WHERE ${TS('created_date')}`, [p.tu, p.den]) },

  // ----- GIAO HÀNG -----
  { ma: 'SO_PHIEU_GIAO', ten: 'Số phiếu giao', nhom: 'Giao hàng', don_vi: 'phiếu',
    mo_ta: 'Số phiếu giao đã giao (giao_hang trang_thai=DA_GIAO) theo ngày giao trong kỳ.',
    run: (p) => scalar(`SELECT count(*)::numeric AS v FROM giao_hang WHERE trang_thai = 'DA_GIAO' AND ${DT('ngay_giao')}`, [p.tu, p.den]) },
  { ma: 'TONG_SL_GIAO', ten: 'Tổng SL giao', nhom: 'Giao hàng', don_vi: 'pcs',
    mo_ta: 'Tổng số lượng giao (sum giao_hang_tem.so_luong_giao) của phiếu DA_GIAO theo ngày giao trong kỳ.',
    run: (p) => scalar(`SELECT COALESCE(sum(gt.so_luong_giao),0)::numeric AS v FROM giao_hang_tem gt JOIN giao_hang gh ON gh.id = gt.giao_hang_id WHERE gh.trang_thai = 'DA_GIAO' AND ${DT('gh.ngay_giao')}`, [p.tu, p.den]) },
  { ma: 'SO_TEM_GIAO', ten: 'Số tem giao', nhom: 'Giao hàng', don_vi: 'tem',
    mo_ta: 'Số tem đã giao (giao_hang_tem của phiếu DA_GIAO) theo ngày giao trong kỳ.',
    run: (p) => scalar(`SELECT count(*)::numeric AS v FROM giao_hang_tem gt JOIN giao_hang gh ON gh.id = gt.giao_hang_id WHERE gh.trang_thai = 'DA_GIAO' AND ${DT('gh.ngay_giao')}`, [p.tu, p.den]) },

  // ----- HIỆN TẠI (không theo kỳ) -----
  { ma: 'SO_XE_DANG_PHOI', ten: 'Tem đang phơi', nhom: 'Hiện tại', don_vi: 'tem', theo_ky: false,
    mo_ta: 'Số tem đang phơi hiện tại (tem_xe_phoi trang_thai=DANG_PHOI). Không phụ thuộc kỳ.',
    run: () => scalar("SELECT count(*)::numeric AS v FROM tem_xe_phoi WHERE trang_thai = 'DANG_PHOI'") },
];

const BY_MA = Object.fromEntries(DEFS.map((d) => [d.ma, d]));

// Danh mục cho FE (không kèm hàm run).
function catalog() {
  return DEFS.map(({ run, ...d }) => ({ ...d, kieu: 'so', theo_ky: d.theo_ky !== false }));
}

// Tính giá trị cho 1 tập mã metric (chỉ metric được dùng) trong kỳ → { ma: value }.
async function compute(maList, period) {
  const uniq = [...new Set(maList)].filter((ma) => BY_MA[ma]);
  const results = await Promise.all(uniq.map(async (ma) => {
    try { return [ma, await BY_MA[ma].run(period)]; }
    catch (e) { return [ma, { loi: e.message }]; }
  }));
  return Object.fromEntries(results);
}

module.exports = { catalog, compute, BY_MA };
