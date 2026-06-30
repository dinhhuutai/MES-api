'use strict';

// Fragment SQL: EXISTS khớp thuộc tính phần in (code phần / mã hàng / màu vải / kích vải / kích phim)
// cho 1 lệnh sản xuất. lenhIdExpr: biểu thức id lệnh (vd 'ls.id'); p: placeholder param (vd '$1').
// Dùng cho các màn theo tem/lệnh để tìm kiếm xuyên xuống phần in.
function lenhPhanInMatch(lenhIdExpr, p) {
  return `EXISTS (
    SELECT 1 FROM lenh_sx_dot_vai lsd_s
    JOIN dot_vai_ve dv_s ON dv_s.id = lsd_s.dot_vai_ve_id
    JOIN phan_in pin_s ON pin_s.id = dv_s.phan_in_id
    JOIN ma_hang mh_s ON mh_s.id = pin_s.ma_hang_id
    WHERE lsd_s.lenh_san_xuat_id = ${lenhIdExpr}
      AND (pin_s.ma_phan ILIKE '%'||${p}||'%' OR mh_s.ma_hang ILIKE '%'||${p}||'%'
           OR pin_s.mau_vai ILIKE '%'||${p}||'%' OR pin_s.kich_vai ILIKE '%'||${p}||'%'
           OR pin_s.kich_phim ILIKE '%'||${p}||'%'))`;
}

module.exports = { lenhPhanInMatch };
