'use strict';

const repo = require('./orders.repository');
const AppError = require('../../utils/AppError');
const { buildMeta } = require('../../utils/pagination');

async function listPhanIn({ search, missingProfit, page, limit, offset }) {
  const { rows, total } = await repo.list({ search, missingProfit, offset, limit });
  return { items: rows, meta: buildMeta(page, limit, total) };
}

async function listVaiVe({ search, filters, stage, page, limit, offset }) {
  const { rows, total } = await repo.listVaiVe({ search, filters, stage, offset, limit });
  return { items: rows, meta: buildMeta(page, limit, total) };
}

async function getPhanIn(id) {
  const phanIn = await repo.findById(id);
  if (!phanIn) throw new AppError('Phần in không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const [dotVai, timeline, temSummary, dryMin] = await Promise.all([
    repo.listDotVai(id), repo.getPhanInTimeline(id), repo.getPhanInTemSummary(id), repo.getDryMin(id),
  ]);
  return { ...phanIn, dot_vai: dotVai, timeline, tem_summary: temSummary, thoi_gian_cho_kho_phut: dryMin };
}

async function setChoKho(id, phut, actorId) {
  const exist = await repo.findById(id);
  if (!exist) throw new AppError('Phần in không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const p = phut === '' || phut === null || phut === undefined ? null : Number(phut);
  if (p !== null && (Number.isNaN(p) || p < 0)) throw new AppError('Thời gian chờ khô phải là số ≥ 0', { status: 422, errorCode: 'INVALID' });
  await repo.setDryMin(id, p, actorId);
  return getPhanIn(id);
}

async function setLoiNhuan(id, loiNhuan, actorId) {
  const old = await repo.findById(id);
  if (!old) throw new AppError('Phần in không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  await repo.setLoiNhuan(id, loiNhuan, actorId);
  await repo.logProfitChange(id, old.loi_nhuan ?? null, loiNhuan, actorId);
  return getPhanIn(id);
}

const fmtMoney = (v) => (v === null || v === undefined || v === '' ? '—' : Number(v).toLocaleString('vi-VN'));

async function profitHistory(date) {
  const rows = await repo.profitHistoryByDate(date);
  return rows.map((r) => ({
    tg: r.tg,
    nguoi: r.nguoi || '—',
    hanh_dong: 'Đặt lợi nhuận',
    doi_tuong: [r.ma_phan, r.ma_hang].filter(Boolean).join(' · '),
    chi_tiet: `${fmtMoney(r.cu)} → ${fmtMoney(r.moi)} ₫`,
  }));
}

module.exports = { listPhanIn, listVaiVe, getPhanIn, setChoKho, setLoiNhuan, profitHistory };
