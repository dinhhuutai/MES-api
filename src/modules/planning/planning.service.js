'use strict';

const { withTransaction } = require('../../config/db');
const repo = require('./planning.repository');
const qaRepo = require('../quality/quality.repository'); // qc_tra_ve dùng chung
const chuyenRepo = require('../chuyen/chuyen.repository');
const wf = require('../workflow/workflow.repository');
const AppError = require('../../utils/AppError');
const { buildMeta } = require('../../utils/pagination');
const sockets = require('../../sockets');
const tracking = require('../workflow/tracking.service');

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
  // Đánh dấu đợt vải bị Test Run trả về (badge + lọc).
  const rm = await qaRepo.activeReturnsMap('TEST_RUN', rows.map((r) => r.dot_vai_id));
  rows.forEach((r) => { r.tra_ve_ly_do = rm[r.dot_vai_id] || null; });
  return { items: rows, meta: buildMeta(page, limit, total) };
}

// ----- KẾ HOẠCH TỰ ĐỘNG -----
// Thông số HSKT & số pass/chuyền hiện là DỮ LIỆU GIẢ (deterministic theo id để ổn định giữa các lần tải);
// về sau lấy từ ERP. Công thức năng suất theo spec nghiệp vụ (xem tinhNangSuat).
function seedFrom(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mockHskt(phanInId) {
  const h = seedFrom(phanInId);
  return {
    so_luong_vai_pass: 20 + (h % 41),         // 20..60 (vải/pass)
    so_lan_in: 3 + (Math.floor(h / 41) % 10), // 3..12 (số lần in)
    so_pass_bo: Math.floor(h / 4100) % 4,     // 0..3 (số pass bỏ)
  };
}
function mockPassChuyen(chuyenId) {
  return 2 + (seedFrom(chuyenId) % 5); // 2..6 (số pass mỗi chuyền)
}
// Năng suất/giờ = X × 60 / thời-gian-SX; X = min(SL nhận vải, số vải/vòng in).
function tinhNangSuat(hskt, soPassChuyen, soLuongVaiVe) {
  const soVaiVongIn = hskt.so_luong_vai_pass * soPassChuyen;
  const X = Math.min(Number(soLuongVaiVe) || 0, soVaiVongIn);
  const thoiGianSx = hskt.so_lan_in * (10 / (hskt.so_pass_bo + 1)) + 30; // phút
  const nangSuatGio = thoiGianSx > 0 ? (X * 60) / thoiGianSx : 0;
  return {
    so_vai_vong_in: soVaiVongIn,
    x: X,
    thoi_gian_sx: Math.round(thoiGianSx * 10) / 10,
    nang_suat_gio: Math.round(nangSuatGio),
  };
}

async function autoPlanCandidates({ search, page, limit, offset }) {
  const { rows, total } = await repo.listRelease1Candidates({ search, offset, limit });
  const rm = await qaRepo.activeReturnsMap('TEST_RUN', rows.map((r) => r.dot_vai_id));
  const chuyens = (await chuyenRepo.listChuyen({ search: '' })).filter((c) => c.dang_hoat_dong);
  const items = rows.map((r) => {
    const hskt = mockHskt(r.phan_in_id);
    const chuyenOptions = chuyens
      .map((c) => ({
        chuyen_id: c.id, ma_chuyen: c.ma_chuyen, ten_chuyen: c.ten_chuyen,
        so_pass: mockPassChuyen(c.id), ...tinhNangSuat(hskt, mockPassChuyen(c.id), r.so_luong_vai_ve),
      }))
      .sort((a, b) => b.nang_suat_gio - a.nang_suat_gio);
    return {
      ...r,
      tra_ve_ly_do: rm[r.dot_vai_id] || null,
      hskt,
      chuyen_options: chuyenOptions,
      best_chuyen: chuyenOptions[0] || null,
    };
  });
  return { items, meta: buildMeta(page, limit, total) };
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
      out.push({ id, ma_lenh_san_xuat: maLenh, trang_thai: trangThai, so_dot_vai: 1, dot_vai_id: dvId });
    }
    return out;
  });

  // Theo dõi dòng chảy: mỗi lệnh → trạm tương ứng (đợt đã test xong vào thẳng RELEASE_2).
  for (const c of created) {
    await tracking.moveDotVaiTo([c.dot_vai_id], c.trang_thai === 'RELEASE_2' ? 'RELEASE_2' : 'RELEASE_1', actorId);
  }
  await qaRepo.resolveReturnsMany('TEST_RUN', created.map((c) => c.dot_vai_id)); // release lại → tắt cờ "bị Test Run trả về"
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

  await tracking.moveDotVaiTo(dotVaiIds, 'RELEASE_1', actorId); // theo dõi dòng chảy (cả set)
  await qaRepo.resolveReturnsMany('TEST_RUN', dotVaiIds); // release lại → tắt cờ "bị Test Run trả về"
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

async function confirmTest(lenhId, which, actorId, extra = {}) {
  const { byMa } = await loadTestConfig();
  const cpMa = which === 'cnsp' ? CNSP_CP : QA_CP;
  const lenh = await repo.getLenhBasic(lenhId);
  if (!lenh) throw new AppError('Lệnh sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (lenh.trang_thai !== 'RELEASE_1') {
    throw new AppError('Lệnh không ở trạng thái Test Run', { status: 409, errorCode: 'WRONG_STAGE' });
  }
  const datId = await wf.getTrangThaiId('DAT');
  // QA xác nhận đạt = ghi 1 LẦN TEST (đạt). Chỉ ghi khi QA đang từ chưa-đạt → đạt (tránh trùng khi xác nhận lại).
  let recordPass = false;
  if (which === 'qa') {
    const st = await repo.getLenhTestStatus(lenhId, byMa[CNSP_CP].id, byMa[QA_CP].id);
    recordPass = !st.qa_done;
  }
  await withTransaction(async (client) => {
    const kqId = await repo.upsertLenhResult(client, {
      lenhId, checkpointId: byMa[cpMa].id, trangThai: 'DAT', nguoiXacNhanId: actorId, actorId,
    });
    await repo.insertStatusLog(client, { ketQuaId: kqId, trangThaiMoiId: datId, nguoiId: actorId, lyDo: `${cpMa} xác nhận test` });
    if (recordPass) {
      await repo.insertTestRunTx(client, lenhId, { soLuong: extra.soLuong ?? null, ketQua: 'DAT', ghiChu: null }, actorId);
    }
  });
  await tracking.moveByLenh(lenhId, TEST_TRAM, actorId); // theo dõi dòng chảy: vào trạm TEST_RUN
  sockets.emit('workflow:updated', { lenhId, stage: 'TEST_RUN', confirm: which });
  return getLenhDetail(lenhId);
}

// Xóa mềm (hủy) xác nhận Test Run của 1 lệnh — CNSP hoặc QA. Đưa DAT → HUY để xác nhận lại.
// Chỉ hủy khi lệnh CHƯA Release 2 (nếu đã RELEASE_2 phải hủy Release 2 trước — thứ tự ngược lại).
async function cancelTest(lenhId, which, actorId) {
  const { byMa } = await loadTestConfig();
  const cpMa = which === 'cnsp' ? CNSP_CP : QA_CP;
  const lenh = await repo.getLenhBasic(lenhId);
  if (!lenh) throw new AppError('Lệnh sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (lenh.trang_thai === 'RELEASE_2') {
    throw new AppError('Lệnh đã Release 2 — hãy hủy Release 2 trước khi hủy xác nhận Test Run', { status: 409, errorCode: 'ALREADY_RELEASED_2' });
  }
  const status = await repo.getLenhTestStatus(lenhId, byMa[CNSP_CP].id, byMa[QA_CP].id);
  const done = which === 'cnsp' ? status.cnsp_done : status.qa_done;
  if (!done) throw new AppError('Mục này chưa được xác nhận', { status: 409, errorCode: 'NOT_CONFIRMED' });

  await withTransaction(async (client) => {
    await repo.cancelLenhResult(client, lenhId, byMa[cpMa].id, actorId);
  });
  await repo.logTestCancel(lenhId, cpMa, actorId);
  sockets.emit('workflow:updated', { lenhId, stage: 'TEST_RUN', huy: which });
  sockets.emit('dashboard:refresh', {});
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
  await tracking.moveByLenh(lenhId, 'RELEASE_2', actorId); // theo dõi dòng chảy
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

// ----- HỦY LỆNH / HOÀN TÁC RELEASE (đưa đợt vải về lại Release 1) -----
async function listCancelableLenh({ search, page, limit, offset }) {
  const { rows, total } = await repo.listCancelableLenh({ search, offset, limit });
  return { items: rows, meta: buildMeta(page, limit, total) };
}

// Hoàn tác chuyển trạm 1 lệnh về checkpoint đích (pre-production):
//  - TEST_RUN : chỉ bỏ duyệt Release 2 (RELEASE_2 → RELEASE_1); đợt vải vẫn ở Test Run.
//  - RELEASE_1: hủy lệnh → đợt vải về "chờ release" (Release 1 candidate), giữ QC.
//  - READY    : hủy lệnh + hủy QC ready → phần in về màn READY (làm lại từ kỹ thuật/QC).
async function rollbackLenh(lenhId, { target, lyDo }, actorId) {
  const TARGET = ['READY', 'RELEASE_1', 'TEST_RUN'].includes(target) ? target : 'RELEASE_1';
  const lenh = await repo.getLenhForCancel(lenhId);
  if (!lenh) throw new AppError('Lệnh sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (lenh.trang_thai === 'HUY') throw new AppError('Lệnh đã hủy', { status: 409, errorCode: 'ALREADY' });
  if (!['RELEASE_1', 'RELEASE_2'].includes(lenh.trang_thai)) {
    throw new AppError('Chỉ hoàn tác lệnh đang ở Release 1 / Release 2 (chưa vào sản xuất)', { status: 409, errorCode: 'WRONG_STAGE' });
  }
  if (lenh.co_phieu) {
    throw new AppError('Lệnh đã bắt đầu sản xuất (đã in tem) — không thể hoàn tác tự động', { status: 409, errorCode: 'HAS_PHIEU' });
  }
  const dotVaiIds = await tracking.dotVaiFromLenh(lenhId);

  // Chỉ bỏ duyệt Release 2 → về Test Run (giữ lệnh, vẫn đã release).
  if (TARGET === 'TEST_RUN') {
    if (lenh.trang_thai !== 'RELEASE_2') {
      throw new AppError('Lệnh đang ở Test Run (Release 1) — không cần hoàn tác về Test Run', { status: 409, errorCode: 'NOOP' });
    }
    await withTransaction(async (client) => {
      await repo.setLenhTrangThai(client, lenhId, 'RELEASE_1', actorId);
      await repo.logPlanChange(client, lenhId, 'HUY_RELEASE_2',
        { trang_thai: 'RELEASE_2' }, { trang_thai: 'RELEASE_1', ly_do: (lyDo || '').trim() || null }, actorId);
    });
    await tracking.revertToTram(dotVaiIds, 'TEST_RUN', actorId);
    sockets.emit('workflow:updated', { lenhId, stage: 'RELEASE_1' });
    sockets.emit('dashboard:refresh', {});
    return { id: lenhId, target: TARGET, dot_vai: dotVaiIds.length };
  }

  // RELEASE_1 / READY: hủy lệnh (đợt vải rời lệnh) + (READY) hủy QC.
  await withTransaction(async (client) => {
    await repo.cancelLenhOrder(client, lenhId, actorId);
    if (TARGET === 'READY') await repo.cancelReadyQcForDotVai(client, dotVaiIds, actorId);
  });
  await repo.logLenhCancel(lenhId, lenh.ma_lenh_san_xuat, `[${TARGET}] ${lyDo || ''}`.trim(), actorId);
  await tracking.revertToReady(dotVaiIds, actorId);
  sockets.emit('workflow:updated', { lenhId, stage: 'HUY' });
  sockets.emit('dashboard:refresh', {});
  return { id: lenhId, target: TARGET, dot_vai: dotVaiIds.length, tu_set: lenh.tu_set === true };
}

// Test Run QC TRẢ VỀ Release 1: hủy lệnh (đợt vải về pool Release 1) + đánh dấu QC trả về (lý do bắt buộc).
async function returnTestRunToRelease1(lenhId, { lyDo }, actorId) {
  const reason = (lyDo || '').trim();
  if (!reason) throw new AppError('Nhập lý do trả về Release 1', { status: 422, errorCode: 'NO_LY_DO' });
  const lenh = await repo.getLenhBasic(lenhId);
  if (!lenh) throw new AppError('Lệnh sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (lenh.trang_thai !== 'RELEASE_1') {
    throw new AppError('Chỉ trả về Release 1 khi lệnh đang ở Test Run', { status: 409, errorCode: 'WRONG_STAGE' });
  }
  const dotVaiIds = await tracking.dotVaiFromLenh(lenhId);
  await rollbackLenh(lenhId, { target: 'RELEASE_1', lyDo: reason }, actorId); // hủy lệnh → đợt vải về pool
  for (const dvId of dotVaiIds) {
    await qaRepo.insertQcTraVe({ loai: 'TEST_RUN', dotVaiId: dvId, lenhId, lyDo: reason }, actorId);
  }
  return { lenh_id: lenhId, dot_vai: dotVaiIds.length };
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
  // Cho lập lại kế hoạch khi lệnh đang Test Run (RELEASE_1) HOẶC đã Release 2 — miễn chưa bắt đầu sản xuất.
  if (!['RELEASE_1', 'RELEASE_2'].includes(lenh.trang_thai) || lenh.co_phieu) {
    throw new AppError('Chỉ lập lại kế hoạch cho lệnh đang Test Run / đã Release 2 và chưa bắt đầu sản xuất',
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

// ----- Danh sách "đã hoàn thành" theo ngày (cho DonePanel bên trái) -----
async function release1Done(date) { return repo.release1DoneByDate(date); }
async function release2Done(date) { return repo.planDoneByDate(date, 'RELEASE_2'); }
async function replanDone(date) { return repo.planDoneByDate(date, 'REPLAN'); }
async function testCnspDone(date) { return repo.testDoneByDate(date, CNSP_CP); }
async function testQaDone(date) { return repo.testDoneByDate(date, QA_CP); }

module.exports = {
  listRelease1Candidates, autoPlanCandidates, createRelease1, release1History, listReleaseSets, releaseSet,
  listTestRunCandidates, getLenhDetail, recordTestRun, confirmTest, confirmTestBatch, cancelTest,
  listRelease2Candidates, approveRelease2, approveRelease2Batch, testRunHistory,
  listReplanCandidates, replan, replanBatch, planHistory,
  listCancelableLenh, rollbackLenh, returnTestRunToRelease1,
  release1Done, release2Done, replanDone, testCnspDone, testQaDone,
};
