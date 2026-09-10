'use strict';

// ═════════════════════════════════════════════════════════════════════════════
// TÀI KHOẢN CHỈ XEM (mig 096) — NGUỒN LUẬT DUY NHẤT
//
// Quyền `CHI_XEM` KHÔNG mở thêm gì cả; nó là **CỜ CHẶN**: tài khoản mang cờ này
// đọc được mọi thứ nhưng KHÔNG ghi được gì.
//
// ⚠⚠ CHỐT CHẶN ĐẶT Ở `middlewares/auth.js` — MỘT chỗ duy nhất, phủ 100% route đã
//    xác thực. Đã đối chiếu: 33/34 module dùng `router.use(auth)`, module còn lại
//    (`auth.routes.js`) khai `auth` cho từng route và route DUY NHẤT không qua
//    `auth` là `POST /login`. ⇒ Không thể sót một endpoint ghi nào.
//    **ĐỪNG rải kiểm tra `CHI_XEM` xuống từng service** — thêm route mới là quên ngay.
//
// ⚠⚠ CHẶN THEO PHƯƠNG THỨC HTTP, KHÔNG theo danh sách endpoint: hệ có 198 route ghi
//    và còn tăng. Liệt kê từng cái là chắc chắn sót; chặn POST/PUT/PATCH/DELETE rồi
//    chừa vài ngoại lệ thì route mới **mặc định an toàn**.
// ═════════════════════════════════════════════════════════════════════════════

const MA_QUYEN_CHI_XEM = 'CHI_XEM';

const PHUONG_THUC_GHI = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// ─── NGOẠI LỆ: phương thức ghi nhưng KHÔNG đụng dữ liệu nghiệp vụ ────────────
// ⚠ Thêm vào đây phải tự hỏi: "endpoint này có làm đổi dữ liệu người khác nhìn thấy
//   không?" — nếu có thì KHÔNG được cho vào, dù nó tiện.
// ⚠ So trên `req.originalUrl` đã cắt query string ⇒ mẫu phải có tiền tố `/api`.
const NGOAI_LE = [
  // Tự đăng xuất — luôn phải cho, nếu không thì khách không thoát được phiên.
  { method: 'POST', re: /^\/api\/auth\/logout\/?$/ },

  // Kết xuất báo cáo: POST nhưng CHỈ ĐỌC (tính số liệu rồi trả về). Đây là đường
  // của nút "Xem trước" và "Xuất Excel" ở Báo cáo ⇒ chặn là mất luôn việc tải Excel.
  { method: 'POST', re: /^\/api\/bao-cao\/[^/]+\/render\/?$/ },

  // Thông báo: đánh dấu đã đọc + bật/tắt nhận thông báo trên THIẾT BỊ của chính mình.
  // Chỉ đụng dữ liệu riêng của người đang đăng nhập, không ai khác thấy.
  { method: 'POST', re: /^\/api\/thong-bao\/doc\/?$/ },
  { method: 'POST', re: /^\/api\/thong-bao\/push\/(dang-ky|huy)\/?$/ },
  { method: 'PUT', re: /^\/api\/thong-bao\/cua-toi\/?$/ },
];

// ⚠ CỐ Ý KHÔNG cho vào ngoại lệ (người dùng đã chốt 09/09/2026):
//   · `PATCH /api/auth/me` · `POST /api/auth/me/avatar` · `DELETE /api/auth/me/avatar`
//   · `POST /api/auth/me/doi-mat-khau`
//   Tài khoản khách dùng CHUNG cho nhiều người — một người đổi mật khẩu là những
//   người còn lại mất đường vào. Muốn đổi thì quản trị viên đổi ở trang Người dùng.
//   · `POST /api/cai-dat-api/thu/:ma` — chỉ ping ERP, không ghi, nhưng là thao tác
//   quản trị hạ tầng; khách không có việc gì phải bấm.

function laChiXem(permissions) {
  return Array.isArray(permissions) && permissions.includes(MA_QUYEN_CHI_XEM);
}

function laPhuongThucGhi(method) {
  return PHUONG_THUC_GHI.has(String(method || '').toUpperCase());
}

function duocPhepNgoaiLe(method, url) {
  const m = String(method || '').toUpperCase();
  const duong = String(url || '').split('?')[0];
  return NGOAI_LE.some((x) => x.method === m && x.re.test(duong));
}

// Trả TRUE nếu request này phải bị chặn vì tài khoản đang ở chế độ chỉ xem.
// `req.user.permissions` đã được `auth` đọc từ JWT trước khi gọi hàm này.
function canChan(req) {
  if (!laChiXem(req.user && req.user.permissions)) return false;
  if (!laPhuongThucGhi(req.method)) return false;
  return !duocPhepNgoaiLe(req.method, req.originalUrl);
}

module.exports = {
  MA_QUYEN_CHI_XEM,
  laChiXem,
  laPhuongThucGhi,
  duocPhepNgoaiLe,
  canChan,
};
