'use strict';

// ═════════════════════════════════════════════════════════════════════════════
// NỐI GEMINI (Google AI Studio — gói miễn phí) cho Agent MES THLA — 19/11/2026.
// Gọi THẲNG REST `generateContent` bằng axios (KHÔNG dùng SDK @google/genai: bản mới đòi Node ≥ 22, máy chủ có thể cũ hơn).
// Key gửi qua header `x-goog-api-key` — nhận cả key kiểu cũ `AIza…` lẫn key kiểu mới `AQ.…` của AI Studio.
// Vòng gọi công cụ TỰ VIẾT: kiểm từng lượt, ghi nhật ký công cụ, chặn số vòng; vòng cuối ép `mode: NONE`.
// Công cụ lấy từ các MCP server nội bộ (`mcp/mcpNoiBo.js`).
// ═════════════════════════════════════════════════════════════════════════════

const axios = require('axios');
const AppError = require('../../utils/AppError');

const GOC = 'https://generativelanguage.googleapis.com/v1beta';

function loiGemini(e) {
  const st = (e.response && e.response.status) || 0;
  const g = (e.response && e.response.data && e.response.data.error) || {};
  const msg = String(g.message || e.message || '');
  const chiTiet = `${g.status || st || e.code || ''}`.trim();
  if (!e.response) {
    return new AppError(`Máy chủ không gọi ra được Google (${e.code || e.message}). Kiểm mạng / tường lửa tới generativelanguage.googleapis.com cổng 443.`,
      { status: 503, errorCode: 'AI_KHONG_GOI_DUOC' });
  }
  if (st === 429 || g.status === 'RESOURCE_EXHAUSTED') {
    return new AppError('Đã hết lượt miễn phí của Google cho lúc này. Đợi một lát (hoặc sang ngày mai) rồi hỏi lại.', { status: 429, errorCode: 'AI_HET_LUOT' });
  }
  if (st === 400 && /API key|API_KEY/i.test(msg)) {
    return new AppError('API key Gemini không hợp lệ — kiểm lại GEMINI_API_KEY trong backend/.env.', { status: 503, errorCode: 'AI_SAI_KEY' });
  }
  if (st === 401) {
    return new AppError(`Google không nhận API key (401 ${chiTiet}). Tạo key mới trong AI Studio, xóa key cũ không dùng, rồi thay GEMINI_API_KEY.`,
      { status: 503, errorCode: 'AI_SAI_KEY' });
  }
  if (st === 404) {
    return new AppError('Không tìm thấy model — kiểm lại AI_MODEL trong backend/.env (lấy tên từ danh sách model).', { status: 503, errorCode: 'AI_SAI_MODEL' });
  }
  if (st === 403) {
    return new AppError(`Google từ chối API key này (403 ${chiTiet}) — kiểm project và giới hạn của key.`, { status: 503, errorCode: 'AI_KEY_BI_CHAN' });
  }
  if (st >= 500) {
    return new AppError('Máy chủ Google đang lỗi, thử lại sau ít phút.', { status: 503, errorCode: 'AI_GOOGLE_LOI' });
  }
  return new AppError(`Gemini báo lỗi ${st}: ${msg.slice(0, 200)}`, { status: 503, errorCode: 'AI_KHONG_GOI_DUOC' });
}

function rutThamSo(args) {
  try {
    const s = JSON.stringify(args || {});
    return s.length > 600 ? `${s.slice(0, 600)}…` : JSON.parse(s);
  } catch (_) { return null; }
}

/** Khai báo công cụ MCP cho Gemini. Công cụ không tham số ⇒ BỎ `parameters` (Gemini từ chối OBJECT có properties rỗng). */
function khaiBaoCongCu(congCu) {
  return congCu.map((t) => {
    const s = t.inputSchema || {};
    const coThamSo = s.properties && Object.keys(s.properties).length > 0;
    return { name: t.name, description: t.description, ...(coThamSo ? { parameters: s } : {}) };
  });
}

async function goiGemini(cfg, body) {
  try {
    const res = await axios.post(`${GOC}/models/${encodeURIComponent(cfg.model)}:generateContent`, body, {
      headers: { 'x-goog-api-key': cfg.apiKey, 'Content-Type': 'application/json' },
      timeout: cfg.timeoutMs,
    });
    return res.data || {};
  } catch (e) {
    throw loiGemini(e);
  }
}

/**
 * Trả lời 1 câu hỏi có gọi công cụ.
 * @returns {{ text, buoc: Array, tokenVao, tokenRa }}
 */
async function traLoi({ cfg, heThong, lichSu, cauHoi, mcp }) {
  const khaiBao = khaiBaoCongCu(mcp.congCu);
  const coso = {
    systemInstruction: { parts: [{ text: heThong }] },
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
    ...(khaiBao.length ? { tools: [{ functionDeclarations: khaiBao }] } : {}),
  };
  const contents = [
    ...lichSu.map((m) => ({ role: m.vai_tro === 'AI' ? 'model' : 'user', parts: [{ text: m.noi_dung }] })),
    { role: 'user', parts: [{ text: cauHoi }] },
  ];

  const buoc = [];
  let tokenVao = 0;
  let tokenRa = 0;
  for (let vong = 0; vong <= cfg.soVongToiDa; vong += 1) {
    const vongCuoi = vong === cfg.soVongToiDa;
    const data = await goiGemini(cfg, {
      ...coso,
      contents,
      ...(vongCuoi && khaiBao.length ? { toolConfig: { functionCallingConfig: { mode: 'NONE' } } } : {}),
    });
    const u = data.usageMetadata || {};
    tokenVao += u.promptTokenCount || 0;
    tokenRa += (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);

    const ung = (data.candidates && data.candidates[0]) || {};
    const parts = (ung.content && ung.content.parts) || [];
    const goi = parts.filter((p) => p.functionCall).map((p) => p.functionCall);

    if (!goi.length || vongCuoi) {
      let text = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('').trim();
      if (!text) {
        const chan = ung.finishReason === 'SAFETY' || (data.promptFeedback && data.promptFeedback.blockReason);
        text = chan
          ? 'Câu này bị bộ lọc an toàn của Google chặn. Anh/chị diễn đạt lại giúp tôi nhé.'
          : 'Tôi chưa tổng hợp được câu trả lời sau các bước tra cứu. Anh/chị hỏi cụ thể hơn (ngày, trạm, mã) giúp tôi nhé.';
      }
      return { text, buoc, tokenVao, tokenRa };
    }

    // Gửi lại NGUYÊN nội dung model (giữ cả chữ ký suy nghĩ nếu có) rồi kèm kết quả công cụ.
    contents.push({ role: 'model', parts });
    const phanHoi = [];
    for (const g of goi) {
      const t0 = Date.now();
      let kq;
      try { kq = await mcp.goi(g.name, g.args || {}); } catch (e) { kq = { loi: true, text: JSON.stringify({ loi: e.message }) }; }
      buoc.push({ ten: g.name, may_chu: mcp.mayChuCua(g.name), tham_so: rutThamSo(g.args), loi: kq.loi || undefined, ms: Date.now() - t0 });
      phanHoi.push({ functionResponse: { ...(g.id ? { id: g.id } : {}), name: g.name, response: kq.loi ? { error: kq.text } : { output: kq.text } } });
    }
    contents.push({ role: 'user', parts: phanHoi });
  }
  return { text: 'Tôi chưa tổng hợp được câu trả lời.', buoc, tokenVao, tokenRa };
}

module.exports = { traLoi, khaiBaoCongCu };
