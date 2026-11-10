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

module.exports = { ngaySxTemSql, temTrongKySql };
