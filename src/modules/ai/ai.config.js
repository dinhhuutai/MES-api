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
//   AI_MODEL_DU_PHONG=a,b       model dự phòng (ngăn dấu phẩy) khi model chính bị Google báo QUÁ TẢI / treo / hết lượt
//                               (gói miễn phí model Flash mới hay bị 503 "high demand"). Thiếu ⇒ MODEL_DU_PHONG_MAC_DINH.
//                               Ghi `AI_MODEL_DU_PHONG=-` để TẮT dự phòng.
//   AI_TIMEOUT_MS=40000         chờ tối đa 1 lượt gọi Google (vòng đầu có dự phòng chỉ chờ ≤ 20 giây rồi đổi model)
// Đọc lại mỗi lần gọi (rẻ) ⇒ sửa .env rồi `pm2 restart mes` là ăn.
// ═════════════════════════════════════════════════════════════════════════════

// Dòng Flash-Lite: nhẹ, ít bị nghẽn ở gói miễn phí (đo 19/11/2026: Flash 3.x đều 503/treo 60 s, Flash-Lite 1–4 s).
const MODEL_DU_PHONG_MAC_DINH = ['gemini-3.1-flash-lite', 'gemini-flash-lite-latest'];

const soNguyen = (v, macDinh, min, max) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return macDinh;
  return Math.min(max, Math.max(min, n));
};

const chuanTenModel = (s) => String(s || '').trim().replace(/^models\//, '');

function cauHinhAi() {
  const e = process.env;
  const nhaCungCap = String(e.AI_NHA_CUNG_CAP || 'gemini').trim().toLowerCase();
  const model = chuanTenModel(e.AI_MODEL);
  const apiKey = String(e.GEMINI_API_KEY || '').trim();
  const duPhongEnv = String(e.AI_MODEL_DU_PHONG || '').trim();
  const duPhong = (duPhongEnv === '-' ? [] : duPhongEnv ? duPhongEnv.split(',') : MODEL_DU_PHONG_MAC_DINH)
    .map(chuanTenModel).filter(Boolean);
  return {
    bat: ['1', 'true', 'on'].includes(String(e.AI_BAT || '0').trim().toLowerCase()),
    nhaCungCap,
    model,
    // Thứ tự thử: model chính trước, rồi dự phòng (bỏ trùng).
    dsModel: [...new Set([model, ...duPhong].filter(Boolean))],
    apiKey,
    daCauHinh: nhaCungCap === 'gemini' && !!model && !!apiKey,
    db: {
      user: String(e.AI_DB_USER || '').trim(),
      password: String(e.AI_DB_PASSWORD || ''),
    },
    gioiHanNgay: soNguyen(e.AI_GIOI_HAN_CAU_NGAY, 20, 1, 1000),
    soVongToiDa: soNguyen(e.AI_SO_VONG_TOI_DA, 6, 1, 12),
    timeoutMs: soNguyen(e.AI_TIMEOUT_MS, 40000, 10000, 180000),
  };
}

module.exports = { cauHinhAi };
