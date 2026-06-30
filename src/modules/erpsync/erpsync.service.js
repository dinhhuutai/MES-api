'use strict';

const crypto = require('crypto');
const { withTransaction } = require('../../config/db');
const repo = require('./erpsync.repository');
const env = require('../../config/env');
const AppError = require('../../utils/AppError');
const sockets = require('../../sockets');

const NGUON = 'phieu_nhan_vai_60';

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const clean = (v) => (v == null ? '' : String(v).trim());
// DATE 'YYYY-MM-DD' từ chuỗi ISO (cắt phần ngày, không lệch timezone).
const toDate = (v) => (v ? String(v).slice(0, 10) : null);

// Khóa định danh ổn định để upsert (tránh trùng khi đồng bộ lặp lại mỗi giờ).
function buildKeys(r) {
  const codePart = clean(r.code_part);
  const phanKey = codePart
    || `A-${md5([r.order_name, r.item_name, r.fabric_color, r.fabric_size, r.film_size].map(clean).join('|'))}`;
  const dotKey = `ERP-${md5([
    r.order_name, r.item_name, codePart, r.fabric_color, r.fabric_size, r.film_size, r.created_date,
  ].map(clean).join('|'))}`;
  return { maPhan: phanKey.slice(0, 50), maDotVai: dotKey.slice(0, 50) };
}

async function fetchErp(fromDate) {
  const url = `${env.erp.phieuNhanVaiUrl}?fromDate=${encodeURIComponent(fromDate)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new AppError(`ERP trả về HTTP ${res.status}`, { status: 502, errorCode: 'ERP_HTTP' });
    const json = await res.json();
    if (!json || json.success === false) {
      throw new AppError(json?.message || 'ERP trả về lỗi', { status: 502, errorCode: 'ERP_ERROR' });
    }
    return Array.isArray(json.data) ? json.data : [];
  } catch (e) {
    if (e.name === 'AbortError') throw new AppError('ERP timeout (30s)', { status: 504, errorCode: 'ERP_TIMEOUT' });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function processRow(r) {
  const { maPhan, maDotVai } = buildKeys(r);
  return withTransaction(async (client) => {
    const khId = await repo.upsertKhachHang(client, { ma: clean(r.customer_name), ten: clean(r.customer_name) });
    const donId = await repo.upsertDonHang(client, { maDon: clean(r.order_name), khachHangId: khId });
    const mhId = await repo.upsertMaHang(client, { donHangId: donId, maHang: clean(r.item_name), tenMaHang: clean(r.item_name) });
    const pinId = await repo.upsertPhanIn(client, {
      maHangId: mhId, maPhan,
      mauVai: clean(r.fabric_color), kichVai: clean(r.fabric_size), kichPhim: clean(r.film_size),
      soLuongDonHang: r.order_qty ?? null,
    });
    const { inserted } = await repo.upsertDotVai(client, {
      maDotVai, phanInId: pinId,
      ngayVaiVe: toDate(r.erp_datetime || r.created_date), hanGiao: toDate(r.due_date), soLuong: r.received_qty ?? null,
    });
    return inserted;
  });
}

// fromDate mặc định = hiện tại - N ngày (proc ERP lọc created_date >= fromDate; truyền now sẽ ra 0 bản ghi).
function defaultFrom() {
  const days = Math.max(1, env.erp.syncLookbackDays || 60);
  return new Date(Date.now() - days * 86400000).toISOString();
}

// Đồng bộ phiếu nhận vải từ ERP.
async function syncPhieuNhanVai({ fromDate, actorId = null, tuDong = false } = {}) {
  const from = fromDate || defaultFrom();
  const logId = await repo.createSyncLog({ nguon: NGUON, fromDate: from, tuDong }, actorId);
  try {
    const rows = await fetchErp(from);
    let soMoi = 0; let soCapNhat = 0; const errors = [];
    for (const r of rows) {
      try {
        const inserted = await processRow(r);
        if (inserted) soMoi += 1; else soCapNhat += 1;
      } catch (e) {
        errors.push(e.message);
      }
    }
    const trangThai = errors.length && soMoi + soCapNhat === 0 ? 'LOI' : 'THANH_CONG';
    await repo.finishSyncLog(logId, {
      tong: rows.length, soMoi, soCapNhat, soLoi: errors.length, trangThai,
      thongDiep: errors.length ? `Lỗi ${errors.length}/${rows.length}: ${errors.slice(0, 3).join(' | ')}` : null,
    });
    if (soMoi + soCapNhat > 0) {
      sockets.emit('order:updated', { source: 'erp' });
      sockets.emit('dashboard:refresh', {});
    }
    return { logId, tong: rows.length, soMoi, soCapNhat, soLoi: errors.length, trangThai };
  } catch (e) {
    await repo.finishSyncLog(logId, { tong: 0, soMoi: 0, soCapNhat: 0, soLoi: 0, trangThai: 'LOI', thongDiep: e.message });
    throw e;
  }
}

async function history(limit) {
  return repo.listSyncHistory(limit || 50);
}

module.exports = { syncPhieuNhanVai, history };
