'use strict';

// ─── DANH MỤC TỔ IN LẤY TỪ TỔ CỦA PHÒNG CSX (02/10/2026, người dùng chốt) ─────────────────────────
// Tổ in (ô "Tổ in" ở khối Phân công, gửi ERP qua `@pToin`) KHÔNG nhập tay riêng nữa mà bám theo tổ của
// phòng sản xuất CSX (`to_phong_ban`, mig 104 — mã do nhân sự nạp bằng script, dạng 'TO 1').
// Mã gửi ERP đổi theo luật:  'TO 1' → 'C1'  ·  'TO 1 CTV' → 'C1CTV'  (tên giữ nguyên 'TO 1').
// Tổ khác của CSX (SX-HC, SX-KCS, KT-CN…, 'TO KCS CTV') không phải tổ in ⇒ bỏ.
// ⚠ Bảng `to_in` VẪN là nơi phiếu trỏ tới (`phieu_san_xuat.to_in_id`) — chỉ được ĐỒNG BỘ từ CSX
//   (`production.repository.dongBoToInTuCsx`), không đổi schema.
const RE_TO_IN = /^TO\s*(\d+)(\s*CTV)?$/i;

function maToInTuToCsx(maTo) {
  const m = RE_TO_IN.exec(String(maTo || '').trim());
  if (!m) return null;
  return `C${Number(m[1])}${m[2] ? 'CTV' : ''}`;
}

module.exports = { maToInTuToCsx, RE_TO_IN };
