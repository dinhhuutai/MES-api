'use strict';

// ═════════════════════════════════════════════════════════════════════════════
// AGENT MES THLA — cấu hình đọc từ `backend/.env` (19/11/2026)
//   AI_BAT=1                    bật Agent (0/thiếu = tắt: robot vẫn hiện với người có quyền, hỏi thì báo "đang tắt")
//   AI_NHA_CUNG_CAP=gemini      nhà cung cấp model (hiện chỉ có gemini — `gemini.js`)
//   AI_MODEL=...                tên model (vd bản Flash ổn định lấy từ danh sách model của Google)
//   GEMINI_API_KEY=AIza...      key Google AI Studio (gói miễn phí)
//   AI_DB_USER / AI_DB_PASSWORD user PostgreSQL CHỈ ĐỌC (mig 138: mes_ai_doc) cho MCP `mes-db`; thiếu ⇒ tắt mes-db
//   AI_GIOI_HAN_CAU_NGAY=20     số câu hỏi tối đa / người / ngày (giữ trong hạn mức miễn phí của project Google)
//   AI_SO_VONG_TOI_DA=6         số vòng gọi công cụ tối đa trong 1 câu hỏi
// Đọc lại mỗi lần gọi (rẻ) ⇒ sửa .env rồi `pm2 restart mes` là ăn.
// ═════════════════════════════════════════════════════════════════════════════

const soNguyen = (v, macDinh, min, max) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return macDinh;
  return Math.min(max, Math.max(min, n));
};

function cauHinhAi() {
  const e = process.env;
  const nhaCungCap = String(e.AI_NHA_CUNG_CAP || 'gemini').trim().toLowerCase();
  const model = String(e.AI_MODEL || '').trim().replace(/^models\//, '');
  const apiKey = String(e.GEMINI_API_KEY || '').trim();
  return {
    bat: ['1', 'true', 'on'].includes(String(e.AI_BAT || '0').trim().toLowerCase()),
    nhaCungCap,
    model,
    apiKey,
    daCauHinh: nhaCungCap === 'gemini' && !!model && !!apiKey,
    db: {
      user: String(e.AI_DB_USER || '').trim(),
      password: String(e.AI_DB_PASSWORD || ''),
    },
    gioiHanNgay: soNguyen(e.AI_GIOI_HAN_CAU_NGAY, 20, 1, 1000),
    soVongToiDa: soNguyen(e.AI_SO_VONG_TOI_DA, 6, 1, 12),
    timeoutMs: soNguyen(e.AI_TIMEOUT_MS, 60000, 10000, 180000),
  };
}

module.exports = { cauHinhAi };
