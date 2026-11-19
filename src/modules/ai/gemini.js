'use strict';

// ═════════════════════════════════════════════════════════════════════════════
// NỐI GEMINI (Google AI Studio — gói miễn phí) cho Agent MES THLA — 19/11/2026.
// Gọi THẲNG REST `generateContent` bằng axios (KHÔNG dùng SDK @google/genai: bản mới đòi Node ≥ 22, máy chủ có thể cũ hơn).
// Key gửi qua header `x-goog-api-key` — nhận cả key kiểu cũ `AIza…` lẫn key kiểu mới `AQ.…` của AI Studio.
// Vòng gọi công cụ TỰ VIẾT: kiểm từng lượt, ghi nhật ký công cụ, chặn số vòng; vòng cuối ép `mode: NONE`.
// Công cụ lấy từ các MCP server nội bộ (`mcp/mcpNoiBo.js`).
// MODEL DỰ PHÒNG: Google báo quá tải (503 "high demand") / treo / hết lượt / model không còn ⇒ thử model kế tiếp
// trong `cfg.dsModel`; model lỗi được "cho nghỉ" NGHI_MS để câu sau đi thẳng model đang chạy được.
// ═════════════════════════════════════════════════════════════════════════════

const axios = require('axios');
const AppError = require('../../utils/AppError');

const GOC = 'https://generativelanguage.googleapis.com/v1beta';
const NGHI_MS = 3 * 60 * 1000;
const TIMEOUT_THU_NHANH_MS = 20000; // vòng đầu còn model dự phòng ⇒ không chờ lâu hơn
// Chữ ký suy nghĩ Google cho phép khi lịch sử gọi công cụ đến từ model KHÁC (đổi model giữa chừng).
const CHU_KY_BO_QUA = 'skip_thought_signature_validator';
const nghiDen = new Map(); // model → mốc hết nghỉ (ms)

function loiGemini(e, model) {
  const st = (e.response && e.response.status) || 0;
  const g = (e.response && e.response.data && e.response.data.error) || {};
  const msg = String(g.message || e.message || '');
  const chiTiet = `${g.status || st || e.code || ''}`.trim();
  if (!e.response) {
    if (e.code === 'ECONNABORTED' || /timeout/i.test(String(e.message))) {
      return new AppError(`Google trả lời quá chậm (model ${model} — thường do model đang quá tải). Thử lại sau ít phút.`,
        { status: 503, errorCode: 'AI_GOOGLE_CHAM' });
    }
    return new AppError(`Máy chủ không gọi ra được Google (${e.code || e.message}). Kiểm mạng / tường lửa tới generativelanguage.googleapis.com cổng 443.`,
      { status: 503, errorCode: 'AI_KHONG_GOI_DUOC' });
  }
  if (st === 503 || g.status === 'UNAVAILABLE') {
    return new AppError(`Google đang quá tải model ${model} (gói miễn phí). Thử lại sau ít phút.`, { status: 503, errorCode: 'AI_GOOGLE_QUA_TAI' });
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
    return new AppError(`Máy chủ Google đang lỗi (${chiTiet}: ${msg.slice(0, 120)}), thử lại sau ít phút.`, { status: 503, errorCode: 'AI_GOOGLE_LOI' });
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

async function goiGemini(cfg, model, body, timeoutMs) {
  try {
    const res = await axios.post(`${GOC}/models/${encodeURIComponent(model)}:generateContent`, body, {
      headers: { 'x-goog-api-key': cfg.apiKey, 'Content-Type': 'application/json' },
      timeout: timeoutMs,
    });
    return res.data || {};
  } catch (e) {
    throw loiGemini(e, model);
  }
}

/** Lỗi đáng thử model khác: quá tải / chậm / hết lượt (hạn mức tính theo model) / Google lỗi / model không còn. Lỗi key thì không. */
const DOI_MODEL_KHI = new Set(['AI_GOOGLE_QUA_TAI', 'AI_GOOGLE_CHAM', 'AI_HET_LUOT', 'AI_GOOGLE_LOI', 'AI_SAI_MODEL']);

/** Thứ tự thử: model đang dùng trong câu này (nếu có) → các model không bị nghỉ → các model đang nghỉ (thử nốt). */
function thuTuModel(cfg, dangDung) {
  const bayGio = Date.now();
  const ds = cfg.dsModel && cfg.dsModel.length ? cfg.dsModel : [cfg.model];
  const khoe = ds.filter((m) => !(nghiDen.get(m) > bayGio));
  const nghi = ds.filter((m) => nghiDen.get(m) > bayGio);
  const ra = [...khoe, ...nghi];
  return dangDung ? [dangDung, ...ra.filter((m) => m !== dangDung)] : ra;
}

/** Lịch sử gọi công cụ do model khác sinh ⇒ thay chữ ký suy nghĩ bằng chữ ký bỏ qua (Google không nhận chữ ký chéo model). */
function doiChuKy(contents) {
  return contents.map((c) => (c.role !== 'model' ? c : {
    ...c,
    parts: c.parts.map((p) => (p.thoughtSignature ? { ...p, thoughtSignature: CHU_KY_BO_QUA } : p)),
  }));
}

/**
 * Gọi 1 vòng, tự đổi model khi gặp lỗi tạm thời. `phien.model` = model đang dùng trong câu hỏi (dính model chạy được).
 * Hết model ⇒ ném lỗi cuối, kèm danh sách đã thử.
 */
async function goiCoDuPhong(cfg, body, phien, vong) {
  const ds = thuTuModel(cfg, phien.model);
  const daThu = [];
  let loiCuoi = null;
  for (let i = 0; i < ds.length; i += 1) {
    const model = ds[i];
    const conDuPhong = i < ds.length - 1;
    const timeout = vong === 0 && conDuPhong ? Math.min(cfg.timeoutMs, TIMEOUT_THU_NHANH_MS) : cfg.timeoutMs;
    const doiGiuaChung = vong > 0 && phien.model && model !== phien.model;
    const than = doiGiuaChung ? { ...body, contents: doiChuKy(body.contents) } : body;
    try {
      const data = await goiGemini(cfg, model, than, timeout);
      if (phien.model && phien.model !== model) phien.doiModel = true;
      phien.model = model;
      nghiDen.delete(model);
      return data;
    } catch (e) {
      daThu.push(model);
      loiCuoi = e;
      if (!DOI_MODEL_KHI.has(e.errorCode)) throw e;
      nghiDen.set(model, Date.now() + NGHI_MS);
      if (conDuPhong) console.warn(`[AI] ${model} lỗi ${e.errorCode} ⇒ thử ${ds[i + 1]}`);
    }
  }
  if (loiCuoi && daThu.length > 1) {
    loiCuoi.message = `${loiCuoi.message} (đã thử ${daThu.length} model: ${daThu.join(', ')})`;
  }
  throw loiCuoi;
}

/**
 * Trả lời 1 câu hỏi có gọi công cụ.
 * @returns {{ text, buoc: Array, tokenVao, tokenRa, model }} — `model` = model thật đã trả lời (có thể là dự phòng)
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
  const phien = { model: null, doiModel: false };
  let tokenVao = 0;
  let tokenRa = 0;
  for (let vong = 0; vong <= cfg.soVongToiDa; vong += 1) {
    const vongCuoi = vong === cfg.soVongToiDa;
    const data = await goiCoDuPhong(cfg, {
      ...coso,
      contents,
      ...(vongCuoi && khaiBao.length ? { toolConfig: { functionCallingConfig: { mode: 'NONE' } } } : {}),
    }, phien, vong);
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
      return { text, buoc, tokenVao, tokenRa, model: phien.model };
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
  return { text: 'Tôi chưa tổng hợp được câu trả lời.', buoc, tokenVao, tokenRa, model: phien.model };
}

module.exports = { traLoi, khaiBaoCongCu };
