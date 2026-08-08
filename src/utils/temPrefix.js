'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// TIỀN TỐ CÔNG ĐOẠN TRÊN MÃ TEM — 13 hàng gia công về · 15 KCS đạt · 16 chuyển sửa · 17 sửa đạt để giao.
//
// HAI ĐỊNH DẠNG CÙNG TỒN TẠI (đừng bỏ cái nào):
//   · MỚI (từ 07/08/2026) — `ma_tem` = barcode ERP **12 chữ số, 2 SỐ ĐẦU ĐÃ LÀ TIỀN TỐ** (`15…`).
//     Đổi công đoạn = **THAY 2 SỐ ĐẦU**:  152608057689 → 162608057689 → 172608057689.
//   · CŨ — `ma_tem` dạng `TEM00123`, tiền tố nối bằng DẤU GẠCH: `15-TEM00123`.
// ⇒ `temCode()` tự nhận dạng; tem in trước đây quét vẫn ra đúng, không phải in lại phiếu.
//
// Bản FE gương lại y hệt ở `frontend/src/features/production/utils/printTemLabel.js` (temCode)
// và `frontend/src/utils/format.js` (baseMaTem) — sửa luật thì sửa CẢ HAI.
// ─────────────────────────────────────────────────────────────────────────────

// Mã ERP: đúng 12 chữ số, 2 số đầu là tiền tố công đoạn hợp lệ.
const MA_ERP_RE = /^1[3-9]\d{10}$/;
const laMaErp = (ma) => MA_ERP_RE.test(String(ma || '').trim());

// Mã tem hiển thị/in ra = mã gốc gắn tiền tố công đoạn (+ hậu tố lần giao nếu tem tách nhiều lần).
// Hậu tố `-N` GIỮ NGUYÊN theo chốt 07/08/2026 (phân biệt được từng lần giao trên giấy).
function temCode(maTem, prefix, suffix) {
  const ma = String(maTem == null ? '' : maTem).trim();
  const s = suffix != null && suffix !== '' ? `-${suffix}` : '';
  if (prefix == null || prefix === '') return `${ma}${s}`;
  // Mã ERP → THAY 2 số đầu (mã vẫn đúng 12 số để máy quét ERP đọc được).
  if (laMaErp(ma)) return `${String(prefix)}${ma.slice(2)}${s}`;
  return `${prefix}-${ma}${s}`; // mã cũ `TEM00123` → nối bằng gạch như trước
}

// Đưa mã vừa quét về ĐÚNG `ma_tem` đang lưu trong bảng `tem`, để tra cứu.
//   · '162608057689'   → '152608057689'  (mã ERP: mọi công đoạn quy về tiền tố gốc 15)
//   · '172608057689-2' → '152608057689'  (bỏ hậu tố lần giao)
//   · '17-TEM00030-1'  → 'TEM00030'      (mã cũ)
function baseMaTem(code) {
  const c = String(code || '').trim().replace(/-\d+$/, '');
  if (laMaErp(c)) return `15${c.slice(2)}`;
  return c.replace(/^\d+-/, '');
}

// Chuẩn hóa TỪ KHÓA TÌM KIẾM tem: người dùng cầm nhãn giấy in `16…`/`17…` gõ vào ô tìm thì phải ra
// đúng tem đang lưu `15…`. Bỏ 2 SỐ ĐẦU rồi để `ILIKE '%…%'` khớp phần còn lại ⇒ khớp mọi công đoạn
// mà không phải thêm nhánh OR nào vào SQL (query giữ nguyên độ nặng — quan trọng vì IPS, xem §9).
// Chuỗi khác (mã lệnh, code phần, mã cũ `TEM00123`…) trả nguyên vẹn.
const timTem = (search) => {
  const s = String(search == null ? '' : search).trim();
  return laMaErp(s) ? s.slice(2) : s;
};

module.exports = { temCode, baseMaTem, timTem, laMaErp, MA_ERP_RE };
