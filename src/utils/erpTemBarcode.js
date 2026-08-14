'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// LẤY MÃ TEM (barcode) TỪ ERP — thay cho mã tự sinh `TEM00001` của MES.
//
// API: GET {ERP_BARCODE_TEM_URL} → { "success": true, "barcode": "152608057689" }
// Mã 12 chữ số, **2 SỐ ĐẦU ĐÃ LÀ TIỀN TỐ CÔNG ĐOẠN `15`** (KCS đạt). Khi in tem công đoạn khác thì
// ĐỔI 2 SỐ ĐẦU: `16` = chuyển sửa · `17` = sửa đạt để giao · `13` = hàng gia công về
// (xem `utils/temPrefix.js` — dùng chung với FE `printTemLabel.js`).
//
// ⚠⚠ MỖI LẦN GỌI LÀ TIÊU MỘT SỐ (đo thật: 2 lần gọi liên tiếp ra …7728 rồi …7729) ⇒
//   · gọi ĐÚNG 1 lần cho mỗi tem TẠO MỚI; in lại tem KHÔNG gọi (giữ nguyên `ma_tem`);
//   · gọi TRƯỚC khi mở transaction, KHÔNG gọi bên trong — giữ transaction hở suốt thời gian chờ HTTP
//     sẽ khóa bảng `tem` rất lâu, mà lỗi mạng còn làm abort cả transaction.
//   · transaction rollback thì số đã lấy bị bỏ phí (thủng dãy) — chấp nhận được.
// ─────────────────────────────────────────────────────────────────────────────

const axios = require('axios');
const env = require('../config/env');
const AppError = require('./AppError');
const { apiBat } = require('./caiDatApi');

const BARCODE_RE = /^\d{12}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Proxy giống hệt `erpsync.service` — undefined thì axios tự đọc HTTP_PROXY/HTTPS_PROXY từ env.
function erpProxy() {
  if (!env.erp.proxyUrl) return undefined;
  try {
    const u = new URL(env.erp.proxyUrl);
    return { host: u.hostname, port: Number(u.port) || 80, protocol: u.protocol.replace(':', '') };
  } catch { return undefined; }
}

async function goiMotLan() {
  const url = env.erp.barcodeTemUrl;
  // ⚠ LOG CẢ URL: lỗi production 2026-08-11 (gọi nhầm host LAN) mất rất lâu mới tìm ra vì thông điệp
  //   lỗi chỉ ghi "timeout" mà không nói đang gọi ĐI ĐÂU.
  console.log(`[tem-barcode] → GET ${url} (timeout ${Math.round(env.erp.barcodeTemTimeoutMs / 1000)}s)`);
  const res = await axios.get(url, {
    timeout: env.erp.barcodeTemTimeoutMs,
    headers: { Accept: 'application/json', ...(env.erp.apiHeaders || {}) },
    proxy: erpProxy(),
    validateStatus: () => true,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`ERP trả về HTTP ${res.status}`);
  const body = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  if (!body || body.success === false) throw new Error(body?.message || 'ERP trả về success=false');
  const bc = String(body.barcode == null ? '' : body.barcode).trim();
  // Chặn mã rác NGAY tại đây: `ma_tem` là khóa UNIQUE + in lên nhãn giấy, sai là hỏng cả lô.
  if (!BARCODE_RE.test(bc)) throw new Error(`Mã ERP trả về không đúng định dạng 12 chữ số: "${bc}"`);
  return bc;
}

// Lấy 1 mã tem. THỬ LẠI vài lần khi lỗi (mạng chập chờn / ERP bận), hết lượt mới chặn và báo rõ —
// theo chốt nghiệp vụ 07/08/2026: không lùi về mã `TEM…` cũ, để mọi tem đều có barcode ERP thật.
// ⚠⚠ TRẢ `null` KHI API BỊ TẮT ở Hệ thống > Cài đặt API (mig 083) — KHÔNG ném lỗi.
// Bên gọi thấy `null` thì tự sinh mã `TEM00123` bằng `production.repository.nextMaTem*`.
// (Chốt 2026-08-14 — nới chốt cũ 07/08 "không lùi về mã cũ": chốt đó vẫn giữ nguyên cho ca ERP
//  LỖI, còn đây là người dùng CHỦ ĐỘNG tắt, biết rõ hệ quả là tem không quét được ở ERP.)
async function layBarcodeTem() {
  if (!(await apiBat('ERP_BARCODE_TEM'))) {
    console.log('[tem-barcode] ⏸ API đang TẮT (Hệ thống > Cài đặt API) — MES tự sinh mã tem');
    return null;
  }
  const soLan = Math.max(1, env.erp.barcodeTemRetry);
  let loiCuoi;
  for (let i = 1; i <= soLan; i += 1) {
    try {
      return await goiMotLan();
    } catch (e) {
      loiCuoi = e;
      if (i < soLan) {
        const cho = 1000 * i; // 1s, 2s, 3s...
        console.warn(`[tem-barcode] ⟳ Lấy mã tem lỗi (lần ${i}/${soLan}), thử lại sau ${cho / 1000}s: ${e.message}`);
        await sleep(cho);
      }
    }
  }
  console.error(`[tem-barcode] ✗ Không lấy được mã tem sau ${soLan} lần (${env.erp.barcodeTemUrl}): ${loiCuoi && loiCuoi.message}`);
  throw new AppError(
    `Không lấy được mã tem từ ERP (đã thử ${soLan} lần, ${env.erp.barcodeTemUrl}): ${loiCuoi && loiCuoi.message}. `
    + 'Kiểm tra kết nối tới ERP rồi bấm in lại — tem CHƯA được tạo.',
    { status: 503, errorCode: 'ERP_BARCODE_TEM' }
  );
}

// Lấy NHIỀU mã (lệnh gom set in N tem 1 lượt). Lấy TUẦN TỰ để không bắn song song vào ERP;
// lỗi giữa chừng thì ném luôn — chưa tem nào được tạo nên không có gì phải dọn.
// ⚠ Trả `null` (KHÔNG phải mảng null) khi API bị tắt — bên gọi tự sinh đủ N mã.
async function layNhieuBarcodeTem(n) {
  if (!(await apiBat('ERP_BARCODE_TEM'))) {
    console.log(`[tem-barcode] ⏸ API đang TẮT — MES tự sinh ${n} mã tem`);
    return null;
  }
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(await layBarcodeTem());
  return out;
}

module.exports = { layBarcodeTem, layNhieuBarcodeTem, BARCODE_RE };
