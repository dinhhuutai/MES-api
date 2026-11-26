'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SỐ LƯỢNG vs BỔ SUNG KHÔNG GỘP CHUNG 1 LỆNH (26/11/2026, người dùng: "Xác nhận chạy tách 2 dòng số lượng với bổ sung — mở, in
//   tem, checkbox riêng, như 2 phần riêng"). Đợt MÃ loại `BO_SUNG` (không so tên) là phần BỔ SUNG, mọi loại khác là SỐ LƯỢNG.
//   Mỗi lệnh chỉ mang 1 loại ⇒ Xác nhận chạy có 2 lệnh = 2 dòng thật (mở / in tem / tích riêng). Áp ở MỌI chỗ gộp đợt / lệnh
//   (cùng chỗ với luật khác nhà gia công `utils/nhaGiaCong.js`): Release 1 gom đợt cùng phần in · Release 1 phần ép · Tạo đợt SX
//   · `production.gopLenhCungPhan` (409 `KHAC_LOAI_SL_BS`) · Xác nhận chạy nhiều lệnh · "Không test run" cộng thẳng vào lệnh đang
//   chạy (`planning.repository lenhDangChayCuaPhanIn`). Lệnh lẫn cả hai có từ trước (MIX) giữ nguyên — FE hiện 2 dòng con.
// ─────────────────────────────────────────────────────────────────────────────

// Khóa loại của 1 ĐỢT (theo mã loại đợt).
const khoaLoaiDot = (maLoai) => (String(maLoai || '').trim().toUpperCase() === 'BO_SUNG' ? 'BS' : 'SL');
const TEN_LOAI = { SL: 'số lượng', BS: 'bổ sung', MIX: 'số lượng + bổ sung' };

// Loại của 1 LỆNH: 'SL' · 'BS' · 'MIX' (lẫn cả hai). Chỉ xét dòng đợt có SL > 0; lệnh chưa có đợt ⇒ 'SL'.
const loaiSlBsLenhSql = (lenhCol) => `COALESCE((SELECT CASE
      WHEN bool_and(ldq.ma_loai IS NOT DISTINCT FROM 'BO_SUNG') THEN 'BS'
      WHEN bool_or(ldq.ma_loai IS NOT DISTINCT FROM 'BO_SUNG') THEN 'MIX' ELSE 'SL' END
    FROM lenh_sx_dot_vai lsq JOIN dot_vai_ve dvq ON dvq.id = lsq.dot_vai_ve_id
    LEFT JOIN loai_dot_vai ldq ON ldq.id = dvq.loai_dot_vai_id
   WHERE lsq.lenh_san_xuat_id = ${lenhCol} AND COALESCE(lsq.so_luong, 0) > 0), 'SL')`;

module.exports = { khoaLoaiDot, loaiSlBsLenhSql, TEN_LOAI };
