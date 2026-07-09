'use strict';

const crypto = require('crypto');
const axios = require('axios');
const { withTransaction } = require('../../config/db');
const repo = require('./erpsync.repository');
const env = require('../../config/env');
const AppError = require('../../utils/AppError');
const sockets = require('../../sockets');
const tracking = require('../workflow/tracking.service');

const NGUON = 'phieu_nhan_vai_60';

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const clean = (v) => (v == null ? '' : String(v).trim());
// DATE 'YYYY-MM-DD' từ chuỗi ISO (cắt phần ngày, không lệch timezone).
const toDate = (v) => (v ? String(v).slice(0, 10) : null);

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

// Gọi ERP bằng AXIOS (không phải fetch của Node/undici). Lý do: app cũ dùng axios chạy được vì axios
// TỰ dùng proxy từ biến môi trường, còn `fetch`(undici) thì KHÔNG → hay timeout UND_ERR_CONNECT_TIMEOUT.
async function fetchErp(fromDate) {
  const url = `${env.erp.phieuNhanVaiUrl}?fromDate=${encodeURIComponent(fromDate)}`;
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

async function processRow(r, maPhan, maDotVai, loaiDotVaiId) {
  return withTransaction(async (client) => {
    const khId = await repo.upsertKhachHang(client, { ma: clean(r.customer_name), ten: clean(r.customer_name) });
    const donId = await repo.upsertDonHang(client, { maDon: clean(r.order_name), khachHangId: khId });
    const mhId = await repo.upsertMaHang(client, { donHangId: donId, maHang: clean(r.item_name), tenMaHang: clean(r.item_name) });
    const pinId = await repo.upsertPhanIn(client, {
      maHangId: mhId, maPhan,
      mauVai: clean(r.fabric_color), kichVai: clean(r.fabric_size), kichPhim: clean(r.film_size),
      soLuongDonHang: r.order_qty ?? null,
    });
    const { id: dotVaiId, inserted } = await repo.upsertDotVai(client, {
      maDotVai, phanInId: pinId, loaiDotVaiId,
      ngayVaiVe: toDate(r.erp_datetime || r.created_date), hanGiao: toDate(r.due_date), soLuong: r.received_qty ?? null,
    });
    return { inserted, dotVaiId, pinId };
  });
}

// Loại đợt vải theo trường ERP `loaikd`; ERP không trả → '3I'. Cache theo lần sync
// (nhiều dòng chung 1 loại) + best-effort (không tạo được → null → đợt vải để loai trống, không phá sync).
function makeLoaiResolver() {
  const cache = new Map();
  return async (loaikd) => {
    const ma = (clean(loaikd) || '3I').slice(0, 50);
    if (cache.has(ma)) return cache.get(ma);
    const id = await repo.upsertLoaiDotVai({ maLoai: ma, tenLoai: ma.slice(0, 255) });
    cache.set(ma, id);
    return id;
  };
}

// fromDate mặc định = THỜI ĐIỂM HIỆN TẠI, định dạng 'YYYY-MM-DDTHH:mm:ss' (giờ local, không hậu tố 'Z' UTC).
function defaultFrom() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Đồng bộ phiếu nhận vải từ ERP.
async function syncPhieuNhanVai({ fromDate, actorId = null, tuDong = false } = {}) {
  const from = fromDate || defaultFrom();
  const logId = await repo.createSyncLog({ nguon: NGUON, fromDate: from, tuDong }, actorId);
  try {
    const { data: rows, rawText } = await fetchErp(from);

    // Lưu NGUYÊN VĂN chuỗi ERP trả về cho lần này (để xem lại "lần đó trả về gì").
    try { await repo.saveSyncRaw(logId, rawText); }
    catch (e) { console.error(`[erp-sync] ✗ Lưu chuỗi thô lỗi: ${e.message}`); }

    // Tính khóa định danh cho TỪNG dòng (mỗi bản ghi = 1 đợt; xem buildKeys).
    // Bỏ qua khi: (1) không đúng khách 'SL', hoặc (2) không có code_part.
    const seen = new Map();
    const prepared = rows.map((r) => {
      const notSl = clean(r.customer_name).toUpperCase() !== 'SL';
      const noCode = !clean(r.code_part);
      const { maPhan, maDotVai } = buildKeys(r, seen);
      return { r, maPhan, maDotVai, skip: notSl || noCode, notSl, noCode };
    });

    // Task 1: LƯU DỮ LIỆU THÔ trước khi xử lý (gồm cả dòng bị bỏ qua).
    try {
      await repo.insertRawBatch(logId, prepared.map((p) => ({
        maDotVai: p.maDotVai, codePart: clean(p.r.code_part) || null, boQua: p.skip, payload: p.r,
      })));
    } catch (e) {
      console.error(`[erp-sync] ✗ Lưu dữ liệu thô lỗi: ${e.message}`);
    }

    let soMoi = 0; let soCapNhat = 0; let soBoQua = 0; let soKhongSl = 0; let soKhongCode = 0;
    const errors = [];
    const newDotVaiIds = [];
    const resolveLoai = makeLoaiResolver();
    for (const p of prepared) {
      // Bỏ qua dòng không phải khách 'SL' hoặc không có code_part.
      if (p.skip) {
        soBoQua += 1;
        if (p.notSl) soKhongSl += 1; else if (p.noCode) soKhongCode += 1;
        continue;
      }
      try {
        const loaiDotVaiId = await resolveLoai(p.r.loaikd);            // ngoài transaction, best-effort
        const { inserted, dotVaiId, pinId } = await processRow(p.r, p.maPhan, p.maDotVai, loaiDotVaiId);
        if (inserted) { soMoi += 1; newDotVaiIds.push(dotVaiId); } else soCapNhat += 1;
        // tgphoi (phút) → thời gian chờ khô của phần in (best-effort, không phá sync nếu thiếu cột).
        const tgPhoi = Number(p.r.tgphoi);
        if (Number.isFinite(tgPhoi) && tgPhoi > 0) await repo.setPhanInDryMin(pinId, Math.round(tgPhoi));
      } catch (e) {
        errors.push(e.message);
      }
    }
    // Theo dõi dòng chảy: đợt vải mới nhận từ ERP → vào thẳng trạm READY
    // (hệ MES này BẮT ĐẦU TỪ READY — dữ liệu ERP về coi như đã mở đơn, chờ chuẩn bị kỹ thuật). Best-effort.
    if (newDotVaiIds.length) await tracking.moveDotVaiTo(newDotVaiIds, 'READY', actorId);
    const trangThai = errors.length && soMoi + soCapNhat === 0 ? 'LOI' : 'THANH_CONG';
    const notes = [];
    if (soKhongSl) notes.push(`bỏ qua ${soKhongSl} dòng không phải khách 'SL'`);
    if (soKhongCode) notes.push(`bỏ qua ${soKhongCode} dòng không có code_part`);
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

async function history(limit) {
  return repo.listSyncHistory(limit || 50);
}

// Chuỗi response nguyên văn của 1 lần đồng bộ.
async function rawData(logId) {
  const text = await repo.getSyncRaw(logId);
  return { chuoi_tho: text || null };
}

module.exports = { syncPhieuNhanVai, history, rawData };
