'use strict';

const { withTransaction } = require('../../config/db');
const repo = require('./technical.repository');
const wf = require('../workflow/workflow.repository');
const AppError = require('../../utils/AppError');
const { buildMeta } = require('../../utils/pagination');
const sockets = require('../../sockets');

const READY_TRAM = 'READY';
const INPUT_CPS = ['KHUON', 'FILM', 'MUC', 'HSKT']; // checkpoint nhập liệu kỹ thuật
const KT_CP = 'XAC_NHAN_KT';
const QC_CP = 'QC_XAC_NHAN';

function parseOptions(cfg) {
  if (!cfg) return [];
  try {
    const o = typeof cfg === 'string' ? JSON.parse(cfg) : cfg;
    return o.options || [];
  } catch {
    return [];
  }
}

// Đọc cấu hình trạm READY + checkpoint (động từ DB).
async function loadConfig() {
  const version = await wf.getActiveVersion();
  if (!version) throw new AppError('Chưa cấu hình workflow đang hiệu lực', { status: 500, errorCode: 'NO_WORKFLOW' });
  const tram = await wf.getTramByMa(version.id, READY_TRAM);
  if (!tram) throw new AppError('Workflow chưa có trạm READY', { status: 500, errorCode: 'NO_TRAM' });
  const checkpoints = await wf.getCheckpointsByTram(tram.id);
  const byMa = {};
  checkpoints.forEach((c) => { byMa[c.ma_checkpoint] = c; });
  return { version, tram, checkpoints, byMa };
}

function buildState(results) {
  const get = (ma) => results.find((r) => r.ma_checkpoint === ma)?.trang_thai;
  return { kt_done: get(KT_CP) === 'DAT', qc_done: get(QC_CP) === 'DAT' };
}

async function getConfig() {
  const { tram, checkpoints } = await loadConfig();
  return { tram, checkpoints: checkpoints.map((c) => ({ ...c, options: parseOptions(c.cau_hinh_json) })) };
}

async function listCandidates({ search, page, limit, offset }) {
  const { checkpoints, byMa } = await loadConfig();
  const readyIds = checkpoints.map((c) => c.id);
  const { rows, total } = await repo.listCandidates({
    search, readyIds, ktId: byMa[KT_CP]?.id, qcId: byMa[QC_CP]?.id, offset, limit,
  });
  const items = rows.map((r) => ({
    ...r,
    trang_thai_ready: r.kt_done ? 'CHO_QC' : r.co_du_lieu ? 'DANG' : 'CHUA',
  }));
  return { items, meta: buildMeta(page, limit, total) };
}

async function getDetail(phanInId) {
  const { tram } = await loadConfig();
  const phanIn = await repo.getPhanInBasic(phanInId);
  if (!phanIn) throw new AppError('Phần in không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const results = await repo.getResults(tram.id, phanInId);
  return {
    phan_in: phanIn,
    checkpoints: results.map((r) => ({ ...r, options: parseOptions(r.cau_hinh_json) })),
    state: buildState(results),
  };
}

async function saveDraft(phanInId, body, actorId) {
  const { tram, byMa } = await loadConfig();
  const state = buildState(await repo.getResults(tram.id, phanInId));
  if (state.kt_done) {
    throw new AppError('Đã xác nhận kỹ thuật, dữ liệu đã khóa', { status: 409, errorCode: 'LOCKED' });
  }
  await withTransaction(async (client) => {
    for (const ma of ['KHUON', 'FILM', 'MUC']) {
      const val = body[ma.toLowerCase()];
      if (val !== undefined && val !== null && val !== '') {
        await repo.upsertResult(client, { phanInId, checkpointId: byMa[ma].id, trangThai: 'DAT', giaTriText: val, actorId });
      }
    }
    if (body.hskt === true) {
      await repo.upsertResult(client, { phanInId, checkpointId: byMa.HSKT.id, trangThai: 'DAT', actorId });
    } else if (body.hskt === false) {
      await repo.upsertResult(client, { phanInId, checkpointId: byMa.HSKT.id, trangThai: 'DANG', actorId });
    }
  });
  return getDetail(phanInId);
}

async function confirmTech(phanInId, actorId) {
  const { tram, byMa } = await loadConfig();
  const results = await repo.getResults(tram.id, phanInId);
  const state = buildState(results);
  if (state.kt_done) throw new AppError('Đã xác nhận kỹ thuật', { status: 409, errorCode: 'ALREADY' });

  const byMaResult = {};
  results.forEach((r) => { byMaResult[r.ma_checkpoint] = r; });
  for (const ma of INPUT_CPS) {
    if (byMaResult[ma]?.trang_thai !== 'DAT') {
      throw new AppError(`Chưa hoàn tất: ${byMa[ma]?.ten_checkpoint || ma}`, { status: 422, errorCode: 'INCOMPLETE' });
    }
  }

  const datId = await wf.getTrangThaiId('DAT');
  await withTransaction(async (client) => {
    const kqId = await repo.upsertResult(client, {
      phanInId, checkpointId: byMa[KT_CP].id, trangThai: 'DAT', nguoiXacNhanId: actorId, tgXacNhan: new Date(), actorId,
    });
    await repo.insertStatusLog(client, { ketQuaId: kqId, trangThaiMoiId: datId, nguoiId: actorId, lyDo: 'Xác nhận kỹ thuật' });
  });
  sockets.emit('ready:confirmed', { phanInId, buoc: 'KT' });
  sockets.emit('dashboard:refresh', {});
  return getDetail(phanInId);
}

async function confirmQC(phanInId, actorId) {
  const { tram, byMa } = await loadConfig();
  const state = buildState(await repo.getResults(tram.id, phanInId));
  if (!state.kt_done) {
    throw new AppError('Kỹ thuật chưa xác nhận — QC không thể xác nhận', { status: 409, errorCode: 'TECH_NOT_CONFIRMED' });
  }
  if (state.qc_done) throw new AppError('Đã QC xác nhận', { status: 409, errorCode: 'ALREADY' });

  const datId = await wf.getTrangThaiId('DAT');
  await withTransaction(async (client) => {
    const kqId = await repo.upsertResult(client, {
      phanInId, checkpointId: byMa[QC_CP].id, trangThai: 'DAT', nguoiXacNhanId: actorId, tgXacNhan: new Date(), actorId,
    });
    await repo.insertStatusLog(client, { ketQuaId: kqId, trangThaiMoiId: datId, nguoiId: actorId, lyDo: 'QC xác nhận — READY hoàn thành' });
  });
  sockets.emit('ready:confirmed', { phanInId, buoc: 'QC', ready: true });
  sockets.emit('dashboard:refresh', {});
  return getDetail(phanInId);
}

module.exports = { getConfig, listCandidates, getDetail, saveDraft, confirmTech, confirmQC };
