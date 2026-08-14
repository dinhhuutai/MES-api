'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// BÁO NGƯỢC LÊN ERP MỖI LẦN IN TEM — chiều ĐẨY duy nhất của hệ.
//
// API: POST {ERP_GHI_IN_TEM_URL} → proc `MES_spr_MES2SF0` bên ERP
//      body = 20 trường (xem `THU_TU_TRUONG` bên dưới), trả { success: true, ... }
//
// ⚠⚠ KHÁC HẲN `erpTemBarcode.layBarcodeTem`: hàm này **KHÔNG BAO GIỜ ném lỗi ra ngoài**.
//   Lúc gọi thì tem ĐÃ tạo trong DB và mã tem ĐÃ tiêu một số của ERP — chặn lại là hỏng việc của
//   người đang đứng chờ máy in. Lỗi ⇒ trả `{ ok:false, error }` để bên gọi ghi `audit_log`
//   (`ERP_GHI_IN_TEM_LOI`, lưu nguyên payload) rồi gửi lại bằng tay.
//
// ⚠ Bên gọi nên chạy NGẦM (không `await`): timeout 10s × 3 lần + backoff ⇒ xấu nhất ~33s,
//   chặn response từng ấy thời gian là hỏng thao tác in.
//
// ⚠ CẮT CHUỖI TRƯỚC KHI GỬI (`chuanHoa`): cột bên ERP là `nvarchar(20)`/`nvarchar(255)`, mà
//   `nguoi_dung.ho_ten` có 16 người dài hơn 20 ký tự (max 24) ⇒ không cắt thì proc ăn lỗi khó đọc.
// ─────────────────────────────────────────────────────────────────────────────

const axios = require('axios');
const env = require('../config/env');
const { apiBat } = require('./caiDatApi');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Độ dài tối đa của từng trường chuỗi, theo đúng khai báo tham số của proc `MES_spr_MES2SF0`.
const DAI_TOI_DA = {
  Ngayca: 20,
  Chuyentruong: 20,
  Catruong: 20,
  dsthoin: 255,
  Toin: 20,
  banin: 20,
  IDDotNhanvai: 20,
  DDHID: 20,
  BarcodeIn: 20,
  Lenhbosung: 20,
  GCMauvai: 20,
};

// Thứ tự trường trong body — giữ đúng thứ tự tham số của proc cho dễ đối chiếu khi đọc log.
const THU_TU_TRUONG = [
  'IDMES', 'Ngayct', 'Ngayca', 'Tugio', 'Dengio',
  'Chuyentruong', 'Catruong', 'dsthoin', 'Toin', 'banin',
  'IDDotNhanvai', 'DDHID', 'DDHsubID', 'BarcodeIn',
  'inbosung', 'Lenhbosung', 'Soluong', 'Soluongloi', 'SOLUONGTHIEU', 'GCMauvai',
];

const chuoi = (v, max) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return max && s.length > max ? s.slice(0, max) : s;
};

const soNguyen = (v) => {
  if (v == null || v === '') return null;
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
};

// Chuẩn hóa 1 bản ghi về đúng kiểu + độ dài mà proc nhận. Trường thiếu → null (mẫu ERP cho thấy
// proc nhận null bình thường, vd `@pinbosung`/`@pLenhbosung`).
function chuanHoa(row = {}) {
  const out = {};
  for (const k of THU_TU_TRUONG) {
    let v = row[k];
    // `dsthoin` là DANH SÁCH tên ngăn bằng dấu phẩy — bỏ khoảng trắng SÁT dấu phẩy để ERP tách
    // chuỗi không dính dấu cách thừa (mẫu ERP: 'HAI,NAM,THANH'). Ô nhập của MES cho gõ tự do nên
    // dữ liệu thật lẫn cả 2 kiểu: 'THU,RUONL,NGOC' và 'CHAU PHÊNH, THÁI THỊ TUYẾT TRINH'.
    // ⚠ Chỉ cắt khoảng trắng CẠNH dấu phẩy — tên người có dấu cách bên trong phải giữ nguyên.
    if (k === 'dsthoin' && v != null) v = String(v).replace(/\s*,\s*/g, ',');
    if (Object.prototype.hasOwnProperty.call(DAI_TOI_DA, k)) out[k] = chuoi(v, DAI_TOI_DA[k]);
    else if (k === 'Ngayct' || k === 'Tugio' || k === 'Dengio') out[k] = chuoi(v);
    else out[k] = soNguyen(v);
  }
  // 2 trường số lượng vải: proc muốn số thật, để null dễ bị hiểu là "chưa biết".
  out.Soluongloi = out.Soluongloi ?? 0;
  out.SOLUONGTHIEU = out.SOLUONGTHIEU ?? 0;
  return out;
}

async function goiMotLan(body) {
  const url = env.erp.ghiInTemUrl;
  // ⚠ LOG CẢ URL: bài học 2026-08-11 (gọi nhầm host LAN) mất rất lâu mới tìm ra vì thông điệp lỗi
  //   chỉ ghi "timeout" mà không nói đang gọi ĐI ĐÂU.
  console.log(`[ghi-in-tem] → POST ${url} (IDMES ${body.IDMES}, tem ${body.BarcodeIn})`);
  const res = await axios.post(url, body, {
    timeout: env.erp.ghiInTemTimeoutMs,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(env.erp.apiHeaders || {}) },
    proxy: erpProxy(),
    validateStatus: () => true,
  });
  if (res.status < 200 || res.status >= 300) {
    const chiTiet = typeof res.data === 'string' ? res.data.slice(0, 300) : JSON.stringify(res.data || {}).slice(0, 300);
    throw new Error(`ERP trả về HTTP ${res.status}${chiTiet ? ` — ${chiTiet}` : ''}`);
  }
  const data = typeof res.data === 'string' ? safeJson(res.data) : res.data;
  if (data && data.success === false) throw new Error(data.message || 'ERP trả về success=false');
  return data || {};
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Proxy giống hệt `erpTemBarcode`/`erpsync.service` — undefined thì axios tự đọc HTTP_PROXY env.
function erpProxy() {
  if (!env.erp.proxyUrl) return undefined;
  try {
    const u = new URL(env.erp.proxyUrl);
    return { host: u.hostname, port: Number(u.port) || 80, protocol: u.protocol.replace(':', '') };
  } catch { return undefined; }
}

// Gửi 1 bản ghi. KHÔNG NÉM LỖI — luôn trả { ok, body, data? , error? }.
async function ghiInTem(row) {
  const body = chuanHoa(row);
  // Tắt ở Hệ thống > Cài đặt API (mig 083); chưa có dòng cấu hình thì lấy mặc định `.env`.
  if (!(await apiBat('ERP_GHI_IN_TEM'))) {
    console.log(`[ghi-in-tem] ⏸ ĐANG TẮT (Hệ thống > Cài đặt API) — bỏ qua tem ${body.BarcodeIn}`);
    return { ok: false, bo_qua: true, body };
  }
  const soLan = Math.max(1, env.erp.ghiInTemRetry);
  let loiCuoi;
  for (let i = 1; i <= soLan; i += 1) {
    try {
      const data = await goiMotLan(body);
      console.log(`[ghi-in-tem] ✓ Đã báo ERP (IDMES ${body.IDMES}, tem ${body.BarcodeIn})`);
      return { ok: true, body, data };
    } catch (e) {
      loiCuoi = e;
      if (i < soLan) {
        const cho = 1000 * i; // 1s, 2s, 3s...
        console.warn(`[ghi-in-tem] ⟳ Báo ERP lỗi (lần ${i}/${soLan}), thử lại sau ${cho / 1000}s: ${e.message}`);
        await sleep(cho);
      }
    }
  }
  const error = `${loiCuoi && loiCuoi.message} (${env.erp.ghiInTemUrl})`;
  console.error(`[ghi-in-tem] ✗ Không báo được ERP sau ${soLan} lần — tem ${body.BarcodeIn}: ${error}`);
  return { ok: false, body, error };
}

module.exports = { ghiInTem, chuanHoa, THU_TU_TRUONG, DAI_TOI_DA };
