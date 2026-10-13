'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// TRA HỌ TÊN → MÃ SỐ NHÂN VIÊN (= `nguoi_dung.ten_dang_nhap`, ERP tạo tài khoản theo mã nhân viên).
//
// Dùng cho các trường NGƯỜI gửi sang ERP mà MES chỉ lưu HỌ TÊN (12/10/2026, người dùng chốt "các câu gửi dữ
// liệu xuống ERP đều đổi thành mã số nhân viên"): chuyền trưởng (`phieu_san_xuat.chuyen_truong`) và thợ in
// (`phan_cong_san_xuat.tho_in`) — 2 ô này lưu TÊN, lại cho gõ tay. Ca trưởng có sẵn `ca_truong_id` nên lấy
// thẳng từ tài khoản, không qua đây.
//
// Luật khớp: họ tên so KHÔNG phân biệt hoa/thường, khoảng trắng thừa, dạng Unicode dựng sẵn/tổ hợp.
//   · đúng 1 tài khoản ⇒ mã của tài khoản đó;
//   · nhiều tài khoản cùng họ tên ⇒ ưu tiên tài khoản ĐANG HOẠT ĐỘNG; vẫn > 1 ⇒ KHÔNG đoán (trả null) —
//     đo prod 12/10/2026: 2 cặp trùng họ tên / 313 tài khoản;
//   · không có tài khoản (tên gõ tay) ⇒ null. Bên gọi tự lùi về cách gửi cũ.
//
// ⚠ So trong JS chứ không `upper()` trong SQL: `upper()` của Postgres phụ thuộc collation của DB với chữ có dấu.
// ⚠ KHÔNG BAO GIỜ ném lỗi (chiều đẩy ERP chạy ngầm): đọc DB hỏng ⇒ dùng bảng đang nhớ, chưa có thì bảng rỗng
//   (= không tra được ai ⇒ gửi như cũ). Nhớ 60 s — danh sách tài khoản chỉ ~300 dòng.
// ─────────────────────────────────────────────────────────────────────────────
const { query } = require('../config/db');

const NHO_MS = 60 * 1000;
let bangNho = null;
let napLuc = 0;
let dangNap = null;

const chuanTen = (s) => String(s == null ? '' : s).normalize('NFC').trim().replace(/\s+/g, ' ').toUpperCase();

// Hàm thuần: danh sách tài khoản → Map(họ tên chuẩn → mã | null khi trùng họ tên không phân biệt được).
function dungBang(rows) {
  const hoatDong = new Map();
  const daTat = new Map();
  for (const r of rows || []) {
    const ten = chuanTen(r.ho_ten);
    const ma = String(r.ten_dang_nhap == null ? '' : r.ten_dang_nhap).trim();
    if (!ten || !ma) continue;
    const m = r.dang_hoat_dong === false ? daTat : hoatDong;
    if (!m.has(ten)) m.set(ten, new Set());
    m.get(ten).add(ma);
  }
  const bang = new Map();
  for (const ten of new Set([...hoatDong.keys(), ...daTat.keys()])) {
    const ds = hoatDong.get(ten) || daTat.get(ten);
    bang.set(ten, ds.size === 1 ? [...ds][0] : null);
  }
  return bang;
}

async function napBang() {
  if (bangNho && Date.now() - napLuc < NHO_MS) return bangNho;
  if (!dangNap) {
    dangNap = query('SELECT ho_ten, ten_dang_nhap, dang_hoat_dong FROM nguoi_dung')
      .then(({ rows }) => { bangNho = dungBang(rows); napLuc = Date.now(); return bangNho; })
      .catch((e) => {
        console.error(`[erp] ✗ Không đọc được danh sách tài khoản để tra mã số nhân viên: ${e.message}`);
        return bangNho || new Map();
      })
      .finally(() => { dangNap = null; });
  }
  return dangNap;
}

// Trả hàm tra đồng bộ `(họ tên) → mã số nhân viên | null` trên bảng vừa nạp.
async function boTraMaNhanVien() {
  const bang = await napBang();
  return (ten) => bang.get(chuanTen(ten)) || null;
}

module.exports = { boTraMaNhanVien, dungBang, chuanTen, _xoaNho: () => { bangNho = null; napLuc = 0; } };
