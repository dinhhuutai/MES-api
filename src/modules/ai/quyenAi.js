'use strict';

// ═════════════════════════════════════════════════════════════════════════════
// QUYỀN AGENT MES THLA (mig 138) — NGUỒN LUẬT DUY NHẤT phía BE (gương FE: `/api/ai/trang-thai` trả sẵn cờ).
// ⚠⚠ QUYỀN AI KHÔNG ĐI THEO '*': vai trò ADMIN và cả KHACH (= '*' + CHI_XEM) đều mang '*', nếu để '*' mở
//    luôn quyền AI thì tài khoản khách dùng chung cũng gọi được AI (tốn lượt, lộ dữ liệu ra Google).
//    ⇒ Chỉ tính quyền GHI TƯỜNG MINH: vai trò `AI_AGENT` / `AI_PHAN_TICH` hoặc cấp riêng ở trang Người dùng.
// ⚠ ĐỌC TƯƠI TỪ DB (không đọc JWT): quyền trong JWT chốt lúc đăng nhập ⇒ gán vai trò AI xong người dùng
//    phải đăng xuất mới dùng được. Đọc DB (cache 30 giây) thì gán xong tối đa 30 giây là thấy robot.
// ═════════════════════════════════════════════════════════════════════════════

const authRepo = require('../auth/auth.repository');
const { fail } = require('../../utils/response');

const QUYEN_AI = Object.freeze({ DUNG: 'AI_AGENT', PHAN_TICH: 'AI_AGENT_PHAN_TICH' });
const CACHE_MS = 30 * 1000;
const cache = new Map(); // userId -> { tg, perms }

async function quyenTuoi(userId) {
  const c = cache.get(userId);
  if (c && Date.now() - c.tg < CACHE_MS) return c.perms;
  const perms = await authRepo.getPermissions(userId);
  if (cache.size > 2000) cache.clear();
  cache.set(userId, { tg: Date.now(), perms });
  return perms;
}

/** { dung, phanTich, perms } — quyền AI của người dùng, chỉ tính quyền tường minh. */
async function quyenAiCua(userId) {
  const perms = await quyenTuoi(userId);
  const dung = perms.includes(QUYEN_AI.DUNG) || perms.includes(QUYEN_AI.PHAN_TICH);
  return { dung, phanTich: perms.includes(QUYEN_AI.PHAN_TICH), perms };
}

/** Middleware: chặn 403 người không có quyền AI tường minh. Gắn `req.quyenAi`. */
function canQuyenAi() {
  return async function (req, res, next) {
    try {
      const q = await quyenAiCua(req.user.id);
      if (!q.dung) {
        return fail(res, 'Tài khoản chưa được cấp vai trò Agent AI', 'KHONG_CO_QUYEN_AI', [QUYEN_AI.DUNG], 403);
      }
      req.quyenAi = q;
      return next();
    } catch (e) {
      return next(e);
    }
  };
}

module.exports = { QUYEN_AI, quyenAiCua, canQuyenAi };
