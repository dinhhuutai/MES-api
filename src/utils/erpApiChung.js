'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// HELPER GỌI ERP DÙNG CHUNG cho 3 API thêm ngày 04/09/2026:
//   · `ERP_LAY_ID_PHIEU_GIAO`  (GET)  — xin số phiếu giao do ERP cấp
//   · `ERP_GUI_PHIEU_GIAO`     (POST) — đẩy nội dung phiếu giao sang ERP
//   · `ERP_GUI_PHAN_LOAI_LOI`  (POST) — đẩy phiếu phân loại lỗi sang ERP
//
// VÌ SAO GOM 1 FILE: 3 API cùng một khuôn (đọc cờ bật/tắt ở *Cài đặt API* → gọi có retry+backoff →
// ghi vết vào `audit_log` để trang Lịch sử đọc được). Chép 3 bản như `erpTemBarcode`/`erpGhiInTem`
// là 3 chỗ phải sửa mỗi khi đổi luật.
//
// ⚠⚠ HAI KIỂU HÀNH XỬ KHI LỖI — ĐỪNG DÙNG NHẦM (bài học từ 2 API cũ):
//   · **CHIỀU XIN SỐ** (`layIdPhieuGiao`): mỗi lần gọi TIÊU MỘT SỐ của ERP. Lỗi ⇒ **trả `null`** để
//     bên gọi tự quyết (ở đây: lùi về mã phiếu MES tự sinh). CỐ Ý KHÔNG ném lỗi chặn việc giao hàng —
//     khác `erpTemBarcode` (chặn in tem) vì tem là thứ ERP BẮT BUỘC quét, còn số phiếu giao thì không.
//   · **CHIỀU ĐẨY** (`guiPhieuGiao` / `guiPhanLoaiLoi`): **KHÔNG BAO GIỜ ném lỗi ra ngoài** và bên gọi
//     KHÔNG `await` — nghiệp vụ đã ghi xong vào MES rồi, ERP chỉ là bên nhận tin. Timeout 10s × 3 lần
//     ⇒ xấu nhất ~33s, chặn response từng ấy là hỏng thao tác của người dùng.
//
// ⚠ URL mặc định SUY TỪ HOST của API đồng bộ (`config/env.js`) — đừng hardcode host (sự cố 11/08/2026).
// ─────────────────────────────────────────────────────────────────────────────

const axios = require('axios');
const env = require('../config/env');
const { apiBat } = require('./caiDatApi');
const { ghiLog } = require('./erpApiLog');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

// Proxy giống hệt `erpTemBarcode`/`erpGhiInTem` — undefined thì axios tự đọc HTTP_PROXY env.
function erpProxy() {
  if (!env.erp.proxyUrl) return undefined;
  try {
    const u = new URL(env.erp.proxyUrl);
    return { host: u.hostname, port: Number(u.port) || 80, protocol: u.protocol.replace(':', '') };
  } catch { return undefined; }
}

// 1 lượt gọi. Ném lỗi CÓ ĐÍNH phản hồi ERP (`e.phanHoi`) để bên trên lưu được "gửi gì → nhận gì"
// kể cả ở nhánh lỗi — đúng bài học 19/08/2026 với `ghi-in-tem`.
async function goiMotLan({ nhan, url, method, body, timeoutMs }) {
  console.log(`[${nhan}] → ${method} ${url}`);
  const res = await axios({
    method,
    url,
    data: method === 'POST' ? body : undefined,
    timeout: timeoutMs,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(env.erp.apiHeaders || {}) },
    proxy: erpProxy(),
    validateStatus: () => true,
  });
  const data = typeof res.data === 'string' ? safeJson(res.data) : res.data;
  const kem = (msg) => {
    const e = new Error(msg);
    e.phanHoi = data ?? res.data ?? null;
    e.httpStatus = res.status;
    return e;
  };
  if (res.status < 200 || res.status >= 300) {
    const chiTiet = data && (data.error || data.message)
      ? `${data.message || ''}${data.error ? ` — ${data.error}` : ''}`.trim()
      : String(typeof res.data === 'string' ? res.data : JSON.stringify(res.data || {})).slice(0, 300);
    throw kem(`ERP trả về HTTP ${res.status}${chiTiet ? ` — ${chiTiet}` : ''}`);
  }
  if (data && data.success === false) {
    throw kem(`${data.message || 'ERP trả về success=false'}${data.error ? ` — ${data.error}` : ''}`);
  }
  // ⚠ `returnValue` = mã RETURN của stored procedure, KHÔNG phải HTTP status: proc chạy xong mà trả
  //   mã ≠ 0 (lỗi nghiệp vụ) thì router ERP VẪN trả success=true. Lưu lại + cảnh báo, cố ý không ném
  //   (chưa biết bảng mã của proc, ném bừa sẽ chặn nghiệp vụ vì một mã có thể hoàn toàn bình thường).
  if (data && data.returnValue != null && Number(data.returnValue) !== 0) {
    console.warn(`[${nhan}] ⚠ ERP nhận nhưng proc trả returnValue=${data.returnValue} — kiểm ở Hệ thống > Cài đặt API > Lịch sử`);
  }
  return data || {};
}

// Gọi có retry + ghi vết. KHÔNG NÉM LỖI — luôn trả { ok, data?, error?, bo_qua? }.
async function goiErp(maApi, { nhan, url, method = 'POST', body = null, timeoutMs, retry, idBanGhi, moTa, actorId }) {
  if (!(await apiBat(maApi))) {
    console.log(`[${nhan}] ⏸ ĐANG TẮT (Hệ thống > Cài đặt API) — bỏ qua${moTa ? ` ${moTa}` : ''}`);
    return { ok: false, bo_qua: true };
  }
  const soLan = Math.max(1, Number(retry) || 1);
  const batDau = Date.now();
  let loiCuoi;
  for (let i = 1; i <= soLan; i += 1) {
    try {
      const data = await goiMotLan({ nhan, url, method, body, timeoutMs });
      await ghiLog(maApi, {
        thanhCong: true, idBanGhi: idBanGhi || '-', url, soLanThu: i, thoiGianMs: Date.now() - batDau,
        gui: method === 'POST' ? body : null, nhan: data,
        erpMessage: data && data.message, erpReturnValue: data && data.returnValue, actorId,
      });
      return { ok: true, data };
    } catch (e) {
      loiCuoi = e;
      if (i < soLan) {
        const cho = 1000 * i;
        console.warn(`[${nhan}] ⟳ lỗi (lần ${i}/${soLan}), thử lại sau ${cho / 1000}s: ${e.message}`);
        await sleep(cho);
      }
    }
  }
  const ph = loiCuoi && loiCuoi.phanHoi;
  const error = `${loiCuoi && loiCuoi.message} (${url})`;
  console.error(`[${nhan}] ✗ Thất bại sau ${soLan} lần${moTa ? ` — ${moTa}` : ''}: ${error}`);
  await ghiLog(maApi, {
    thanhCong: false, idBanGhi: idBanGhi || '-', url, soLanThu: soLan, thoiGianMs: Date.now() - batDau,
    gui: method === 'POST' ? body : null, nhan: ph,
    erpMessage: ph && ph.message, erpError: ph && ph.error, erpReturnValue: ph && ph.returnValue,
    loi: error, actorId,
  });
  return { ok: false, error };
}

// ─── 1. XIN ID PHIẾU GIAO ────────────────────────────────────────────────────
// Trả CHUỖI id do ERP cấp, hoặc `null` khi tắt / lỗi (bên gọi lùi về mã MES tự sinh).
// ⚠ Mỗi lần gọi TIÊU MỘT SỐ ⇒ chỉ gọi khi THẬT SỰ tạo phiếu giao, và gọi TRƯỚC transaction
//   (gọi HTTP bên trong transaction sẽ giữ khóa bảng suốt thời gian chờ mạng).
async function layIdPhieuGiao(actorId = null) {
  const kq = await goiErp('ERP_LAY_ID_PHIEU_GIAO', {
    nhan: 'lay-id-phieu-giao',
    url: env.erp.layIdPhieuGiaoUrl,
    method: 'GET',
    timeoutMs: env.erp.layIdPhieuGiaoTimeoutMs,
    retry: env.erp.layIdPhieuGiaoRetry,
    actorId,
  });
  if (!kq.ok) return null;
  const d = kq.data || {};
  // ERP có thể đặt tên khóa khác nhau — nhận mọi biến thể hay gặp rồi mới chịu thua.
  const id = d.id ?? d.ID ?? d.idPhieuGiao ?? d.IDPhieuGiao ?? d.ma_phieu_giao ?? d.maPhieuGiao ?? d.barcode ?? d.data;
  const s = id == null ? '' : String(id).trim();
  if (!s) {
    console.warn('[lay-id-phieu-giao] ⚠ ERP trả về thành công nhưng không có id — dùng mã MES tự sinh');
    return null;
  }
  return s;
}

// ─── 2. ĐẨY PHIẾU GIAO ───────────────────────────────────────────────────────
// `idBanGhi` = giao_hang.id để dòng lịch sử liên kết được với phiếu.
async function guiPhieuGiao(payload, { giaoHangId = null, actorId = null } = {}) {
  return goiErp('ERP_GUI_PHIEU_GIAO', {
    nhan: 'gui-erp-phieu-giao',
    url: env.erp.guiPhieuGiaoUrl,
    method: 'POST',
    body: payload,
    timeoutMs: env.erp.guiPhieuGiaoTimeoutMs,
    retry: env.erp.guiPhieuGiaoRetry,
    idBanGhi: giaoHangId,
    moTa: payload && payload.MaPhieuGiao ? `phiếu ${payload.MaPhieuGiao}` : null,
    actorId,
  });
}

// ─── 3. ĐẨY PHÂN LOẠI LỖI ────────────────────────────────────────────────────
async function guiPhanLoaiLoi(payload, { temId = null, actorId = null } = {}) {
  return goiErp('ERP_GUI_PHAN_LOAI_LOI', {
    nhan: 'gui-erp-phan-loai-loi',
    url: env.erp.guiPhanLoaiLoiUrl,
    method: 'POST',
    body: payload,
    timeoutMs: env.erp.guiPhanLoaiLoiTimeoutMs,
    retry: env.erp.guiPhanLoaiLoiRetry,
    idBanGhi: temId,
    moTa: payload && payload.BarcodeIn ? `tem ${payload.BarcodeIn}` : null,
    actorId,
  });
}

module.exports = { layIdPhieuGiao, guiPhieuGiao, guiPhanLoaiLoi, goiErp };
