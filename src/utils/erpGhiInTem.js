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

// ⚠⚠ KHÔNG GỬI `null` (chốt với người dùng 2026-08-15): chuỗi thiếu → `''`, số thiếu → `0`.
// Router bên ERP đổ thẳng giá trị vào `request.input(..., sql.NVarChar/Int, v)` rồi `execute` proc,
// nên `null` đi tới proc dưới dạng SQL NULL — proc phải tự `ISNULL` từng chỗ. Gửi giá trị rỗng đúng
// kiểu thì proc xử lý một đường, không phải phân nhánh.
const chuoi = (v, max) => {
  if (v == null) return '';
  const s = String(v).trim();
  return max && s.length > max ? s.slice(0, max) : s;
};

const soNguyen = (v) => {
  if (v == null || v === '') return 0;
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : 0;
};

// ⚠⚠ NGOẠI LỆ — 3 trường NGÀY GIỜ VẪN ĐỂ `null` khi thiếu, TUYỆT ĐỐI không đổi sang `''`:
//   router ERP khai `sql.DateTime`, mà chuỗi rỗng KHÔNG phải ngày hợp lệ ⇒ tedious ném lỗi chuyển
//   kiểu và **cả lượt gọi hỏng** — tệ hơn hẳn so với truyền NULL (proc vẫn nhận bình thường).
//   `Ngayct` luôn có (`now()` trong SQL); chỉ `Tugio`/`Dengio` mới rỗng khi lượt in chưa nhập giờ SX.
const ngayGio = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
};

// ⚠⚠ CHỈ GỬI **TÊN** LÊN ERP, BỎ HỌ + TÊN LÓT (chốt với người dùng 15/08/2026).
//   `"PHẠM THỊ HỒNG"` → `HỒNG` · `"NGÔ VĂN NHỚ"` → `NHỚ` · `"VŨ THỊ THANH NHÀN"` → `NHÀN`.
//   Khớp đúng mẫu ERP gửi kèm (`dsthoin = 'HAI,NAM,THANH'` — toàn tên đơn) và rút `dsthoin` của ca
//   thật từ **60 ký tự / 73 byte xuống 17 ký tự / 25 byte**, tức tránh xa mọi giới hạn của proc.
//   Áp cho 3 trường TÊN NGƯỜI: `Chuyentruong` · `Catruong` · từng phần tử của `dsthoin`.
//
// ⚠ Chỉ đổi thứ GỬI ĐI — dữ liệu trong MES (`phieu_san_xuat.chuyen_truong`, `ca_truong_id`,
//   `phan_cong_san_xuat.tho_in`) vẫn giữ HỌ TÊN ĐẦY ĐỦ; mọi màn/tem/Excel của MES không đổi.
//
// ⚠⚠ HỆ QUẢ ĐÃ BIẾT — **trùng tên**: 2 người "PHẠM THỊ HỒNG" và "NGUYỄN VĂN HỒNG" cùng ra `HỒNG`.
//   CỐ Ý **KHÔNG khử trùng** trong `dsthoin`: đó là danh sách thợ in, bỏ bớt một mục là đổi SĨ SỐ
//   của ca. Muốn phân biệt thì đổi `SO_TU_TEN` = 2 (ra `THANH NHÀN`) — đúng 1 chỗ, không sửa gì thêm.
const SO_TU_TEN = 1;
const chiLayTen = (v) => {
  const tu = String(v == null ? '' : v).trim().split(/\s+/).filter(Boolean);
  return tu.length ? tu.slice(-SO_TU_TEN).join(' ') : '';
};

// 2 trường TÊN NGƯỜI ở mức phiếu (danh sách thợ in xử lý riêng vì ngăn bằng dấu phẩy).
const TRUONG_TEN = new Set(['Chuyentruong', 'Catruong']);

// Chuẩn hóa 1 bản ghi về đúng kiểu + độ dài mà proc nhận. Trường chuỗi thiếu → `''`, số thiếu → `0`,
// riêng 3 trường ngày giờ thiếu → `null` (xem `ngayGio`).
function chuanHoa(row = {}) {
  const out = {};
  for (const k of THU_TU_TRUONG) {
    let v = row[k];
    // `dsthoin` là DANH SÁCH tên ngăn bằng dấu phẩy (mẫu ERP: 'HAI,NAM,THANH'). Ô nhập của MES cho
    // gõ tự do nên dữ liệu thật lẫn cả 2 kiểu: 'THU,RUONL,NGOC' và 'CHAU PHÊNH, THÁI THỊ TUYẾT TRINH'
    // ⇒ tách theo dấu phẩy, lấy TÊN từng người, rồi ghép lại không có dấu cách thừa.
    if (k === 'dsthoin' && v != null) {
      v = String(v).split(',').map(chiLayTen).filter(Boolean).join(',');
    } else if (TRUONG_TEN.has(k) && v != null) {
      v = chiLayTen(v);
    }
    // ⚠ Rút gọn tên chạy TRƯỚC `chuoi(v, max)`: cắt cụt trước rồi mới lấy từ cuối sẽ ra tên sai
    // (vd cắt "NGUYỄN THỊ HƯƠNG LAN" ở ký tự 20 rồi lấy từ cuối → "LA").
    if (Object.prototype.hasOwnProperty.call(DAI_TOI_DA, k)) out[k] = chuoi(v, DAI_TOI_DA[k]);
    else if (k === 'Ngayct' || k === 'Tugio' || k === 'Dengio') out[k] = ngayGio(v);
    else out[k] = soNguyen(v);
  }
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
  const data = typeof res.data === 'string' ? safeJson(res.data) : res.data;

  // ⚠⚠ LỖI CŨNG PHẢI GIỮ NGUYÊN PHẢN HỒI ERP (19/08/2026 — người dùng yêu cầu: "dù thành công hay
  //   thất bại cũng lưu message lại"). Bản cũ chỉ nhét 300 ký tự đầu vào CHUỖI lỗi rồi ném đi, nên
  //   `nhan` trong `audit_log` là NULL ở mọi dòng lỗi — mất hẳn `message`/`error` mà ERP nói ra.
  //   Nay đính kèm phản hồi vào chính đối tượng lỗi để `ghiInTem` lưu y như nhánh thành công.
  //   Ca thật 14/08: ERP trả `{"success":false,"message":"Lỗi ghi in tem","error":"String or binary
  //   data would be truncated."}` — câu `error` đó mới là thứ chỉ ra cột nào bị tràn.
  const kemPhanHoi = (msg) => {
    const e = new Error(msg);
    e.phanHoi = data ?? res.data ?? null;   // nguyên văn thân phản hồi
    e.httpStatus = res.status;
    return e;
  };

  if (res.status < 200 || res.status >= 300) {
    // Router ERP trả `{ success:false, message, error }` kèm HTTP 500 — `error` là câu của SQL Server.
    const chiTiet = data && (data.error || data.message)
      ? `${data.message || ''}${data.error ? ` — ${data.error}` : ''}`.trim()
      : String(typeof res.data === 'string' ? res.data : JSON.stringify(res.data || {})).slice(0, 300);
    throw kemPhanHoi(`ERP trả về HTTP ${res.status}${chiTiet ? ` — ${chiTiet}` : ''}`);
  }
  if (data && data.success === false) {
    throw kemPhanHoi(`${data.message || 'ERP trả về success=false'}${data.error ? ` — ${data.error}` : ''}`);
  }

  // ⚠⚠ `returnValue` LÀ MÃ TRẢ VỀ CỦA STORED PROCEDURE, KHÔNG PHẢI HTTP status. Router ERP bọc
  //   `request.execute('MES_spr_MES2SF0')` trong try/catch, nên proc chạy XONG mà `RETURN` mã khác 0
  //   (lỗi NGHIỆP VỤ: trùng tem, sai đợt nhận vải…) thì router VẪN trả `success: true`.
  //   ⇒ MES không được coi mỗi `success` là đủ: giữ nguyên `returnValue` để đối chiếu, và cảnh báo
  //   ra log khi khác 0. CỐ Ý KHÔNG ném lỗi ở đây — chưa rõ bảng mã của proc, ném bừa sẽ chặn in tem
  //   vì một mã có thể hoàn toàn bình thường.
  if (data && data.returnValue != null && Number(data.returnValue) !== 0) {
    console.warn(`[ghi-in-tem] ⚠ ERP nhận nhưng proc trả returnValue=${data.returnValue}`
      + ` (IDMES ${body.IDMES}, tem ${body.BarcodeIn}) — kiểm tra ở Hệ thống > Cài đặt API > Lịch sử`);
  }
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
  // ⚠ TRẢ CẢ `data` Ở NHÁNH LỖI: phản hồi nguyên văn của ERP (nếu có) được `goiMotLan` đính vào lỗi.
  //   Lỗi mạng/timeout thì không có gì để trả → `null`, đúng bản chất "chưa tới được ERP".
  return { ok: false, body, error, data: (loiCuoi && loiCuoi.phanHoi) || null };
}

module.exports = { ghiInTem, chuanHoa, THU_TU_TRUONG, DAI_TOI_DA };
