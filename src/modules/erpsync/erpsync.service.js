'use strict';

const crypto = require('crypto');
const axios = require('axios');
const { withTransaction } = require('../../config/db');
const repo = require('./erpsync.repository');
const env = require('../../config/env');
const AppError = require('../../utils/AppError');
const { buildMeta } = require('../../utils/pagination');
const { apiBat } = require('../../utils/caiDatApi');
const sockets = require('../../sockets');
const tracking = require('../workflow/tracking.service');
const gomRepo = require('../gomset/gomset.repository');

const NGUON = 'phieu_nhan_vai_60';          // API DUY NHẤT → đợt vải vào thẳng READY

// Loại kinh doanh (`loaikd`) CHỈ LẤY khi đồng bộ: 3I = số lượng (SO_LUONG) · 5I = bổ sung (BO_SUNG)
// · 6I = mẫu số lượng (MAU_SO_LUONG, mig 070). Mọi loại khác → BỎ QUA. (Trước đây lọc theo khách hàng
// 'SL' + blacklist 8I/2I; nay bỏ lọc khách, chuyển sang whitelist loaikd cho rõ ràng.) Thêm/bớt mã ở đây.
const LAY_LOAIKD = new Set(['3I', '5I', '6I']);

// TÍNH CHẤT IN (`Tinhchatin`) BỎ QUA — các công đoạn ép/ủi/lụa... không thuộc phạm vi MES này.
// So khớp sau khi chuẩn hóa (bỏ hết khoảng trắng + viết hoa) nên "C + EP DECAL" == "C+EP DECAL".
const BO_TINH_CHAT_IN_RAW = [
  'C+EP DECAL', 'C+KIENG UI', 'DANKEO', 'DQ+EP DINH', 'DQ+EP KIENG', 'DQ+EP LUN', 'EP DC', 'EP DECAL',
  'EP DIEN', 'EP DINH', 'EP DINH+LS', 'EP DQ', 'EP GAI XU', 'EP KEO', 'EP KIENG', 'EP LUN', 'EP LUN NHUA',
  'EP LUN PHOI', 'EP LUN+EP NOI', 'EP NHIET', 'EP NHUA MAU', 'EP NHUNG', 'EP NOI', 'EP NOI SLC', 'EP NONG',
  'EP NONG+LS', 'EP PET', 'EP PHOI', 'IN EP NHUNG', 'IN EP PHOI', 'KIENG UI', 'KIENG UI BONG', 'KIENG UI DQ',
  'KIENG UI DQ+DQ', 'KIENG UI DQ+EP K', 'KIENG UI+KBONG', 'KIENGUICAO', 'LAZE+EP KIENG', 'LG', 'LG BONG',
  'LG EP', 'LG MO', 'LG+EP NHUA', 'LS', 'LS+EP KIENG', 'RC+REP DC', 'RDQ+EP LUN', 'REP DECAL', 'REP DIEN',
  'REP DINH', 'REP DQ', 'REP GAI XU', 'REP KEO', 'REP KIENG', 'REP LUN', 'REP LUN NHUA', 'REP LUN+EP NOI',
  'REP NHIET', 'REP NHUA MAU', 'REP NHUNG', 'REP NOI', 'REP NOI SLC', 'REP NONG', 'REP PHOI', 'REP UI',
  'RIN EP NHUNG', 'RIN EP PHOI', 'RKIENG UI', 'RKIENG UI BONG', 'RKIENG UI DQ', 'RKIENG UI DQ+EP K',
  'RKIENG UI+KBONG', 'RLAZE+EP KIENG', 'RLG', 'RLG EP', 'RLG+EP NHUA', 'RLS', 'RLS+EP KIENG', 'RT+EP DC',
  'RT+EP DIEN', 'RT+EP DINH', 'RT+EP LUN', 'RT+EP LUN PHOI', 'RT+EP NHUNG', 'RT+EP NOI', 'RT+EP NONG',
  'RT+EP PHOI', 'RT+EP UI', 'RT+KIENG UI', 'RT+KIENG UI DQ', 'RT+LG EP', 'RTB+EP DINH', 'RTB+EP NHIET',
  'T+DQ+EPLUN', 'T+EP DC', 'T+EP DIEN', 'T+EP DINH', 'T+EP KIENG', 'T+EP LUN', 'T+EP LUN PHOI', 'T+EP LUN+LS',
  'T+EP NHUNG', 'T+EP NOI', 'T+EP NONG', 'T+EP PHOI', 'T+EP UI', 'T+KIENG UI', 'T+KIENG UI DQ', 'T+LG EP',
  'T+LS', 'TB+EP DINH', 'TB+EP NHIET', 'TB+KIENGUIBONG', 'IN KIENG DQ'
];
const normTcin = (v) => String(v == null ? '' : v).toUpperCase().replace(/\s+/g, '');
const BO_TINH_CHAT_IN = new Set(BO_TINH_CHAT_IN_RAW.map(normTcin));

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const clean = (v) => (v == null ? '' : String(v).trim());
// DATE 'YYYY-MM-DD' từ chuỗi ISO (cắt phần ngày, không lệch timezone).
const toDate = (v) => (v ? String(v).slice(0, 10) : null);

// Đọc 1 trường ERP không phân biệt hoa/thường và dấu gạch dưới: field(r,'NgayNhanvai') khớp
// 'NgayNhanvai' | 'ngaynhanvai' | 'ngay_nhan_vai'... (ERP đặt tên không nhất quán với các cột cũ).
function field(r, ...names) {
  const key = (s) => String(s).toLowerCase().replace(/[_\s-]/g, '');
  const map = new Map(Object.keys(r || {}).map((k) => [key(k), k]));
  for (const n of names) {
    const k = map.get(key(n));
    if (k != null && r[k] != null && String(r[k]).trim() !== '') return r[k];
  }
  return null;
}
// Tính chất in: trường ERP đúng là `tinhchatin` (field() không phân biệt hoa/thường & gạch dưới).
const erpTinhChatIn = (r) => clean(field(r, 'tinhchatin', 'tinh_chat_in')) || null;
// Mã vạch đợt vải từ ERP — trường `IDDotReady` (đổi tên từ `maquet` cũ) → phan_in.barcode (quét ở READY).
const erpBarcode = (r) => clean(field(r, 'IDDotReady', 'iddotready', 'maquet', 'ma_quet', 'barCode', 'barcode', 'ma_vach', 'mavach')) || null;
// Mã vạch HSKT (ERP BarcodeHKT) → ho_so_ky_thuat.barcode_hskt (quét HSKT).
const erpBarcodeHskt = (r) => clean(field(r, 'BarcodeHKT', 'barcode_hkt', 'barcodehkt', 'barcode_hskt')) || null;
// Mã vạch PHẦN IN (ERP `BarcodePTHDH`, bật từ 06/08/2026) → `phan_in.barcode` — TƯƠNG ĐƯƠNG code phần,
// 1 mã ↔ 1 phần in. Dùng cột `phan_in.barcode` sẵn có (mig 055, bỏ trống từ mig 061) ⇒ KHÔNG cần migration.
// ⚠ Khác `erpBarcode` (IDDotReady, thuộc ĐỢT VẢI, dùng chung nhiều phần in) và khác `barcode_hskt`
// (12 số, mức HỒ SƠ). Đối chiếu prod: 11 chữ số, 114/114 dòng duy nhất 1:1 với code_part.
const erpBarcodePhanIn = (r) => clean(field(r, 'BarcodePTHDH', 'barcode_pt_hdh', 'barcodept')) || null;
// NHÀ GIA CÔNG (ERP `NGC`, bật 07/08/2026) → `dot_vai_ve.nha_gia_cong` (mig 072).
// Đi theo TỪNG DÒNG nhận vải ⇒ thuộc ĐỢT VẢI, không phải phần in (1 phần in nhiều đợt có thể khác nhà).
// Giá trị thật: mã ngắn 'KK'/'VS'/'II'/'DK'/'SL3'/'KN6' hoặc tên 'E SANG'; có dòng ERP gửi rỗng.
const erpNhaGiaCong = (r) => clean(field(r, 'NGC', 'nha_gia_cong', 'nhagiacong')) || null;

// Mig 074 — 3 trường ERP bổ sung (đối chiếu 1318 dòng raw 10/08/2026, xem ghi chú trong migration):
//   · DDHID    → 1:1 với ĐƠN HÀNG        → `don_hang.ddh_id`
//   · DDHSUBID → số dòng chi tiết đơn; ⚠ KHÔNG duy nhất theo mã hàng (198 cặp lệch) → `dot_vai_ve.ddh_sub_id`
//   · Duan     → duy nhất theo ĐỢT VẢI    → `dot_vai_ve.du_an`
// (IDDotReady đã map sẵn vào `dot_vai_ve.barcode` từ mig 061 — `erpBarcode` ở trên, KHÔNG thêm cột.)
const erpDdhId = (r) => clean(field(r, 'DDHID', 'ddh_id', 'ddhid')) || null;
const erpDdhSubId = (r) => clean(field(r, 'DDHSUBID', 'ddh_sub_id', 'ddhsubid')) || null;
const erpDuAn = (r) => clean(field(r, 'Duan', 'du_an', 'duan')) || null;
const toIntOrNull = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
// Pain = phương án in (1 Bàn / 2 Máy / 3 Robot).
const erpPain = (r) => toIntOrNull(field(r, 'Pain', 'pain', 'phuong_an_in'));
// Inset = SỐ NHÓM GOM SET (0 = không gom set; N>0 = nhóm N) — phạm vi số nhóm là TRONG 1 ĐỢT READY
// (IDDotReady), không phải toàn hệ thống. ⚠ KHÔNG phải cờ true/false, và KHÔNG gom theo BarcodeHKT
// (barcode HSKT là duy nhất theo phần in). Trả int|null.
const erpInset = (r) => toIntOrNull(field(r, 'Inset', 'inset'));
// KTCankiemtra: 1 = cần KT (làm lại READY), 0 = KT không cần (auto qua Release 1). Trả 0/1|null.
const erpKtCanKiemTra = (r) => toIntOrNull(field(r, 'KTCankiemtra', 'kt_can_kiem_tra', 'ktcankiemtra'));
// Ngày vải về: trường ERP đúng là `ngaynhanvai`, lùi về erp_datetime/created_date nếu thiếu.
const erpNgayVaiVe = (r) => toDate(field(r, 'ngaynhanvai', 'ngay_nhan_vai', 'ngay_vai_ve') || r.erp_datetime || r.created_date);

// Khóa định danh ổn định để upsert.
// QUY TẮC: 1 bản ghi ERP = 1 đợt vải. ERP trả về nhiều dòng giống hệt nhau (chỉ khác received_qty,
// thậm chí trùng hoàn toàn) và KHÔNG có id duy nhất. Vì vậy maDotVai = hash(toàn bộ nội dung dòng,
// gồm received_qty) + CHỈ SỐ THỨ TỰ xuất hiện trong nhóm trùng. `seen` đếm số lần đã gặp nội dung đó
// trong cùng một lần đồng bộ → mỗi dòng ra một khóa riêng, idempotent khi ERP trả về theo thứ tự ổn định.
function buildKeys(r, seen) {
  const codePart = clean(r.code_part);
  const phanKey = codePart
    || `A-${md5([r.order_name, r.item_name, r.fabric_color, r.fabric_size, r.film_size].map(clean).join('|'))}`;
  const content = [
    r.order_name, r.item_name, codePart, r.fabric_color, r.fabric_size, r.film_size,
    r.created_date, r.received_qty,
  ].map(clean).join('|');
  const occ = (seen.get(content) || 0) + 1;
  seen.set(content, occ);
  const dotKey = `ERP-${md5(`${content}#${occ}`)}`;
  return { maPhan: phanKey.slice(0, 50), maDotVai: dotKey.slice(0, 50) };
}

// Cấu hình proxy cho axios: nếu có ERP_PROXY_URL thì dùng tường minh; nếu không trả về undefined
// để axios TỰ đọc HTTP_PROXY/HTTPS_PROXY/NO_PROXY từ env (giống app cũ chạy được).
function erpProxy() {
  if (!env.erp.proxyUrl) return undefined;
  try {
    const u = new URL(env.erp.proxyUrl);
    return { host: u.hostname, port: Number(u.port) || 80, protocol: u.protocol.replace(':', '') };
  } catch { return undefined; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Lỗi TẠM THỜI phía ERP (nên thử lại): deadlock SQL Server ("Rerun the transaction"), 5xx, timeout, lỗi mạng.
function isTransientErp(e) {
  const msg = String(e && e.message || '').toLowerCase();
  if (msg.includes('deadlock') || msg.includes('rerun the transaction') || msg.includes('timeout expired')) return true;
  const code = e && e.errorCode;
  return code === 'ERP_HTTP' || code === 'ERP_TIMEOUT' || code === 'ERP_FETCH_FAILED';
}

// Gọi ERP có TỰ THỬ LẠI khi lỗi tạm thời (proc ERP hay deadlock — nó bảo "Rerun the transaction").
async function fetchErp(baseUrl, fromDate) {
  const maxTry = Math.max(1, env.erp.retry || 3);
  let lastErr;
  for (let i = 1; i <= maxTry; i += 1) {
    try {
      return await fetchErpAttempt(baseUrl, fromDate);
    } catch (e) {
      lastErr = e;
      if (i < maxTry && isTransientErp(e)) {
        const wait = 3000 * i; // 3s, 6s...
        console.warn(`[erp-sync] ⟳ Lỗi tạm thời (lần ${i}/${maxTry}), thử lại sau ${wait / 1000}s: ${e.message}`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// Gọi ERP bằng AXIOS (không phải fetch của Node/undici). Lý do: app cũ dùng axios chạy được vì axios
// TỰ dùng proxy từ biến môi trường, còn `fetch`(undici) thì KHÔNG → hay timeout UND_ERR_CONNECT_TIMEOUT.
async function fetchErpAttempt(baseUrl, fromDate) {
  const url = `${baseUrl}?fromDate=${encodeURIComponent(fromDate)}`;
  const timeoutMs = env.erp.syncTimeoutMs || 600000;
  const t0 = Date.now();
  console.log(`[erp-sync] → GET ${url} (timeout ${Math.round(timeoutMs / 1000)}s)`);
  try {
    const res = await axios.get(url, {
      timeout: timeoutMs,
      headers: { Accept: 'application/json', ...(env.erp.apiHeaders || {}) },
      proxy: erpProxy(),                  // undefined → axios tự đọc HTTP_PROXY env
      validateStatus: () => true,         // tự kiểm status để giữ thông điệp lỗi như cũ
      transformResponse: [(d) => d],      // GIỮ NGUYÊN VĂN chuỗi response (không để axios tự JSON.parse)
    });
    if (res.status < 200 || res.status >= 300) {
      // Đọc thông điệp lỗi ERP trả về (nếu có) để báo đúng nguyên nhân thay vì chỉ "HTTP 500".
      let erpMsg = '';
      try {
        const body = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
        erpMsg = body?.error || body?.message || '';
      } catch { erpMsg = typeof res.data === 'string' ? res.data.slice(0, 300) : ''; }
      console.error(`[erp-sync] ✗ HTTP ${res.status}: ${erpMsg}`);
      throw new AppError(`ERP trả về HTTP ${res.status}${erpMsg ? `: ${erpMsg}` : ''}`, { status: 502, errorCode: 'ERP_HTTP' });
    }
    const rawText = typeof res.data === 'string' ? res.data : JSON.stringify(res.data); // chuỗi gốc
    let json;
    try { json = JSON.parse(rawText); }
    catch { throw new AppError('ERP trả về không phải JSON', { status: 502, errorCode: 'ERP_BAD_JSON' }); }
    if (!json || json.success === false) {
      throw new AppError(json?.message || 'ERP trả về lỗi', { status: 502, errorCode: 'ERP_ERROR' });
    }
    const data = Array.isArray(json.data) ? json.data : [];
    console.log(`[erp-sync] ← HTTP ${res.status} sau ${Math.round((Date.now() - t0) / 1000)}s · ${data.length} bản ghi`);
    return { data, rawText };
  } catch (e) {
    const secs = Math.round((Date.now() - t0) / 1000);
    if (e instanceof AppError) throw e;
    if (e.code === 'ECONNABORTED') {
      console.error(`[erp-sync] ✗ Timeout sau ${secs}s`);
      throw new AppError(`ERP timeout (${Math.round(timeoutMs / 1000)}s)`, { status: 504, errorCode: 'ERP_TIMEOUT' });
    }
    // Lỗi mạng (ECONNREFUSED/ETIMEDOUT/ENOTFOUND/UND_ERR_*...).
    const detail = e.code ? ` (${e.code})` : '';
    console.error(`[erp-sync] ✗ ${e.message}${detail} sau ${secs}s — URL: ${url}`);
    throw new AppError(`Không gọi được ERP: ${e.message}${detail}`, { status: 502, errorCode: 'ERP_FETCH_FAILED' });
  }
}

// `tgChuyenReady`: Date = đợt vào READY ngay; null = CHỜ chuyển (pending, ẩn khỏi READY).
// SL đợt vải: LẤY NGUYÊN `received_qty` cho MỌI loại đợt (chốt 07/08/2026) — xem `upsertDotVai`.
async function processRow(r, maPhan, maDotVai, loaiDotVaiId, tgChuyenReady) {
  return withTransaction(async (client) => {
    const khId = await repo.upsertKhachHang(client, { ma: clean(r.customer_name), ten: clean(r.customer_name) });
    const donId = await repo.upsertDonHang(client, { maDon: clean(r.order_name), khachHangId: khId, ddhId: erpDdhId(r) });
    const mhId = await repo.upsertMaHang(client, { donHangId: donId, maHang: clean(r.item_name), tenMaHang: clean(r.item_name) });
    const pinId = await repo.upsertPhanIn(client, {
      maHangId: mhId, maPhan,
      mauVai: clean(r.fabric_color), kichVai: clean(r.fabric_size), kichPhim: clean(r.film_size),
      soLuongDonHang: r.order_qty ?? null,
      tinhChatIn: erpTinhChatIn(r),
      // `phan_in.barcode` = ERP `BarcodePTHDH` (mã vạch của CHÍNH phần in). Không phải IDDotReady —
      // mã đó thuộc ĐỢT VẢI và đã chuyển sang `dot_vai_ve.barcode` từ mig 061.
      // `upsertPhanIn` dùng COALESCE ⇒ lần sync mà ERP không gửi trường này thì GIỮ giá trị cũ.
      barcode: erpBarcodePhanIn(r),
    });
    const { id: dotVaiId, inserted } = await repo.upsertDotVai(client, {
      maDotVai, phanInId: pinId, loaiDotVaiId,
      ngayVaiVe: erpNgayVaiVe(r), hanGiao: toDate(r.due_date), soLuong: r.received_qty ?? null,
      tgChuyenReady: tgChuyenReady || null, barcode: erpBarcode(r), inset: erpInset(r),
      nhaGiaCong: erpNhaGiaCong(r), ddhSubId: erpDdhSubId(r), duAn: erpDuAn(r),
    });
    return { inserted, dotVaiId, pinId };
  });
}

// Map trường ERP `loaikd` → loại đợt vải CHUẨN đã seed: 3I = SO_LUONG · 5I = BO_SUNG · 6I = MAU_SO_LUONG.
// Thiếu / mã khác → mặc định SO_LUONG. Chỉ TRA id loại có sẵn (không tạo loại rác kiểu '3I').
const LOAIKD_MAP = { '3I': 'SO_LUONG', '5I': 'BO_SUNG', '6I': 'MAU_SO_LUONG' };

// ⚠ ĐÃ GỠ `LOAIKD_NGUYEN_SL`/`laNguyenSoLuong` (chốt 07/08/2026): luật DELTA lũy kế bị bỏ HOÀN TOÀN
// nên MỌI loại đợt đều lấy nguyên `received_qty` — không còn loại nào cần "ngoại lệ" nữa.
// (Mig 070 vẫn giữ nguyên vai trò khác của `6I`: seed danh mục loại đợt "Mẫu số lượng" + whitelist `LAY_LOAIKD`.)
function makeLoaiResolver() {
  const cache = new Map();
  return async (loaikd) => {
    const maLoai = LOAIKD_MAP[clean(loaikd).toUpperCase()] || 'SO_LUONG';
    if (cache.has(maLoai)) return cache.get(maLoai);
    const id = await repo.getLoaiDotVaiId(maLoai);
    cache.set(maLoai, id);
    return id;
  };
}

// fromDate mặc định = THỜI ĐIỂM HIỆN TẠI, định dạng 'YYYY-MM-DDTHH:mm:ss' (giờ local, không hậu tố 'Z' UTC).
function defaultFrom() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Tự gom set từ ERP: **`Inset` ≠ 0 VÀ cùng `BarcodeHKT`** → 1 nhóm gom set.
// (Inset chỉ là CỜ CÓ GOM SET + số nhóm bên ERP; thứ quyết định "gom với ai" là BarcodeHKT —
// khi có gom set, ERP gửi NHIỀU code phần dùng CHUNG 1 barcode HSKT ⇒ 1 HSKT ↔ N phần in.)
// Idempotent: nhận diện set đã tạo qua ghi_chu; cần ≥2 đợt vải thuộc ≥2 phần in.
async function autoGomSetByHskt(barcodeHskt, inset, dotVaiIds, actorId) {
  const rows = await repo.eligibleDotVaiByIds(dotVaiIds);
  const dvIds = rows.map((r) => r.id);
  const distinctPins = new Set(rows.map((r) => r.phan_in_id));
  if (dvIds.length < 2 || distinctPins.size < 2) return;
  const ghiChu = `ERP gom set · HSKT ${barcodeHskt} · Inset ${inset}`;
  if (await repo.openSetByGhiChu(ghiChu)) return; // đã gom rồi
  const maSet = await gomRepo.nextMaSet();
  await withTransaction(async (client) => {
    const setId = await gomRepo.createSet(client, { maSet, ghiChu }, actorId);
    for (const id of dvIds) await gomRepo.addDotVai(client, setId, id, actorId);
    await gomRepo.logGomAction(client, setId, 'CREATE_SET',
      `Tự gom từ ERP (HSKT ${barcodeHskt}, Inset=${inset}): ${dvIds.length} đợt vải / ${distinctPins.size} phần in`, actorId);
  });
  sockets.emit('workflow:updated', { stage: 'GOM_SET', source: 'erp' });
}

// Đồng bộ ERP (MỘT API duy nhất `/phieu-nhan-vai-60`): mọi đợt vải hợp lệ vào THẲNG READY,
// rồi cờ `KTCankiemtra` quyết định ở lại READY (=1) hay giả lập KT xong để đi thẳng Release 1 (=0).
// (Luồng 2 API "lấy trước" đã BỎ — không còn trạng thái "chờ chuyển READY".)
async function runSync({ baseUrl, nguon, fromDate, actorId = null, tuDong = false }) {
  const from = fromDate || defaultFrom();
  const logId = await repo.createSyncLog({ nguon, fromDate: from, tuDong }, actorId);
  try {
    const { data: rows, rawText } = await fetchErp(baseUrl, from);

    try { await repo.saveSyncRaw(logId, rawText); }
    catch (e) { console.error(`[erp-sync] ✗ Lưu chuỗi thô lỗi: ${e.message}`); }

    // Lọc dòng: bỏ khi thiếu code_part, loaikd ngoài {3I,5I}, hoặc tính chất in ngoài phạm vi. (Không lọc khách.)
    const seen = new Map();
    const prepared = rows.map((r) => {
      const noCode = !clean(r.code_part);
      const isBoLoai = !LAY_LOAIKD.has(clean(r.loaikd).toUpperCase());
      const isBoTcin = BO_TINH_CHAT_IN.has(normTcin(erpTinhChatIn(r)));
      const { maPhan, maDotVai } = buildKeys(r, seen);
      return { r, maPhan, maDotVai, skip: noCode || isBoLoai || isBoTcin, noCode, isBoLoai, isBoTcin };
    });

    try {
      await repo.insertRawBatch(logId, prepared.map((p) => ({
        maDotVai: p.maDotVai, codePart: clean(p.r.code_part) || null, boQua: p.skip, payload: p.r,
      })));
    } catch (e) { console.error(`[erp-sync] ✗ Lưu dữ liệu thô lỗi: ${e.message}`); }

    let soMoi = 0; let soCapNhat = 0; let soBoQua = 0; let soKhongCode = 0; let soBoLoai = 0; let soBoTcin = 0;
    const errors = [];
    const newDotVaiIds = [];
    // Nhóm gom set: khóa = "<BarcodeHKT>#<Inset>" (Inset≠0) → { barcodeHskt, inset, dotVaiIds, pinIds }.
    const insetGroups = new Map();
    // HSKT bị đụng trong lần sync này → chạy POST-PASS áp luật sản lượng (≥2000 = in Máy) sau khi
    // đã upsert xong MỌI đợt vải, để tổng SL là số cuối cùng (chạy giữa vòng lặp sẽ sinh phiên bản rác).
    const hsktTouched = new Set();
    const resolveLoai = makeLoaiResolver();
    for (const p of prepared) {
      if (p.skip) {
        soBoQua += 1;
        if (p.noCode) soKhongCode += 1; else if (p.isBoLoai) soBoLoai += 1; else if (p.isBoTcin) soBoTcin += 1;
        continue;
      }
      // `laDotMoi` = lần sync NÀY có đợt vải MỚI vào READY (insert mới, hoặc promote đợt cũ còn kẹt).
      // Tách khỏi `intoReady` (chỉ nghĩa "dòng xử lý xong") vì luật KTCankiemtra chỉ áp cho ĐỢT MỚI.
      let pinId = null; let affectedDotVaiIds = []; let intoReady = false; let laDotMoi = false;
      try {
        const tgPhoi = Number(p.r.tgphoi);
        // Upsert theo `ma_dot_vai` (idempotent): đợt mới thì tạo, đợt đã có thì cập nhật —
        // phần in đã tồn tại vẫn nhận thêm đợt vải mới. Mốc vào READY = now().
        const loaiDotVaiId = await resolveLoai(p.r.loaikd);
        const { inserted, dotVaiId, pinId: pid } = await processRow(p.r, p.maPhan, p.maDotVai, loaiDotVaiId, new Date());
        if (inserted) { soMoi += 1; newDotVaiIds.push(dotVaiId); } else soCapNhat += 1;
        pinId = pid; affectedDotVaiIds = [dotVaiId]; intoReady = true; laDotMoi = !!inserted;
        if (Number.isFinite(tgPhoi) && tgPhoi > 0) await repo.setPhanInDryMin(pid, Math.round(tgPhoi));
        // Dọn dữ liệu CŨ thời 2 API: đợt của phần in này còn kẹt "chờ chuyển" (tg_chuyen_ready NULL)
        // → đưa nốt vào READY. Dữ liệu mới không bao giờ rơi vào nhánh này.
        const promoted = await repo.promotePhanInToReady(pid, {
          barcode: erpBarcode(p.r), tinhChatIn: erpTinhChatIn(p.r),
        });
        promoted.forEach((id) => { newDotVaiIds.push(id); affectedDotVaiIds.push(id); });
        if (promoted.length) laDotMoi = true;
      } catch (e) { errors.push(e.message); }

      // Xử lý phụ (HSKT / KTCankiemtra / gom set) — BEST-EFFORT, không chặn đồng bộ đợt.
      if (pinId) {
        const barcodeHskt = erpBarcodeHskt(p.r);
        const pain = erpPain(p.r);
        const inset = erpInset(p.r);
        const ktCan = erpKtCanKiemTra(p.r);
        // `maPhan` để đặt tên HSKT khi ERP thiếu BarcodeHKT (vẫn giữ được phương án in).
        try {
          const hid = await repo.upsertHsktForPin({ pinId, barcodeHskt, pain, inset, maDonReady: erpBarcode(p.r), maPhan: p.maPhan, actorId });
          if (hid) hsktTouched.add(hid);
        } catch (e) { console.error(`[erp-sync] ✗ HSKT lỗi (${p.maPhan}): ${e.message}`); }
        try { if (ktCan != null) await repo.setDotVaiKtCanKiemTra(affectedDotVaiIds, ktCan); }
        catch (e) { console.error(`[erp-sync] ✗ kt_can_kiem_tra lỗi: ${e.message}`); }
        // ⚠⚠ CHỈ áp luật KTCankiemtra cho ĐỢT VẢI MỚI (`laDotMoi`), KHÔNG áp mỗi lần sync.
        // ERP trả lại CÙNG dòng ở mọi lần chạy (job 5 phút/lần) và upsert là idempotent theo `ma_dot_vai`,
        // nên nếu chạy theo `intoReady` thì:
        //   · KTCankiemtra=1: phần in VỪA được Kế hoạch Release 1 xong sẽ khớp `canLamLaiReady` ở lần
        //     sync kế tiếp ⇒ `reopenReadyForPhanIn` XÓA SẠCH xác nhận Khuôn/Film/Mực/QC của chính nó,
        //     trong khi LỆNH vẫn còn ⇒ phần in "chưa Ready mà đã nằm ở Test Run".
        //     (Đã xảy ra thật 03/08/2026: 3 phần in release lúc 13:46–13:47 bị hủy READY lúc 13:48.)
        //   · KTCankiemtra=0: `simulateReadyDone` tự xác nhận lại READY sau mỗi lần sync, đè lên thao tác
        //     hủy xác nhận / trả về kỹ thuật của người dùng.
        // Đợt vải MỚI mới là lúc câu hỏi "kỹ thuật có cần kiểm tra lại không?" có nghĩa.
        if (laDotMoi) {
          try {
            if (ktCan === 0) await repo.simulateReadyDone(pinId);              // giả lập KT xong → Release 1
            // KTCankiemtra=1 & phần in đã xong READY một lần rồi (đợt trước ĐÃ RELEASE **hoặc** đã QC
            // xác nhận READY dù chưa release) → mở lại READY để kỹ thuật kiểm lại cho đợt vải mới.
            else if (await repo.canLamLaiReady(pinId, affectedDotVaiIds)) await repo.reopenReadyForPhanIn(pinId);
          } catch (e) { console.error(`[erp-sync] ✗ KTCankiemtra lỗi (${p.maPhan}): ${e.message}`); }
        }
        if (intoReady) {
          // Gom set: Inset ≠ 0 (có gom set) + CÙNG BarcodeHKT (ERP dùng chung 1 HSKT cho cả nhóm).
          if (inset != null && inset !== 0 && barcodeHskt) {
            const key = `${barcodeHskt}#${inset}`;
            if (!insetGroups.has(key)) insetGroups.set(key, { barcodeHskt, inset, dotVaiIds: new Set(), pinIds: new Set() });
            const g = insetGroups.get(key);
            affectedDotVaiIds.forEach((id) => g.dotVaiIds.add(id));
            g.pinIds.add(pinId);
          }
        }
      }
    }
    // Đợt vào READY → theo dõi dòng chảy.
    if (newDotVaiIds.length) await tracking.moveDotVaiTo(newDotVaiIds, 'READY', actorId);
    // Auto gom set từ ERP: Inset≠0 & CÙNG BarcodeHKT có ≥2 phần in → gom (idempotent theo ghi_chu).
    for (const [key, g] of insetGroups) {
      if (g.pinIds.size < 2) continue;
      try { await autoGomSetByHskt(g.barcodeHskt, g.inset, [...g.dotVaiIds], actorId); }
      catch (e) { console.error(`[erp-sync] ✗ Auto gom set lỗi (${key}): ${e.message}`); }
    }
    // POST-PASS: phương án in theo TỔNG SL VẢI VỀ của cả HSKT (≥2000 → Máy, <2000 → Bàn).
    // Chạy SAU gom set để nhóm set đã đủ thành viên ⇒ tổng cộng đúng cả set. Best-effort.
    let soDoiPain = 0;
    for (const hid of hsktTouched) {
      try {
        const r = await repo.applyPainTheoSanLuong(hid, actorId);
        if (r && r.doi) soDoiPain += 1;
      } catch (e) { console.error(`[erp-sync] ✗ Áp phương án in theo sản lượng lỗi (${hid}): ${e.message}`); }
    }
    const trangThai = errors.length && soMoi + soCapNhat === 0 ? 'LOI' : 'THANH_CONG';
    const notes = [];
    if (soKhongCode) notes.push(`bỏ qua ${soKhongCode} dòng không có code_part`);
    if (soBoLoai) notes.push(`bỏ qua ${soBoLoai} dòng loaikd ngoài ${[...LAY_LOAIKD].join('/')}`);
    if (soBoTcin) notes.push(`bỏ qua ${soBoTcin} dòng tính chất in ngoài phạm vi`);
    if (soDoiPain) notes.push(`đổi phương án in theo sản lượng: ${soDoiPain} HSKT`);
    if (errors.length) notes.push(`lỗi ${errors.length}/${rows.length}: ${errors.slice(0, 3).join(' | ')}`);
    await repo.finishSyncLog(logId, {
      tong: rows.length, soMoi, soCapNhat, soLoi: errors.length, trangThai,
      thongDiep: notes.length ? notes.join(' · ') : null,
    });
    if (soMoi + soCapNhat > 0) {
      sockets.emit('order:updated', { source: 'erp' });
      sockets.emit('dashboard:refresh', {});
    }
    return { logId, tong: rows.length, soMoi, soCapNhat, soBoQua, soLoi: errors.length, trangThai };
  } catch (e) {
    await repo.finishSyncLog(logId, { tong: 0, soMoi: 0, soCapNhat: 0, soLoi: 0, trangThai: 'LOI', thongDiep: e.message });
    throw e;
  }
}

// API DUY NHẤT /phieu-nhan-vai-60 → đợt vải vào READY (hoặc thẳng Release 1 khi KTCankiemtra=0).
async function syncPhieuNhanVai({ fromDate, actorId = null, tuDong = false } = {}) {
  // Tắt ở Hệ thống > Cài đặt API (mig 083). ⚠ Chặn CẢ nút "Đồng bộ ngay" chứ không chỉ job — tắt mà
  // bấm tay vẫn chạy thì công tắc thành vô nghĩa. Báo lỗi rõ để người dùng biết chỗ bật lại.
  // (Job đã tự bỏ qua trước khi gọi tới đây; nhánh này lo đường bấm tay.)
  if (!(await apiBat('ERP_DONG_BO_VAI'))) {
    throw new AppError(
      'Đồng bộ đợt vải từ ERP đang TẮT — bật lại ở Hệ thống > Cài đặt API.',
      { status: 409, errorCode: 'API_DANG_TAT' }
    );
  }
  return runSync({ baseUrl: env.erp.phieuNhanVaiUrl, nguon: NGUON, fromDate, actorId, tuDong });
}


async function history({ date, page, limit, offset } = {}) {
  const { rows, total } = await repo.listSyncHistory({ date: date || null, offset, limit });
  return { items: rows, meta: buildMeta(page, limit, total) };
}

// Chuỗi response nguyên văn của 1 lần đồng bộ.
async function rawData(logId) {
  const text = await repo.getSyncRaw(logId);
  return { chuoi_tho: text || null };
}

module.exports = { syncPhieuNhanVai, history, rawData, autoGomSetByHskt };
