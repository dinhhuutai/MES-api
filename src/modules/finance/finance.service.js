'use strict';

const repo = require('./finance.repository');
const AppError = require('../../utils/AppError');
const { buildMeta } = require('../../utils/pagination');
const sockets = require('../../sockets');
const tracking = require('../workflow/tracking.service');

async function listDonHang({ search, status, page, limit, offset }) {
  const { rows, total } = await repo.listDonHang({ search, status, offset, limit });
  return { items: rows, meta: buildMeta(page, limit, total) };
}

async function getCongNo(donHangId) {
  const row = await repo.getCongNo(donHangId);
  if (!row) throw new AppError('Đơn hàng không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  return row;
}

async function saveCongNo(donHangId, payload, actorId) {
  const cur = await repo.getCongNo(donHangId);
  if (!cur) throw new AppError('Đơn hàng không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (cur.trang_thai_cong_no === 'CLOSED_FINANCE') {
    throw new AppError('Đơn đã đóng tài chính, không thể sửa công nợ', { status: 409, errorCode: 'ALREADY_CLOSED' });
  }
  await repo.upsertCongNo(donHangId, payload, actorId);
  return getCongNo(donHangId);
}

async function confirm(donHangId, actorId) {
  const cur = await repo.getCongNo(donHangId);
  if (!cur) throw new AppError('Đơn hàng không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (cur.trang_thai_cong_no === 'CLOSED_FINANCE') {
    throw new AppError('Đơn đã đóng tài chính', { status: 409, errorCode: 'ALREADY_CLOSED' });
  }
  if (cur.tong_tien == null) {
    throw new AppError('Cần nhập tổng công nợ trước khi xác nhận', { status: 400, errorCode: 'MISSING_AMOUNT' });
  }
  await repo.confirm(donHangId, actorId);
  await tracking.moveByDonHang(donHangId, 'CLOSED_FINANCE', actorId); // theo dõi dòng chảy: đóng tài chính
  sockets.emit('workflow:updated', { type: 'CLOSED_FINANCE', donHangId });
  sockets.emit('dashboard:refresh', {});
  return getCongNo(donHangId);
}

const fmtMoney = (v) => (v === null || v === undefined || v === '' ? '—' : Number(v).toLocaleString('vi-VN'));

async function history(date) {
  const rows = await repo.historyByDate(date);
  return rows.map((r) => ({
    tg: r.tg,
    nguoi: r.nguoi || '—',
    hanh_dong: 'Đóng tài chính',
    doi_tuong: [r.ma_don_hang, r.ten_khach_hang].filter(Boolean).join(' · '),
    chi_tiet: `Công nợ ${fmtMoney(r.tong_tien)} ₫ · Đã thu ${fmtMoney(r.da_thu)} ₫`,
  }));
}

module.exports = { listDonHang, getCongNo, saveCongNo, confirm, history };
