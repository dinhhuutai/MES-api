'use strict';

// Suy TÊN THIẾT BỊ dễ đọc từ User-Agent để hiện ở trang "Phiên đăng nhập" — vd "Windows · Chrome",
// "iPhone · Safari", "Android · Chrome".
//
// ⚠ CỐ Ý KHÔNG dùng thư viện phân tích UA: chỉ cần đủ để người quản lý NHẬN RA máy nào là máy nào
//   (kèm IP + giờ đăng nhập ở cột bên), không cần chính xác tới từng phiên bản. UA còn nguyên văn
//   trong `phien_dang_nhap.user_agent` nếu cần tra kỹ.
// ⚠ Thứ tự kiểm QUAN TRỌNG: Edge/Opera cũng mang chữ "Chrome", iPad mang "Macintosh" ở iPadOS mới,
//   nên phải xét cái đặc thù TRƯỚC.

function heDieuHanh(ua) {
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  if (/Windows NT/i.test(ua)) return 'Windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return '';
}

function trinhDuyet(ua) {
  if (/Edg[eA]?\//i.test(ua)) return 'Edge';
  if (/OPR\/|Opera/i.test(ua)) return 'Opera';
  if (/CriOS/i.test(ua)) return 'Chrome';          // Chrome trên iOS
  if (/FxiOS/i.test(ua)) return 'Firefox';         // Firefox trên iOS
  if (/Firefox\//i.test(ua)) return 'Firefox';
  if (/Chrome\//i.test(ua)) return 'Chrome';
  if (/Safari\//i.test(ua)) return 'Safari';
  return '';
}

// Trả chuỗi ngắn (≤150 ký tự — vừa cột `thiet_bi`). Không nhận dạng được thì trả 'Không rõ'.
function tenThietBi(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return 'Không rõ';
  const os = heDieuHanh(ua);
  const br = trinhDuyet(ua);
  // PWA "Thêm vào màn hình chính" trên iOS/Android không có dấu hiệu chắc chắn trong UA ⇒ không đoán.
  const ten = [os, br].filter(Boolean).join(' · ');
  return (ten || 'Không rõ').slice(0, 150);
}

// IP client — ưu tiên `x-forwarded-for` vì backend chạy sau reverse proxy.
function ipCuaRequest(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim().slice(0, 60);
  return String(req.ip || req.socket?.remoteAddress || '').slice(0, 60) || null;
}

module.exports = { tenThietBi, ipCuaRequest };
