'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// LẤY MÃ TEM (barcode) TỪ ERP — thay cho mã tự sinh `TEM00001` của MES.
//
// API: GET {ERP_BARCODE_TEM_15_URL} → { "success": true, "barcode": "152608057689" }
// Mã 12 chữ số, **2 SỐ ĐẦU LÀ TIỀN TỐ CÔNG ĐOẠN**.
//
// ⚠⚠⚠ BA DÃY SỐ ĐỘC LẬP, MỖI CÔNG ĐOẠN MỘT ENDPOINT (chốt 06/09/2026):
//   · `15` tem in ra ở chuyền           → GET /barcode-tem-15  (ERP đổi tên từ /barcode-tem, 16/09/2026)
//   · `17` tem SỬA ĐẠT (tem con mig 091)→ GET /barcode-tem-17
//   · `13` tem HÀNG GIA CÔNG VỀ          → GET /barcode-tem-13
//   Trước đây tem 17/13 KHÔNG xin mã: chúng lấy mã tem 15 rồi **thay 2 số đầu** ⇒ 2 nhãn giấy khác
//   công đoạn mang cùng 10 số đuôi, ERP không phân biệt được từng nhãn. Nay mỗi nhãn một mã thật.
// ⚠⚠ HỆ QUẢ PHẢI NHỚ: quan hệ "tem 17 này là hàng sửa đạt của tem 15 kia" **KHÔNG CÒN nằm trong
//   chuỗi mã** — nó nằm ở cột `tem.tem_goc_id` (mig 091). Tuyệt đối đừng suy quan hệ bằng
//   `baseMaTem()` nữa; tra mã quét thì dùng `maTemUngVien()` (thử ĐÚNG NGUYÊN VĂN trước).
//   `16` (nhãn hàng lỗi chuyển sửa) VẪN suy từ tem 15 — nó không phải dòng tem riêng.
// (xem `utils/temPrefix.js` — dùng chung với FE `printTemLabel.js`.)
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
const { ghiLog } = require('./erpApiLog');

const BARCODE_RE = /^\d{12}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mỗi tiền tố công đoạn ↔ 1 endpoint + 1 mã API để bật/tắt riêng ở *Hệ thống > Cài đặt API*.
// ⚠ Thêm công đoạn mới = khai thêm 1 dòng ở đây + 1 dòng ở `utils/caiDatApi.js` (DANH_MUC_API) +
//   1 dòng URL ở `config/env.js`. KHÔNG cần migration.
const API_THEO_TIEN_TO = {
  15: { ma: 'ERP_BARCODE_TEM', ten: 'tem in', url: () => env.erp.barcodeTemUrl },
  17: { ma: 'ERP_BARCODE_TEM_17', ten: 'tem sửa đạt', url: () => env.erp.barcodeTem17Url },
  13: { ma: 'ERP_BARCODE_TEM_13', ten: 'tem gia công về', url: () => env.erp.barcodeTem13Url },
};

// Proxy giống hệt `erpsync.service` — undefined thì axios tự đọc HTTP_PROXY/HTTPS_PROXY từ env.
function erpProxy() {
  if (!env.erp.proxyUrl) return undefined;
  try {
    const u = new URL(env.erp.proxyUrl);
    return { host: u.hostname, port: Number(u.port) || 80, protocol: u.protocol.replace(':', '') };
  } catch { return undefined; }
}

async function goiMotLan(url, tienTo) {
  // ⚠ LOG CẢ URL: lỗi production 2026-08-11 (gọi nhầm host LAN) mất rất lâu mới tìm ra vì thông điệp
  //   lỗi chỉ ghi "timeout" mà không nói đang gọi ĐI ĐÂU.
  console.log(`[tem-barcode] → GET ${url} (tiền tố ${tienTo}, timeout ${Math.round(env.erp.barcodeTemTimeoutMs / 1000)}s)`);
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
  // ⚠⚠ KIỂM 2 SỐ ĐẦU — endpoint nào phải trả đúng dãy của công đoạn đó. Lấy nhầm dãy (vd
  //   `/barcode-tem-17` trả `15…`) là **hỏng ngầm**: mã lưu 1 đằng, nhãn in ra `temCode(ma,17)` một
  //   nẻo, rồi quét không ra tem — đúng kiểu lỗi rất khó lần. Thà ném lỗi ngay lúc tích hợp.
  if (String(bc).slice(0, 2) !== String(tienTo)) {
    throw new Error(`ERP trả mã "${bc}" nhưng công đoạn này cần mã bắt đầu bằng ${tienTo} — sai endpoint?`);
  }
  return bc;
}

// Lấy 1 mã tem. THỬ LẠI vài lần khi lỗi (mạng chập chờn / ERP bận), hết lượt mới chặn và báo rõ —
// theo chốt nghiệp vụ 07/08/2026: không lùi về mã `TEM…` cũ, để mọi tem đều có barcode ERP thật.
// ⚠⚠ TRẢ `null` KHI API BỊ TẮT ở Hệ thống > Cài đặt API (mig 083) — KHÔNG ném lỗi.
// Bên gọi thấy `null` thì tự sinh mã `TEM00123` bằng `production.repository.nextMaTem*`.
// (Chốt 2026-08-14 — nới chốt cũ 07/08 "không lùi về mã cũ": chốt đó vẫn giữ nguyên cho ca ERP
//  LỖI, còn đây là người dùng CHỦ ĐỘNG tắt, biết rõ hệ quả là tem không quét được ở ERP.)
// ⚠ `tienTo` ∈ {15, 17, 13} — mỗi công đoạn một endpoint + một mã API bật/tắt riêng.
async function layBarcodeTemTienTo(tienTo, actorId = null) {
  const cfg = API_THEO_TIEN_TO[tienTo];
  if (!cfg) throw new Error(`Tiền tố tem không hợp lệ: ${tienTo}`);
  const url = cfg.url();
  if (!(await apiBat(cfg.ma))) {
    console.log(`[tem-barcode] ⏸ API ${cfg.ma} đang TẮT (Hệ thống > Cài đặt API) — bên gọi tự lo mã ${cfg.ten}`);
    return null;
  }
  const soLan = Math.max(1, env.erp.barcodeTemRetry);
  const batDau = Date.now();
  let loiCuoi;
  for (let i = 1; i <= soLan; i += 1) {
    try {
      const bc = await goiMotLan(url, tienTo);
      // ⚠ Ghi vết NGAY cả khi thành công — mã vừa lấy là một số ĐÃ TIÊU của ERP, phải tra lại được
      //   (kể cả khi transaction sau đó rollback làm thủng dãy). KHÔNG `await`: đây là bước phụ.
      ghiLog(cfg.ma, {
        thanhCong: true, idBanGhi: bc, maTem: bc, url,
        soLanThu: i, thoiGianMs: Date.now() - batDau, nhan: { barcode: bc }, actorId,
      });
      return bc;
    } catch (e) {
      loiCuoi = e;
      if (i < soLan) {
        const cho = 1000 * i; // 1s, 2s, 3s...
        console.warn(`[tem-barcode] ⟳ Lấy mã ${cfg.ten} lỗi (lần ${i}/${soLan}), thử lại sau ${cho / 1000}s: ${e.message}`);
        await sleep(cho);
      }
    }
  }
  console.error(`[tem-barcode] ✗ Không lấy được mã ${cfg.ten} sau ${soLan} lần (${url}): ${loiCuoi && loiCuoi.message}`);
  ghiLog(cfg.ma, {
    thanhCong: false, idBanGhi: '-', url,
    soLanThu: soLan, thoiGianMs: Date.now() - batDau, loi: loiCuoi && loiCuoi.message, actorId,
  });
  throw new AppError(
    `Không lấy được mã ${cfg.ten} từ ERP (đã thử ${soLan} lần, ${url}): ${loiCuoi && loiCuoi.message}. `
    + 'Kiểm tra kết nối tới ERP rồi bấm lại — tem CHƯA được tạo.',
    { status: 503, errorCode: cfg.ma }
  );
}

const layBarcodeTem = (actorId = null) => layBarcodeTemTienTo(15, actorId);
// Tem SỬA ĐẠT (tem con mig 091) — `null` khi API tắt ⇒ `recordSua` lùi về mã suy từ tem gốc.
const layBarcodeTem17 = (actorId = null) => layBarcodeTemTienTo(17, actorId);
// Tem HÀNG GIA CÔNG VỀ — `null` khi API tắt ⇒ `confirmGiaCongToOqc` lùi về mã tem 15 như trước.
const layBarcodeTem13 = (actorId = null) => layBarcodeTemTienTo(13, actorId);

// Lấy NHIỀU mã (lệnh gom set in N tem 1 lượt). Lấy TUẦN TỰ để không bắn song song vào ERP;
// lỗi giữa chừng thì ném luôn — chưa tem nào được tạo nên không có gì phải dọn.
// ⚠ Trả `null` (KHÔNG phải mảng null) khi API bị tắt — bên gọi tự sinh đủ N mã.
async function layNhieuBarcodeTem(n, actorId = null) {
  if (!(await apiBat('ERP_BARCODE_TEM'))) {
    console.log(`[tem-barcode] ⏸ API đang TẮT — MES tự sinh ${n} mã tem`);
    return null;
  }
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(await layBarcodeTem(actorId));
  return out;
}

module.exports = {
  layBarcodeTem, layBarcodeTem17, layBarcodeTem13, layBarcodeTemTienTo,
  layNhieuBarcodeTem, BARCODE_RE, API_THEO_TIEN_TO,
};
