'use strict';

const { withTransaction } = require('../../config/db');
const repo = require('./planning.repository');
const wf = require('../workflow/workflow.repository');
const AppError = require('../../utils/AppError');
const { buildMeta } = require('../../utils/pagination');
const sockets = require('../../sockets');

const TEST_TRAM = 'TEST_RUN';
const CNSP_CP = 'TEST_CNSP';
const QA_CP = 'TEST_QA';

async function loadTestConfig() {
  const version = await wf.getActiveVersion();
  if (!version) throw new AppError('Chưa cấu hình workflow', { status: 500, errorCode: 'NO_WORKFLOW' });
  const tram = await wf.getTramByMa(version.id, TEST_TRAM);
  if (!tram) throw new AppError('Workflow chưa có trạm TEST_RUN', { status: 500, errorCode: 'NO_TRAM' });
  const checkpoints = await wf.getCheckpointsByTram(tram.id);
  const byMa = {};
  checkpoints.forEach((c) => { byMa[c.ma_checkpoint] = c; });
  if (!byMa[CNSP_CP] || !byMa[QA_CP]) {
    throw new AppError('Trạm TEST_RUN thiếu checkpoint CNSP/QA', { status: 500, errorCode: 'NO_CHECKPOINT' });
  }
  return { version, tram, byMa };
}

// ----- RELEASE 1 -----
async function listRelease1Candidates({ search, page, limit, offset }) {
  const { rows, total } = await repo.listRelease1Candidates({ search, offset, limit });
  return { items: rows, meta: buildMeta(page, limit, total) };
}

async function createRelease1({ dotVaiIds, chuyenId, soLuongRelease, ngayKeHoach }, actorId) {
  if (!Array.isArray(dotVaiIds) || dotVaiIds.length === 0) {
    throw new AppError('Chọn ít nhất một đợt vải', { status: 422, errorCode: 'NO_DOT_VAI' });
  }
  if (!chuyenId) throw new AppError('Chọn chuyền sản xuất', { status: 422, errorCode: 'NO_CHUYEN' });

  const daReleased = await repo.dotVaiAlreadyReleased(dotVaiIds);
  if (daReleased.length > 0) {
    throw new AppError('Có đợt vải đã được release', { status: 409, errorCode: 'ALREADY_RELEASED', details: daReleased });
  }

  const version = await wf.getActiveVersion();
  const maLenh = await repo.nextMaLenh();
  const lenhId = await withTransaction(async (client) => {
    const id = await repo.createLenh(client, {
      versionId: version.id, maLenh, chuyenId, soLuongRelease: soLuongRelease ?? null, ngayKeHoach,
    }, actorId);
    for (const dvId of dotVaiIds) await repo.addLenhDotVai(client, id, dvId, actorId);
    return id;
  });

  sockets.emit('workflow:updated', { lenhId, stage: 'RELEASE_1' });
  sockets.emit('dashboard:refresh', {});
  return getLenhDetail(lenhId);
}

// ----- TEST RUN -----
async function listTestRunCandidates({ search, page, limit, offset }) {
  const { byMa } = await loadTestConfig();
  const rows = await repo.listTestRunCandidates({ cnspId: byMa[CNSP_CP].id, qaId: byMa[QA_CP].id, search, offset, limit });
  return { items: rows, meta: buildMeta(page, limit, rows.length) };
}

async function getLenhDetail(lenhId) {
  const { byMa } = await loadTestConfig();
  const lenh = await repo.getLenhBasic(lenhId);
  if (!lenh) throw new AppError('Lệnh sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const [dotVai, testRuns, status] = await Promise.all([
    repo.getLenhDotVai(lenhId),
    repo.getTestRuns(lenhId),
    repo.getLenhTestStatus(lenhId, byMa[CNSP_CP].id, byMa[QA_CP].id),
  ]);
  return { lenh, dot_vai: dotVai, test_runs: testRuns, state: status };
}

async function recordTestRun(lenhId, body, actorId) {
  await repo.getLenhBasic(lenhId);
  await repo.insertTestRun(lenhId, body, actorId);
  sockets.emit('workflow:updated', { lenhId, stage: 'TEST_RUN' });
  return getLenhDetail(lenhId);
}

async function confirmTest(lenhId, which, actorId) {
  const { byMa } = await loadTestConfig();
  const cpMa = which === 'cnsp' ? CNSP_CP : QA_CP;
  const lenh = await repo.getLenhBasic(lenhId);
  if (!lenh) throw new AppError('Lệnh sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (lenh.trang_thai !== 'RELEASE_1') {
    throw new AppError('Lệnh không ở trạng thái Test Run', { status: 409, errorCode: 'WRONG_STAGE' });
  }
  const datId = await wf.getTrangThaiId('DAT');
  await withTransaction(async (client) => {
    const kqId = await repo.upsertLenhResult(client, {
      lenhId, checkpointId: byMa[cpMa].id, trangThai: 'DAT', nguoiXacNhanId: actorId, actorId,
    });
    await repo.insertStatusLog(client, { ketQuaId: kqId, trangThaiMoiId: datId, nguoiId: actorId, lyDo: `${cpMa} xác nhận test` });
  });
  sockets.emit('workflow:updated', { lenhId, stage: 'TEST_RUN', confirm: which });
  return getLenhDetail(lenhId);
}

// ----- RELEASE 2 (Kế hoạch duyệt cuối) -----
async function listRelease2Candidates({ search, page, limit, offset }) {
  const { byMa } = await loadTestConfig();
  const rows = await repo.listRelease2Candidates({ cnspId: byMa[CNSP_CP].id, qaId: byMa[QA_CP].id, search, offset, limit });
  return { items: rows, meta: buildMeta(page, limit, rows.length) };
}

async function approveRelease2(lenhId, actorId) {
  const { byMa } = await loadTestConfig();
  const lenh = await repo.getLenhBasic(lenhId);
  if (!lenh) throw new AppError('Lệnh sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (lenh.trang_thai === 'RELEASE_2') throw new AppError('Lệnh đã Release 2', { status: 409, errorCode: 'ALREADY' });
  const status = await repo.getLenhTestStatus(lenhId, byMa[CNSP_CP].id, byMa[QA_CP].id);
  if (!status.cnsp_done || !status.qa_done) {
    throw new AppError('Test Run chưa đủ xác nhận CNSP và QA', { status: 409, errorCode: 'TEST_INCOMPLETE' });
  }
  await withTransaction(async (client) => {
    await repo.setLenhTrangThai(client, lenhId, 'RELEASE_2', actorId);
  });
  sockets.emit('workflow:updated', { lenhId, stage: 'RELEASE_2' });
  sockets.emit('dashboard:refresh', {});
  return getLenhDetail(lenhId);
}

module.exports = {
  listRelease1Candidates, createRelease1,
  listTestRunCandidates, getLenhDetail, recordTestRun, confirmTest,
  listRelease2Candidates, approveRelease2,
};
