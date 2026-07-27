'use strict';

const repo = require('./orders.repository');
const AppError = require('../../utils/AppError');
const { buildMeta } = require('../../utils/pagination');
const { withTransaction } = require('../../config/db');
const sockets = require('../../sockets');

async function listPhanIn({ search, missingProfit, page, limit, offset }) {
  const { rows, total } = await repo.list({ search, missingProfit, offset, limit });
  return { items: rows, meta: buildMeta(page, limit, total) };
}

async function listVaiVe({ search, filters, stage, page, limit, offset, sortKey, sortDir }) {
  const { rows, total } = await repo.listVaiVe({ search, filters, stage, offset, limit, sortKey, sortDir });
  // Chế độ TỔNG HỢP (Tất cả + các chip tiền sản xuất): gắn ledger theo TỪNG ĐỢT SẢN XUẤT (query riêng, IPS-safe)
  // để FE gộp 1 dòng/phần in + mở modal "Chi tiết" theo từng đợt.
  const AGG_STAGES = ['', 'ALL', 'READY', 'RELEASE_1', 'TEST_RUN', 'RELEASE_2'];
  if (AGG_STAGES.includes(stage || '') && rows.length) {
    const byPin = await repo.dotSanXuatLedger(rows.map((r) => r.phan_in_id));
    rows.forEach((r) => { r.dot_san_xuat = byPin[r.phan_in_id] || []; });
  }
  return { items: rows, meta: buildMeta(page, limit, total) };
}

async function getPhanIn(id) {
  const phanIn = await repo.findById(id);
  if (!phanIn) throw new AppError('Phần in không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const [dotVai, timeline, temSummary, kcsByDot, stagePcs, dryMin] = await Promise.all([
    repo.listDotVai(id), repo.getPhanInTimeline(id), repo.getPhanInTemSummary(id),
    repo.getPhanInKcsByDot(id), repo.getPhanInStagePcs(id), repo.getDryMin(id),
  ]);
  return { ...phanIn, dot_vai: dotVai, timeline, tem_summary: temSummary, kcs_by_dot: kcsByDot, stage_pcs: stagePcs, thoi_gian_cho_kho_phut: dryMin };
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

// Hủy phần in (xóa mềm): tìm kiếm + xóa nhiều phần in cùng lúc. stage = lọc theo trạm hiện tại.
async function searchForCancel(q, stage) {
  return repo.searchPhanInForCancel(q || '', stage || '');
}

async function softDeletePhanIn(phanInIds, lyDo, actorId) {
  if (!Array.isArray(phanInIds) || phanInIds.length === 0) {
    throw new AppError('Chưa chọn phần in nào để hủy', { status: 422, errorCode: 'EMPTY' });
  }
  const done = [];
  await withTransaction(async (client) => {
    for (const id of phanInIds) {
      const res = await repo.softDeletePhanInTx(client, id, actorId);
      if (res) done.push({ id, ma: res.ma_phan, snapshot: res.snapshot });
    }
  });
  for (const d of done) await repo.logSoftDeletePhanIn(d.id, d.ma, lyDo, actorId, d.snapshot);
  if (done.length) sockets.emit('dashboard:refresh', {});
  return { count: done.length, items: done.map(({ snapshot, ...r }) => r) };
}

// Danh sách phần in đã xóa mềm (để "Mở phần in").
async function listDeleted(q) {
  return repo.listDeletedPhanIn(q || '');
}

// Mở lại (khôi phục) nhiều phần in đã xóa mềm — trọn vẹn theo snapshot lúc xóa.
async function reopenPhanIn(phanInIds, actorId) {
  if (!Array.isArray(phanInIds) || phanInIds.length === 0) {
    throw new AppError('Chưa chọn phần in nào để mở lại', { status: 422, errorCode: 'EMPTY' });
  }
  const done = [];
  await withTransaction(async (client) => {
    for (const id of phanInIds) {
      const snap = await repo.getDeleteSnapshot(id);
      const ma = await repo.restorePhanInTx(client, id, snap, actorId);
      if (ma) done.push({ id, ma });
    }
  });
  for (const d of done) await repo.logRestorePhanIn(d.id, d.ma, actorId);
  if (done.length) sockets.emit('dashboard:refresh', {});
  return { count: done.length, items: done };
}

module.exports = { listPhanIn, listVaiVe, getPhanIn, setChoKho, setLoiNhuan, profitHistory, searchForCancel, softDeletePhanIn, listDeleted, reopenPhanIn };
