'use strict';

const crypto = require('crypto');
const axios = require('axios');
const { withTransaction } = require('../../config/db');
const repo = require('./erpsync.repository');
const env = require('../../config/env');
const AppError = require('../../utils/AppError');
const { buildMeta } = require('../../utils/pagination');
const sockets = require('../../sockets');
const tracking = require('../workflow/tracking.service');

const NGUON = 'phieu_nhan_vai_60';          // API chính thức → chuyển phần in qua READY
const NGUON_NEW = 'phieu_nhan_vai_60_new';  // API lấy trước → đợt vải CHỜ chuyển READY (trừ 5I)

// Loại kinh doanh (`loaikd`) CHỈ LẤY khi đồng bộ: 3I = số lượng (SO_LUONG), 5I = bổ sung (BO_SUNG).
// Mọi loại khác → BỎ QUA. (Trước đây lọc theo khách hàng 'SL' + blacklist 8I/2I; nay bỏ lọc khách,
// chuyển sang whitelist loaikd cho rõ ràng.) Thêm/bớt mã ở đây.
const LAY_LOAIKD = new Set(['3I', '5I']);

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
  'T+LS', 'TB+EP DINH', 'TB+EP NHIET', 'TB+KIENGUIBONG',
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
const erpTinhChatIn = (r) => clean(field(r, 'Tinhchatin', 'tinh_chat_in', 'tinhchat_in')) || null;
// Mã vạch (dãy số) từ ERP — trường `maquet` (cũ: barCode) → phan_in.barcode (đầu đọc quét để tích ở READY).
const erpBarcode = (r) => clean(field(r, 'maquet', 'ma_quet', 'barCode', 'barcode', 'ma_vach', 'mavach')) || null;
// Ngày vải về: ưu tiên NgayNhanvai (ERP mới), lùi về erp_datetime/created_date như trước.
const erpNgayVaiVe = (r) => toDate(field(r, 'NgayNhanvai', 'ngay_nhan_vai', 'ngay_vai_ve') || r.erp_datetime || r.created_date);

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
async function processRow(r, maPhan, maDotVai, loaiDotVaiId, tgChuyenReady) {
  return withTransaction(async (client) => {
    const khId = await repo.upsertKhachHang(client, { ma: clean(r.customer_name), ten: clean(r.customer_name) });
    const donId = await repo.upsertDonHang(client, { maDon: clean(r.order_name), khachHangId: khId });
    const mhId = await repo.upsertMaHang(client, { donHangId: donId, maHang: clean(r.item_name), tenMaHang: clean(r.item_name) });
    const pinId = await repo.upsertPhanIn(client, {
      maHangId: mhId, maPhan,
      mauVai: clean(r.fabric_color), kichVai: clean(r.fabric_size), kichPhim: clean(r.film_size),
      soLuongDonHang: r.order_qty ?? null,
      tinhChatIn: erpTinhChatIn(r),
      barcode: erpBarcode(r),
    });
    const { id: dotVaiId, inserted } = await repo.upsertDotVai(client, {
      maDotVai, phanInId: pinId, loaiDotVaiId,
      ngayVaiVe: erpNgayVaiVe(r), hanGiao: toDate(r.due_date), soLuong: r.received_qty ?? null,
      tgChuyenReady: tgChuyenReady || null,
    });
    return { inserted, dotVaiId, pinId };
  });
}

// Map trường ERP `loaikd` → loại đợt vải CHUẨN đã seed: 3I = SO_LUONG, 5I = BO_SUNG.
// Thiếu / mã khác → mặc định SO_LUONG. Chỉ TRA id loại có sẵn (không tạo loại rác kiểu '3I').
const LOAIKD_MAP = { '3I': 'SO_LUONG', '5I': 'BO_SUNG' };
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

// Đồng bộ 1 nguồn ERP. `official=false` (API -new): đợt CHỜ chuyển READY (3I) hoặc vào READY luôn (5I).
// `official=true` (API chính thức): code phần đã có → cập nhật barcode + chuyển pending sang READY;
// chưa có → tạo mới + vào READY.
async function runSync({ baseUrl, nguon, official, fromDate, actorId = null, tuDong = false }) {
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

    let soMoi = 0; let soCapNhat = 0; let soBoQua = 0; let soKhongCode = 0; let soBoLoai = 0; let soBoTcin = 0; let soChoChuyen = 0;
    const errors = [];
    const newDotVaiIds = [];
    const resolveLoai = makeLoaiResolver();
    for (const p of prepared) {
      if (p.skip) {
        soBoQua += 1;
        if (p.noCode) soKhongCode += 1; else if (p.isBoLoai) soBoLoai += 1; else if (p.isBoTcin) soBoTcin += 1;
        continue;
      }
      try {
        const tgPhoi = Number(p.r.tgphoi);
        if (official) {
          // Chính thức: đã có code phần → cập nhật barcode + chuyển pending sang READY; chưa có → tạo mới + READY.
          const existingPinId = await repo.findPhanInIdByMaPhan(p.maPhan);
          if (existingPinId) {
            const promoted = await repo.promotePhanInToReady(existingPinId, {
              barcode: erpBarcode(p.r), tinhChatIn: erpTinhChatIn(p.r),
            });
            promoted.forEach((id) => newDotVaiIds.push(id));
            soCapNhat += 1;
            if (Number.isFinite(tgPhoi) && tgPhoi > 0) await repo.setPhanInDryMin(existingPinId, Math.round(tgPhoi));
          } else {
            const loaiDotVaiId = await resolveLoai(p.r.loaikd);
            const { inserted, dotVaiId, pinId } = await processRow(p.r, p.maPhan, p.maDotVai, loaiDotVaiId, new Date());
            if (inserted) { soMoi += 1; newDotVaiIds.push(dotVaiId); } else soCapNhat += 1;
            if (Number.isFinite(tgPhoi) && tgPhoi > 0) await repo.setPhanInDryMin(pinId, Math.round(tgPhoi));
          }
        } else {
          // -new: 5I → vào READY ngay; 3I (và khác) → CHỜ chuyển (pending, tg_chuyen_ready = null).
          const is5I = clean(p.r.loaikd).toUpperCase() === '5I';
          const tgReady = is5I ? new Date() : null;
          const loaiDotVaiId = await resolveLoai(p.r.loaikd);
          const { inserted, dotVaiId, pinId } = await processRow(p.r, p.maPhan, p.maDotVai, loaiDotVaiId, tgReady);
          if (inserted) { soMoi += 1; if (tgReady) newDotVaiIds.push(dotVaiId); else soChoChuyen += 1; } else soCapNhat += 1;
          if (Number.isFinite(tgPhoi) && tgPhoi > 0) await repo.setPhanInDryMin(pinId, Math.round(tgPhoi));
        }
      } catch (e) { errors.push(e.message); }
    }
    // Đợt vào READY → theo dõi dòng chảy (trigger mig 054 đã guard: chỉ đợt tg_chuyen_ready ≠ null).
    if (newDotVaiIds.length) await tracking.moveDotVaiTo(newDotVaiIds, 'READY', actorId);
    const trangThai = errors.length && soMoi + soCapNhat === 0 ? 'LOI' : 'THANH_CONG';
    const notes = [];
    if (soChoChuyen) notes.push(`${soChoChuyen} đợt chờ chuyển READY (3I)`);
    if (soKhongCode) notes.push(`bỏ qua ${soKhongCode} dòng không có code_part`);
    if (soBoLoai) notes.push(`bỏ qua ${soBoLoai} dòng loaikd ngoài ${[...LAY_LOAIKD].join('/')}`);
    if (soBoTcin) notes.push(`bỏ qua ${soBoTcin} dòng tính chất in ngoài phạm vi`);
    if (errors.length) notes.push(`lỗi ${errors.length}/${rows.length}: ${errors.slice(0, 3).join(' | ')}`);
    await repo.finishSyncLog(logId, {
      tong: rows.length, soMoi, soCapNhat, soLoi: errors.length, trangThai,
      thongDiep: notes.length ? notes.join(' · ') : null,
    });
    if (soMoi + soCapNhat > 0) {
      sockets.emit('order:updated', { source: 'erp' });
      sockets.emit('dashboard:refresh', {});
    }
    return { logId, tong: rows.length, soMoi, soCapNhat, soBoQua, soChoChuyen, soLoi: errors.length, trangThai };
  } catch (e) {
    await repo.finishSyncLog(logId, { tong: 0, soMoi: 0, soCapNhat: 0, soLoi: 0, trangThai: 'LOI', thongDiep: e.message });
    throw e;
  }
}

// API CHÍNH THỨC /phieu-nhan-vai-60 → chuyển phần in qua READY.
async function syncPhieuNhanVai({ fromDate, actorId = null, tuDong = false } = {}) {
  return runSync({ baseUrl: env.erp.phieuNhanVaiUrl, nguon: NGUON, official: true, fromDate, actorId, tuDong });
}

// API LẤY TRƯỚC /phieu-nhan-vai-60-new → đợt vải CHỜ chuyển READY (trừ 5I vào thẳng READY).
async function syncPhieuNhanVaiNew({ fromDate, actorId = null, tuDong = false } = {}) {
  return runSync({ baseUrl: env.erp.phieuNhanVaiNewUrl, nguon: NGUON_NEW, official: false, fromDate, actorId, tuDong });
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

module.exports = { syncPhieuNhanVai, syncPhieuNhanVaiNew, history, rawData };
