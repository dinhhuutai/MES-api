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

  // Mỗi đợt vải tạo 1 lệnh sản xuất riêng (xác nhận nhiều cùng lúc, KHÔNG gom chung vào 1 lệnh).
  // Test Run theo code phần: đợt vải của phần in đã test xong (CNSP+QA) → vào thẳng RELEASE_2, bỏ qua test run.
  const { version, byMa } = await loadTestConfig();
  const testedSet = new Set(await repo.testedDotVaiIds(dotVaiIds, byMa[CNSP_CP].id, byMa[QA_CP].id));

  // SL release từng lệnh = SL vải về của đợt vải đó; nếu release đúng 1 đợt và người dùng nhập SL thì dùng giá trị nhập.
  const qtyRows = await repo.getDotVaiQty(dotVaiIds);
  const qtyMap = Object.fromEntries(qtyRows.map((r) => [r.id, r.so_luong]));
  const single = dotVaiIds.length === 1;

  const created = await withTransaction(async (client) => {
    const out = [];
    for (const dvId of dotVaiIds) {
      const maLenh = await repo.nextMaLenhTx(client);
      const trangThai = testedSet.has(dvId) ? 'RELEASE_2' : 'RELEASE_1';
      const soLuong = (single && soLuongRelease != null) ? soLuongRelease : (qtyMap[dvId] || 0);
      const id = await repo.createLenh(client, {
        versionId: version.id, maLenh, chuyenId, soLuongRelease: soLuong, ngayKeHoach, trangThai,
      }, actorId);
      await repo.addLenhDotVai(client, id, dvId, actorId);
      out.push({ id, ma_lenh_san_xuat: maLenh, trang_thai: trangThai, so_dot_vai: 1 });
    }
    return out;
  });

  created.forEach((c) => sockets.emit('workflow:updated', { lenhId: c.id, stage: c.trang_thai }));
  sockets.emit('dashboard:refresh', {});

  const detail = await getLenhDetail(created[0].id);
  return {
    ...detail,
    created_summary: created,
    created_count: created.length,
    skipped_test_count: created.filter((c) => c.trang_thai === 'RELEASE_2').length,
  };
}

async function release1History(date) {
  const rows = await repo.release1HistoryByDate(date);
  return rows.map((r) => ({
    tg: r.tg,
    nguoi: r.nguoi || '—',
    hanh_dong: 'Release 1',
    doi_tuong: r.ma_lenh || '',
    chi_tiet: [r.ma_phan, r.mau_vai, r.ma_dot_vai].filter(Boolean).join(' · ')
      + (r.ten_chuyen ? ` → ${r.ten_chuyen}` : ''),
  }));
}

// ----- RELEASE SET (gom set → 1 lệnh sản xuất chung) -----
async function listReleaseSets(search) {
  const [rows, members] = await Promise.all([
    repo.listReleasableSets(search || ''),
    repo.getOpenSetMembers(),
  ]);
  const bySet = {};
  members.forEach((m) => { (bySet[m.set_id] = bySet[m.set_id] || []).push(m); });
  return rows.map((r) => ({
    ...r,
    khac_mau: (r.so_mau || 0) > 1,
    san_sang: (r.so_chua_ready || 0) === 0 && r.so_dot_vai > 0,
    members: bySet[r.id] || [],
  }));
}

async function releaseSet(setId, { chuyenId, soLuongRelease, ngayKeHoach }, actorId) {
  if (!chuyenId) throw new AppError('Chọn chuyền sản xuất', { status: 422, errorCode: 'NO_CHUYEN' });
  const set = await repo.getSetForRelease(setId);
  if (!set) throw new AppError('Set không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (set.trang_thai !== 'MO') throw new AppError('Set không ở trạng thái mở', { status: 409, errorCode: 'NOT_OPEN' });

  const members = await repo.getSetMembersForRelease(setId);
  if (members.length === 0) throw new AppError('Set chưa có đợt vải', { status: 422, errorCode: 'EMPTY' });
  if (members.some((m) => m.da_release)) {
    throw new AppError('Có đợt vải trong set đã được release', { status: 409, errorCode: 'ALREADY_RELEASED' });
  }
  const chuaReady = members.filter((m) => !m.qc_done).length;
  if (chuaReady > 0) {
    throw new AppError(`Còn ${chuaReady} đợt vải chưa hoàn tất kỹ thuật (QC) — chưa release set được`,
      { status: 409, errorCode: 'NOT_READY' });
  }

  const version = await wf.getActiveVersion();
  const dotVaiIds = members.map((m) => m.dot_vai_id);
  const soLuong = soLuongRelease != null ? soLuongRelease : members.reduce((s, m) => s + (m.so_luong || 0), 0);

  const lenhId = await withTransaction(async (client) => {
    const maLenh = await repo.nextMaLenhTx(client);
    const id = await repo.createLenh(client, {
      versionId: version.id, maLenh, chuyenId, soLuongRelease: soLuong, ngayKeHoach, trangThai: 'RELEASE_1',
    }, actorId);
    for (const dvId of dotVaiIds) await repo.addLenhDotVai(client, id, dvId, actorId);
    await repo.markSetReleased(client, setId, id, actorId);
    await repo.logGomSetReleased(client, setId, `Release set ${set.ma_set} → lệnh ${maLenh} (${dotVaiIds.length} đợt vải)`, actorId);
    return id;
  });

  sockets.emit('workflow:updated', { lenhId, stage: 'RELEASE_1', fromSet: setId });
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

// Xác nhận test hàng loạt (CNSP hoặc QA) cho nhiều lệnh.
async function confirmTestBatch(lenhIds, which, actorId) {
  if (!Array.isArray(lenhIds) || lenhIds.length === 0) {
    throw new AppError('Chọn ít nhất một lệnh', { status: 422, errorCode: 'NO_LENH' });
  }
  let okCount = 0;
  const errors = [];
  for (const id of lenhIds) {
    try {
      await confirmTest(id, which, actorId);
      okCount += 1;
    } catch (e) {
      errors.push({ lenhId: id, message: e.message });
    }
  }
  sockets.emit('dashboard:refresh', {});
  return { okCount, failedCount: errors.length, errors };
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
    await repo.logPlanChange(client, lenhId, 'RELEASE_2',
      { trang_thai: 'RELEASE_1' },
      { trang_thai: 'RELEASE_2', chuyen_id: lenh.chuyen_id || null, ngay_ke_hoach: toDateStr(lenh.ngay_ke_hoach) },
      actorId);
  });
  sockets.emit('workflow:updated', { lenhId, stage: 'RELEASE_2' });
  sockets.emit('dashboard:refresh', {});
  return getLenhDetail(lenhId);
}

async function approveRelease2Batch(lenhIds, actorId) {
  if (!Array.isArray(lenhIds) || lenhIds.length === 0) {
    throw new AppError('Chọn ít nhất một lệnh', { status: 422, errorCode: 'NO_LENH' });
  }
  let okCount = 0;
  const errors = [];
  for (const id of lenhIds) {
    try { await approveRelease2(id, actorId); okCount += 1; }
    catch (e) { errors.push({ lenhId: id, message: e.message }); }
  }
  sockets.emit('dashboard:refresh', {});
  return { okCount, failedCount: errors.length, errors };
}

// ----- LẬP KẾ HOẠCH LẠI -----
async function listReplanCandidates({ search, page, limit, offset }) {
  const { rows, total } = await repo.listReplanCandidates({ search, offset, limit });
  return { items: rows, meta: buildMeta(page, limit, total) };
}

async function replan(lenhId, { chuyenId, ngayKeHoach, lyDo }, actorId) {
  if (!ngayKeHoach) throw new AppError('Chọn ngày sản xuất theo kế hoạch', { status: 422, errorCode: 'NO_NGAY' });
  if (!lyDo || !lyDo.trim()) throw new AppError('Nhập lý do lập kế hoạch lại', { status: 422, errorCode: 'NO_LY_DO' });

  const lenh = await repo.getLenhForReplan(lenhId);
  if (!lenh) throw new AppError('Lệnh sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (lenh.trang_thai !== 'RELEASE_2' || lenh.co_phieu) {
    throw new AppError('Chỉ lập lại kế hoạch cho lệnh đã Release 2 và chưa bắt đầu sản xuất',
      { status: 409, errorCode: 'NOT_REPLANNABLE' });
  }

  const newChuyen = chuyenId || lenh.chuyen_id; // không gửi thì giữ chuyền cũ
  await withTransaction(async (client) => {
    await repo.updateLenhPlan(client, lenhId, { chuyenId: newChuyen, ngayKeHoach }, actorId);
    await repo.logPlanChange(client, lenhId, 'REPLAN',
      { chuyen_id: lenh.chuyen_id || null, ngay_ke_hoach: toDateStr(lenh.ngay_ke_hoach) },
      { chuyen_id: newChuyen || null, ngay_ke_hoach: toDateStr(ngayKeHoach), ly_do: lyDo.trim() },
      actorId);
  });
  sockets.emit('workflow:updated', { lenhId, stage: 'RELEASE_2', replan: true });
  sockets.emit('dashboard:refresh', {});
  return { id: lenhId };
}

// Lập lại kế hoạch hàng loạt — áp cùng chuyền/ngày/lý do cho nhiều lệnh.
async function replanBatch(lenhIds, body, actorId) {
  if (!Array.isArray(lenhIds) || lenhIds.length === 0) {
    throw new AppError('Chọn ít nhất một lệnh', { status: 422, errorCode: 'NO_LENH' });
  }
  let okCount = 0;
  const errors = [];
  for (const id of lenhIds) {
    try { await replan(id, body, actorId); okCount += 1; }
    catch (e) { errors.push({ lenhId: id, message: e.message }); }
  }
  sockets.emit('dashboard:refresh', {});
  return { okCount, failedCount: errors.length, errors };
}

// Chuẩn hóa giá trị ngày (Date của pg hoặc chuỗi) về 'YYYY-MM-DD' theo giờ địa phương (server GMT+7), tránh lệch ngày do ISO/UTC.
function toDateStr(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return typeof v === 'string' ? v.slice(0, 10) : null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function planHistory(date) {
  const rows = await repo.planHistoryByDate(date);
  const ng = (v) => v || '—';
  return rows.map((r) => {
    const isReplan = r.hanh_dong === 'REPLAN';
    const chiTiet = isReplan
      ? `Chuyền ${r.ten_chuyen_cu || '—'}→${r.ten_chuyen_moi || '—'} · Ngày ${ng(r.ngay_cu)}→${ng(r.ngay_moi)} · Lý do: ${r.ly_do || '—'}`
      : `Duyệt Release 2 → chuyền ${r.ten_chuyen_moi || '—'}, ngày ${ng(r.ngay_moi)}`;
    return {
      tg: r.tg,
      nguoi: r.nguoi || '—',
      hanh_dong: isReplan ? 'Lập kế hoạch lại' : 'Duyệt Release 2',
      doi_tuong: r.ma_lenh || '',
      chi_tiet: chiTiet,
    };
  });
}

async function testRunHistory(date) {
  const rows = await repo.testRunHistoryByDate(date);
  return rows.map((r) => ({
    tg: r.tg,
    nguoi: r.nguoi || '—',
    hanh_dong: r.hanh_dong || 'Xác nhận test',
    doi_tuong: r.doi_tuong || '',
    chi_tiet: r.chi_tiet || '',
  }));
}

module.exports = {
  listRelease1Candidates, createRelease1, release1History, listReleaseSets, releaseSet,
  listTestRunCandidates, getLenhDetail, recordTestRun, confirmTest, confirmTestBatch,
  listRelease2Candidates, approveRelease2, approveRelease2Batch, testRunHistory,
  listReplanCandidates, replan, replanBatch, planHistory,
};
