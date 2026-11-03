'use strict';

// PHÂN BIỆT 2 LOẠI TEM CON (tem 17, `tem_goc_id` ≠ NULL) — mig 122, 03/11/2026:
//   · tem 17 của lượt SỬA đạt (mig 091/100)   → `kcs_tach_id` NULL ⇒ là "hàng sửa".
//   · tem 17 của lượt KCS kiểm MỘT PHẦN        → `kcs_tach_id` = lượt KCS ⇒ là hàng KCS đạt, KHÔNG phải hàng sửa.
//
// ⚠ Đọc qua `to_jsonb` để chưa chạy mig 122 thì ra NULL / 0, không lỗi — các mảnh này nằm trong câu SQL tĩnh của nhiều
//   module, không dò cột từng nơi được. Đừng dùng trong WHERE của bảng lớn khi có điều kiện chọn lọc hơn.
// ⚠ `a` = alias bảng `tem` trong câu SQL (literal nội bộ, không nhận từ người dùng).
const kcsTachIdSql = (a = 't') => `(to_jsonb(${a})->>'kcs_tach_id')`;
const laTemSuaSql = (a = 't') => `(${a}.tem_goc_id IS NOT NULL AND ${kcsTachIdSql(a)} IS NULL)`;
const slKcsTachSql = (a = 't') => `COALESCE((to_jsonb(${a})->>'sl_kcs_tach')::int, 0)`;

module.exports = { kcsTachIdSql, laTemSuaSql, slKcsTachSql };
