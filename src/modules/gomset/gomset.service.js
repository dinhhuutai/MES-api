'use strict';

const { withTransaction } = require('../../config/db');
const repo = require('./gomset.repository');
const AppError = require('../../utils/AppError');
const { buildMeta } = require('../../utils/pagination');
const sockets = require('../../sockets');

async function listCandidates({ search, page, limit, offset }) {
  const { rows, total } = await repo.listCandidates({ search, offset, limit });
  return { items: rows, meta: buildMeta(page, limit, total) };
}

// Kiểm tra đợt vải hợp lệ để gom (chưa release, chưa thuộc set mở khác).
async function assertGomDuoc(dotVaiIds, exceptSetId = null) {
  const daReleased = await repo.dotVaiReleased(dotVaiIds);
  if (daReleased.length) {
    throw new AppError('Có đợt vải đã được release, không gom được', { status: 409, errorCode: 'RELEASED', details: daReleased });
  }
  const inSet = await repo.dotVaiInOpenSet(dotVaiIds, exceptSetId);
  if (inSet.length) {
    throw new AppError('Có đợt vải đã thuộc set khác đang mở', { status: 409, errorCode: 'IN_SET', details: inSet });
  }
}

function labelOf(rows) {
  return rows.map((r) => `${r.ma_phan}·${r.mau_vai || '—'}·${r.ma_dot_vai}`).join(', ');
}

async function createSet({ ghiChu, dotVaiIds }, actorId) {
  const ids = Array.isArray(dotVaiIds) ? dotVaiIds : [];
  if (ids.length < 1) throw new AppError('Chọn ít nhất một đợt vải để gom', { status: 422, errorCode: 'EMPTY' });
  await assertGomDuoc(ids);
  const labels = await repo.getDotVaiLabels(ids);
  const maSet = await repo.nextMaSet();
  const setId = await withTransaction(async (client) => {
    const id = await repo.createSet(client, { maSet, ghiChu }, actorId);
    for (const dvId of ids) await repo.addDotVai(client, id, dvId, actorId);
    await repo.logGomAction(client, id, 'CREATE_SET', `Tạo set, gom ${ids.length} đợt vải: ${labelOf(labels)}`, actorId);
    return id;
  });
  sockets.emit('workflow:updated', { setId, stage: 'GOM_SET' });
  return getSetDetail(setId);
}

async function addToSet(setId, { dotVaiIds }, actorId) {
  const set = await repo.getSet(setId);
  if (!set) throw new AppError('Set không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (set.trang_thai !== 'MO') throw new AppError('Set không ở trạng thái mở', { status: 409, errorCode: 'NOT_OPEN' });
  const ids = Array.isArray(dotVaiIds) ? dotVaiIds : [];
  if (!ids.length) throw new AppError('Chọn đợt vải để thêm', { status: 422, errorCode: 'EMPTY' });
  await assertGomDuoc(ids, setId);
  const labels = await repo.getDotVaiLabels(ids);
  await withTransaction(async (client) => {
    for (const dvId of ids) await repo.addDotVai(client, setId, dvId, actorId);
    await repo.logGomAction(client, setId, 'ADD_DOT_VAI', `Thêm ${ids.length} đợt vải: ${labelOf(labels)}`, actorId);
  });
  return getSetDetail(setId);
}

async function removeFromSet(setId, dotVaiId, actorId) {
  const set = await repo.getSet(setId);
  if (!set) throw new AppError('Set không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (set.trang_thai !== 'MO') throw new AppError('Set không ở trạng thái mở', { status: 409, errorCode: 'NOT_OPEN' });
  const labels = await repo.getDotVaiLabels([dotVaiId]);
  await repo.removeDotVai(setId, dotVaiId);
  await repo.logGomAction(null, setId, 'REMOVE_DOT_VAI', `Tách đợt vải: ${labelOf(labels) || dotVaiId}`, actorId);
  return getSetDetail(setId);
}

async function cancelSet(setId, actorId) {
  const set = await repo.getSet(setId);
  if (!set) throw new AppError('Set không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (set.trang_thai === 'DA_RELEASE') throw new AppError('Set đã release, không hủy được', { status: 409, errorCode: 'RELEASED' });
  await repo.cancelSet(setId, actorId);
  await repo.logGomAction(null, setId, 'CANCEL_SET', `Hủy set ${set.ma_set}`, actorId);
  sockets.emit('workflow:updated', { setId, stage: 'GOM_SET', action: 'cancel' });
  return { id: setId };
}

async function gomHistory(date) {
  const rows = await repo.gomHistoryByDate(date);
  const LABEL = {
    CREATE_SET: 'Tạo set', ADD_DOT_VAI: 'Thêm đợt vải', REMOVE_DOT_VAI: 'Tách đợt vải',
    CANCEL_SET: 'Hủy set', RELEASE_SET: 'Release set',
  };
  return rows.map((r) => ({
    tg: r.tg, nguoi: r.nguoi || '—',
    hanh_dong: LABEL[r.hanh_dong] || r.hanh_dong,
    doi_tuong: r.ma_set || '',
    chi_tiet: r.chi_tiet || '',
  }));
}

async function listSets({ search }) {
  const rows = await repo.listSets({ search: search || '', trangThai: 'MO' });
  return rows.map((r) => ({ ...r, khac_mau: (r.so_mau || 0) > 1 }));
}

async function getSetDetail(setId) {
  const set = await repo.getSet(setId);
  if (!set) throw new AppError('Set không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const members = await repo.getSetMembers(setId);
  const mauSet = new Set(members.map((m) => m.mau_vai).filter(Boolean));
  return {
    set,
    members,
    so_mau: mauSet.size,
    khac_mau: mauSet.size > 1,
    so_chua_ready: members.filter((m) => !m.qc_done).length,
  };
}

module.exports = {
  listCandidates, createSet, addToSet, removeFromSet, cancelSet, listSets, getSetDetail, gomHistory,
};
