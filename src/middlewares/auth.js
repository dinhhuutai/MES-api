'use strict';

const { verify } = require('../utils/jwt');
const { fail } = require('../utils/response');
const { lyDoChan } = require('../utils/phienCache');
const phienRepo = require('../modules/phien/phien.repository');

// ─── Ghi "hoạt động cuối" của phiên, GIÃN CÁCH ───────────────────────────────
// Cột `phien_dang_nhap.tg_hoat_dong_cuoi` chỉ để người quản lý biết máy nào còn dùng, máy nào bỏ
// quên ⇒ KHÔNG cần chính xác tới từng giây. Ghi mỗi request là thêm 1 round-trip DB vào MỌI request
// (nút cổ chai của hệ này — §11.5), nên chỉ ghi tối đa 1 lần / CHAM_MS cho mỗi phiên và ghi NGẦM
// (không `await`) để không thêm độ trễ.
const CHAM_MS = 2 * 60 * 1000;
const chamLuc = new Map();   // jti -> mốc ghi gần nhất
function chamPhienGianCach(jti) {
  if (!jti) return;
  const now = Date.now();
  if (now - (chamLuc.get(jti) || 0) < CHAM_MS) return;
  chamLuc.set(jti, now);
  // Bản đồ có thể phình theo số phiên — dọn khi quá lớn (chỉ là cache chống ghi dày).
  if (chamLuc.size > 5000) chamLuc.clear();
  phienRepo.chamPhien(jti).catch(() => {});
}

// Xác thực JWT từ header Authorization: Bearer <token>.
// Gắn req.user = { id, username, roles, permissions, jti }.
module.exports = async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return fail(res, 'Chưa đăng nhập', 'UNAUTHENTICATED', [], 401);
  }
  let payload;
  try {
    payload = verify(token);
  } catch (err) {
    return fail(res, 'Token không hợp lệ hoặc đã hết hạn', 'INVALID_TOKEN', [], 401);
  }

  // ĐÃ BỊ ĐĂNG XUẤT TỪ XA? (mig 081) — trả 401 để FE tự xóa token và về màn đăng nhập
  // (`axiosClient` đã dispatch logout ở mọi 401).
  // ⚠ FAIL-OPEN: thiếu migration / DB lỗi ⇒ `lyDoChan` trả null ⇒ không chặn ai. Xem `phienCache`.
  try {
    const chan = await lyDoChan(payload);
    if (chan) {
      return fail(res, 'Tài khoản đã được đăng xuất khỏi thiết bị này. Vui lòng đăng nhập lại.',
        chan, [], 401);
    }
  } catch (e) { /* fail-open — không chặn vì lỗi kiểm tra phiên */ }

  req.user = {
    id: payload.sub,
    username: payload.username,
    roles: payload.roles || [],
    permissions: payload.permissions || [],
    jti: payload.jti || null,
  };
  chamPhienGianCach(payload.jti);
  return next();
};
