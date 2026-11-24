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

// ⚠⚠ CHỐT CHUYỀN LÚC IN (23/11/2026, người dùng chốt: "tem đã in gửi ERP, ngoài Sửa tem và Sửa & gửi lại tem in ở admin thì
//   những cái khác không ảnh hưởng tem in — in tem 1 ở RB2, đổi chuyền RB3 in tem 2 thì tem 1 vẫn RB2"). Trước đây tem chỉ
//   mang `chuyen_id` khi Sửa tem đổi chuyền, còn lại đọc chuyền HIỆN TẠI của phiếu ⇒ Đổi chuyền phiếu / gộp lệnh kéo mọi tem
//   cũ sang chuyền mới (ca 152608085637: SF0 gửi RB2, MES hiện RB3; Sh6 / SK6 / QO6 / SF0 gửi lại cũng mang chuyền mới).
//   Nay mọi tem in ra ghi luôn `tem.chuyen_id` = chuyền phiếu (lùi chuyền lệnh) ngay trong transaction in. Chỉ ghi khi đang NULL.
async function chotChuyenTemTx(client, temId) {
  if (!temId || !(await coCotChuyenTem())) return;
  await client.query(
    `UPDATE tem t SET chuyen_id = COALESCE(ps.chuyen_id, ls.chuyen_id)
       FROM phieu_san_xuat ps JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
      WHERE t.id = $1 AND ps.id = t.phieu_san_xuat_id AND t.chuyen_id IS NULL`.replace(/\s+/g, ' '), [temId]);
}

module.exports = { coCotChuyenTem, chuyenTemSql, chotChuyenTemTx };
