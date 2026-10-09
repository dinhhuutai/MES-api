'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// MÃ CHUYỀN CHUẨN = MÃ CHUYỀN CỦA ERP (09/10/2026 — người dùng gửi danh mục chuyền ERP: `1A1B`, `10A`, `RB1`, `M1`,
// `MECT01`…). MES từng đặt mã Bàn có "M" đầu + dấu "-" (`M1A-1B`, `M10A`) và Robot `MRB1` ⇒ gửi ERP `banin` sai mã.
//   · Bàn: bỏ "M" đầu + mọi "-"/khoảng trắng — `M1A-1B` → `1A1B` · `M10A` → `10A` · `M1A` → `1A`.
//   · Robot: `MRB1` → `RB1`.
//   · Mã khác giữ nguyên (chỉ bỏ "-"/khoảng trắng, viết HOA): Máy `M1` · Máy tròn `M10` · Ép `MECT01` · gia công.
// Idempotent: mã đã chuẩn đi qua vẫn ra chính nó ⇒ code so mã chạy đúng cả TRƯỚC lẫn SAU khi chạy script đổi mã
// (`database/scripts/doi_ma_chuyen_theo_erp.sql`). Gương FE: `frontend/src/utils/maChuyen.js` — sửa cả hai.
// ─────────────────────────────────────────────────────────────────────────────
function chuanMaChuyen(ma) {
  const s = String(ma == null ? '' : ma).trim().toUpperCase().replace(/[\s-]+/g, '');
  const ban = /^M(\d+[AB](?:\d+[AB])?)$/.exec(s);
  if (ban) return ban[1];
  const robot = /^M(RB\d+)$/.exec(s);
  if (robot) return robot[1];
  return s;
}

// Cùng luật trên cho 1 biểu thức SQL (vd so token trong chuỗi mã chuyền đã `string_agg`).
const chuanMaChuyenSql = (bieuThuc) => `regexp_replace(regexp_replace(upper(btrim(${bieuThuc})), '[[:space:]-]+', '', 'g'),
  '^M([0-9]+[AB]([0-9]+[AB])?|RB[0-9]+)$', '\\1')`;

module.exports = { chuanMaChuyen, chuanMaChuyenSql };
