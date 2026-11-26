'use strict';

// ─── NGÀY SẢN XUẤT CỦA TEM — nguồn luật DUY NHẤT ─────────────────────────────────────────────────────────────
// Tem thuộc ngày D ⟺ NGÀY trong MÃ NGÀY CA người in nhập (`tem.ngay_ca`, = 6 số đầu `ma_ngay_ca`) = D. Mã ngày ca đã
//   mang sẵn quy ước ca đêm của tuần (`cai_dat_ca_tuan.ca_dem`, `utils/ca.js`): ca SAU ⇒ tem D2 / C3 in sau nửa đêm vẫn
//   thuộc ngày ca BẮT ĐẦU; ca TRƯỚC ⇒ tem D2 / C3 in từ tối hôm trước thuộc ngày ca KẾT THÚC. Đếm theo ngày lịch lúc in
//   (`created_date`) là xếp sai mọi tem ca đêm.
// Tem cũ chưa có ngày ca (trước mig 066) ⇒ theo lúc in, ngày cắt 06:00 (ca sau — mặc định trước khi có ca trước).
// Dùng ở: Báo cáo sản xuất (`production/baoCaoSanXuat.js TEM_CUA_NGAY`) · Danh sách release SX + Nhật ký in
//   (`production/dsReleaseSx.js`) · tập lệnh `releaseListByDate(…, 'IN_TEM')`. Chỗ mới cần "tem của ngày" ⇒ gọi đây.

const VN = "AT TIME ZONE 'Asia/Ho_Chi_Minh'";

// Biểu thức NGÀY SX của tem (alias `a`) — để SELECT / so sánh trước-sau kỳ. Tem NULL (LEFT JOIN không khớp) ⇒ NULL.
const ngaySxTemSql = (a = 't') => `COALESCE(${a}.ngay_ca, ((${a}.created_date ${VN}) - interval '6 hours')::date)`;

// Điều kiện "tem thuộc khoảng [pTu, pDen]" (tham số SQL dạng '$1') — viết tách 2 nhánh để dùng được index `idx_tem_ngay_ca`.
const temTrongKySql = (a, pTu, pDen = pTu) => `(${a}.ngay_ca BETWEEN ${pTu}::date AND ${pDen}::date
  OR (${a}.ngay_ca IS NULL AND ${a}.created_date >= ((${pTu}::date + time '06:00') ${VN})
      AND ${a}.created_date < ((${pDen}::date + 1 + time '06:00') ${VN})))`;

// CA của tem = 2 ký tự cuối mã ngày ca người in nhập (HC · C1 · C2 · C3 · D1 · D2); tem cũ không mã ⇒ '' (không thuộc ca nào).
//   Bộ lọc "Ca" của Danh sách release SX / Nhật ký in (25/11/2026) — cùng luật cột ca của Báo cáo sản xuất (`ca_hint`).
const CA_TEM = ['HC', 'C1', 'C2', 'C3', 'D1', 'D2'];
const caTemSql = (a = 't') => `upper(right(COALESCE(${a}.ma_ngay_ca, ''), 2))`;
// Chuẩn hóa tham số ca từ query (`"D1,D2"` / mảng) ⇒ mảng mã hợp lệ, không trùng; rỗng = mọi ca.
const chuanDsCa = (v) => {
  const ds = (Array.isArray(v) ? v : String(v || '').split(','))
    .map((x) => String(x || '').trim().toUpperCase()).filter((x) => CA_TEM.includes(x));
  return [...new Set(ds)];
};
// Điều kiện "tem thuộc ca đang lọc" — `pCa` = tham số SQL text[] (rỗng ⇒ mọi ca, kể cả tem không mã ngày ca).
const temThuocCaSql = (a, pCa) => `(cardinality(${pCa}::text[]) = 0 OR ${caTemSql(a)} = ANY(${pCa}::text[]))`;

module.exports = { ngaySxTemSql, temTrongKySql, CA_TEM, caTemSql, chuanDsCa, temThuocCaSql };
