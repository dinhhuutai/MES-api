'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CHUYỀN CỦA 1 TEM (mig 124, 05/11/2026 — Sửa tem đổi được chuyền của riêng tem đó).
//   Thứ tự: `tem.chuyen_id` (đã sửa riêng) → chuyền thực tế của phiếu → chuyền kế hoạch của lệnh.
// Câu đọc nào lấy "chuyền của tem" đều phải đi qua `chuyenTemSql`, đừng viết thẳng `ps.chuyen_id`.
// Dò cột: chưa chạy mig ⇒ mảnh SQL y như cũ. Chỉ nhớ khi ĐÃ có cột ⇒ chạy mig xong nhận ngay, không cần restart.
//
// ⚠ Chưa áp ở `utils/siSoTram.js NGUON_TEM` (chip chuyền của dải Theo dõi): chuỗi SQL ở đó dựng 1 lần lúc nạp module.
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../config/db');

let _co = false;
async function coCotChuyenTem() {
  if (_co) return true;
  const { rows } = await query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tem' AND column_name='chuyen_id' LIMIT 1"
  );
  _co = rows.length > 0;
  return _co;
}

// `ps` / `ls` = bí danh bảng trong câu gọi; `ls: null` khi câu không có bảng lệnh.
async function chuyenTemSql({ t = 't', ps = 'ps', ls = 'ls' } = {}) {
  const co = await coCotChuyenTem();
  const ds = [...(co ? [`${t}.chuyen_id`] : []), `${ps}.chuyen_id`, ...(ls ? [`${ls}.chuyen_id`] : [])];
  return ds.length > 1 ? `COALESCE(${ds.join(', ')})` : ds[0];
}

module.exports = { coCotChuyenTem, chuyenTemSql };
