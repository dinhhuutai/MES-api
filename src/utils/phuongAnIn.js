'use strict';

// ─── CHỈ CHẠY HÀNG "IN MÁY" TỪ RELEASE 1 TRỞ ĐI (chốt 2026-08-04) ─────────────
// Nghiệp vụ: MES chỉ điều hành hàng **in MÁY**. Từ Release 1 đến Giao hàng, phần in có phương án in
// Bàn (1) / Robot (3) / chưa xác định (0) bị **ẩn hoàn toàn** — không chip, không toggle, kể cả hàng
// đang dở. Hàng đó xử lý ngoài MES.
//
// Nguồn phương án in = `ho_so_ky_thuat.phuong_an_in` của HSKT ĐANG HOẠT ĐỘNG, nối qua `hskt_phan_in`.
// ⚠ Phần in KHÔNG có HSKT active cũng bị ẩn (không xác định được phương án in ⇒ không phải "máy").
//
// ⚠⚠ CHỖ CỐ Ý KHÔNG LỌC (công cụ sửa sai, không phải trạm sản xuất):
//   · Hệ thống > Hủy lệnh xác nhận (`listCancelableLenh`, hủy tem/phần in/mở lại…)
//   · Hệ thống > Cập nhật SL nhận vải / release · Nhập tay
//   · Đơn hàng (danh sách phần in vải về) · READY / QC READY (trước Release 1)
//   Nếu lọc luôn ở đó thì lệnh Bàn/Robot lỡ tạo sẽ KHÔNG CÒN ĐƯỜNG NÀO gỡ.
const PAIN_MAY = 2;

// Điều kiện theo PHẦN IN: `pinCol` = cột id phần in trong câu SQL gọi (vd 'pin.id', 'dv.phan_in_id').
const laMayTheoPhanIn = (pinCol) => `EXISTS (
  SELECT 1 FROM hskt_phan_in hp_m
    JOIN ho_so_ky_thuat h_m ON h_m.id = hp_m.hskt_id AND h_m.dang_hoat_dong
   WHERE hp_m.phan_in_id = ${pinCol} AND hp_m.dang_hoat_dong AND h_m.phuong_an_in = ${PAIN_MAY})`
  .replace(/\s+/g, ' ');

// Điều kiện theo LỆNH SẢN XUẤT: lệnh có phần in in Máy.
// (Thực tế 1 lệnh chỉ mang 1 phương án in: gom set = chung 1 HSKT, gộp đợt = cùng 1 phần in
//  ⇒ EXISTS và "mọi phần in" là một; dùng EXISTS cho gọn.)
const laMayTheoLenh = (lenhCol) => `EXISTS (
  SELECT 1 FROM lenh_sx_dot_vai lsd_m
    JOIN dot_vai_ve dv_m ON dv_m.id = lsd_m.dot_vai_ve_id
    JOIN hskt_phan_in hp_m ON hp_m.phan_in_id = dv_m.phan_in_id AND hp_m.dang_hoat_dong
    JOIN ho_so_ky_thuat h_m ON h_m.id = hp_m.hskt_id AND h_m.dang_hoat_dong
   WHERE lsd_m.lenh_san_xuat_id = ${lenhCol} AND h_m.phuong_an_in = ${PAIN_MAY})`
  .replace(/\s+/g, ' ');

// Điều kiện theo PHIẾU sản xuất (KCS / Sửa / OQC / Giao hàng — tem nối lên phiếu → lệnh).
// `phieuCol` = cột phiếu trong câu gọi, thường là `t.phieu_san_xuat_id`.
const laMayTheoPhieu = (phieuCol) => `EXISTS (
  SELECT 1 FROM phieu_san_xuat ps_m
    JOIN lenh_sx_dot_vai lsd_m ON lsd_m.lenh_san_xuat_id = ps_m.lenh_san_xuat_id
    JOIN dot_vai_ve dv_m ON dv_m.id = lsd_m.dot_vai_ve_id
    JOIN hskt_phan_in hp_m ON hp_m.phan_in_id = dv_m.phan_in_id AND hp_m.dang_hoat_dong
    JOIN ho_so_ky_thuat h_m ON h_m.id = hp_m.hskt_id AND h_m.dang_hoat_dong
   WHERE ps_m.id = ${phieuCol} AND h_m.phuong_an_in = ${PAIN_MAY})`
  .replace(/\s+/g, ' ');

module.exports = { PAIN_MAY, laMayTheoPhanIn, laMayTheoLenh, laMayTheoPhieu };
