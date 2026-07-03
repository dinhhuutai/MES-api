'use strict';

const { withTransaction } = require('../../config/db');
const repo = require('./technical.repository');
const wf = require('../workflow/workflow.repository');
const AppError = require('../../utils/AppError');
const { buildMeta } = require('../../utils/pagination');
const sockets = require('../../sockets');
const tracking = require('../workflow/tracking.service');

const READY_TRAM = 'READY';
const INPUT_CPS = ['KHUON', 'FILM', 'MUC', 'HSKT']; // 4 mục kỹ thuật, xác nhận độc lập
const OPTION_CPS = ['KHUON', 'FILM', 'MUC', 'HSKT']; // cần chọn option khi xác nhận (HSKT: Hoàn thiện/Thừa hưởng)
const QC_CP = 'QC_XAC_NHAN';
// Option mặc định (dùng khi cấu hình checkpoint chưa khai — vd HSKT chưa chạy migration 035).
const DEFAULT_OPTIONS = { HSKT: ['Hoàn thiện', 'Thừa hưởng'] };

// Đọc options của 1 checkpoint từ cau_hinh_json, fallback về DEFAULT_OPTIONS theo mã.
function optionsFor(ma, cfg) {
  let o = [];
  if (cfg) {
    try { const j = typeof cfg === 'string' ? JSON.parse(cfg) : cfg; o = j.options || []; } catch { o = []; }
  }
  return (o && o.length) ? o : (DEFAULT_OPTIONS[ma] || []);
}

// Đọc cấu hình trạm READY + checkpoint (động từ DB) — 1 query thay vì 3.
async function loadConfig() {
  const rows = await repo.loadReadyConfig();
  if (rows.length === 0) throw new AppError('Chưa cấu hình workflow đang hiệu lực', { status: 500, errorCode: 'NO_WORKFLOW' });
  const r0 = rows[0];
  const version = { id: r0.version_id, ma_version: r0.ma_version, ten_version: r0.ten_version };
  if (!r0.tram_id) throw new AppError('Workflow chưa có trạm READY', { status: 500, errorCode: 'NO_TRAM' });
  const tram = {
    id: r0.tram_id, ma_tram: r0.ma_tram, ten_tram: r0.ten_tram,
    thu_tu: r0.tram_thu_tu, thoi_gian_quy_dinh_phut: r0.thoi_gian_quy_dinh_phut,
    canh_bao_truoc_phut: r0.canh_bao_truoc_phut,
  };
  const checkpoints = rows.filter((r) => r.cp_id).map((r) => ({
    id: r.cp_id, ma_checkpoint: r.ma_checkpoint, ten_checkpoint: r.ten_checkpoint,
    bat_buoc: r.bat_buoc, thu_tu: r.cp_thu_tu, cau_hinh_json: r.cau_hinh_json, loai_checkpoint: r.loai_checkpoint,
  }));
  const byMa = {};
  checkpoints.forEach((c) => { byMa[c.ma_checkpoint] = c; });
  return { version, tram, checkpoints, byMa };
}

function buildState(results) {
  const done = (ma) => results.find((r) => r.ma_checkpoint === ma)?.trang_thai === 'DAT';
  const khuon_done = done('KHUON');
  const film_done = done('FILM');
  const muc_done = done('MUC');
  const hskt_done = done('HSKT');
  return {
    khuon_done,
    film_done,
    muc_done,
    hskt_done,
    tech_done: khuon_done && film_done && muc_done && hskt_done,
    qc_done: done(QC_CP),
  };
}

async function getConfig() {
  const { tram, checkpoints } = await loadConfig();
  return { tram, checkpoints: checkpoints.map((c) => ({ ...c, options: optionsFor(c.ma_checkpoint, c.cau_hinh_json) })) };
}

// onlyQcReady=true: chỉ phần in đã đủ 4 mục kỹ thuật & chưa QC (cho màn QC bên Chất lượng).
async function listCandidates({ search, page, limit, offset, onlyQcReady = false }) {
  const { tram, byMa } = await loadConfig();
  const inputIds = INPUT_CPS.map((ma) => byMa[ma]?.id).filter(Boolean);
  // SLA hàng READY = SLA trạm READY (đếm từ lúc đợt vải về/ vào READY). Mặc định 480' nếu chưa cấu hình.
  const readySla = tram.thoi_gian_quy_dinh_phut != null ? tram.thoi_gian_quy_dinh_phut : 480;
  const readyCanhBao = tram.canh_bao_truoc_phut != null ? tram.canh_bao_truoc_phut : 60;
  const { rows, total } = await repo.listCandidates({
    search, inputIds, qcId: byMa[QC_CP]?.id,
    khuonId: byMa.KHUON?.id, filmId: byMa.FILM?.id, mucId: byMa.MUC?.id, hsktId: byMa.HSKT?.id,
    onlyQcReady, offset, limit, readySla, readyCanhBao,
  });
  const items = rows.map((r) => ({
    ...r,
    trang_thai_ready: r.qc_done ? 'DONE' : r.n_tech_done >= 4 ? 'CHO_QC' : r.n_tech_done > 0 ? 'DANG' : 'CHUA',
  }));
  return { items, meta: buildMeta(page, limit, total) };
}

async function getDetail(phanInId) {
  const { tram } = await loadConfig();
  const phanIn = await repo.getPhanInBasic(phanInId);
  if (!phanIn) throw new AppError('Phần in không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const results = await repo.getResults(tram.id, phanInId);
  // Thời điểm vào trạm READY (để FE tính SLA checklist). Best-effort — thiếu 029/ton_tram thì null.
  let readyTgVao = null;
  try { readyTgVao = await repo.getReadyEntryTime(phanInId); } catch { readyTgVao = null; }
  return {
    phan_in: phanIn,
    ready_tg_vao: readyTgVao,
    checkpoints: results.map((r) => ({ ...r, options: optionsFor(r.ma_checkpoint, r.cau_hinh_json) })),
    state: buildState(results),
  };
}

// Xác nhận 1 mục kỹ thuật (KHUON/FILM/MUC/HSKT) độc lập.
async function confirmItem(phanInId, ma, value, actorId) {
  if (!INPUT_CPS.includes(ma)) {
    throw new AppError('Mục kỹ thuật không hợp lệ', { status: 400, errorCode: 'INVALID_ITEM' });
  }
  if (OPTION_CPS.includes(ma) && (value === undefined || value === null || value === '')) {
    throw new AppError('Vui lòng chọn giá trị trước khi xác nhận', { status: 422, errorCode: 'VALUE_REQUIRED' });
  }
  const { tram, byMa } = await loadConfig();
  const cp = byMa[ma];
  if (!cp) throw new AppError(`Checkpoint ${ma} không còn hiệu lực`, { status: 404, errorCode: 'NO_CHECKPOINT' });

  const results = await repo.getResults(tram.id, phanInId);
  const state = buildState(results);
  if (state.qc_done) throw new AppError('Đã QC xác nhận — dữ liệu đã khóa', { status: 409, errorCode: 'LOCKED' });
  const cur = results.find((r) => r.ma_checkpoint === ma);
  if (cur?.trang_thai === 'DAT') throw new AppError(`Mục ${cp.ten_checkpoint} đã được xác nhận`, { status: 409, errorCode: 'ALREADY' });

  const datId = await wf.getTrangThaiId('DAT');
  await withTransaction(async (client) => {
    const kqId = await repo.upsertResult(client, {
      phanInId,
      checkpointId: cp.id,
      trangThai: 'DAT',
      giaTriText: OPTION_CPS.includes(ma) ? value : null,
      nguoiXacNhanId: actorId,
      tgXacNhan: new Date(),
      actorId,
    });
    await repo.insertStatusLog(client, {
      ketQuaId: kqId, trangThaiMoiId: datId, nguoiId: actorId, lyDo: `Xác nhận ${cp.ten_checkpoint}`,
    });
  });

  const after = buildState(await repo.getResults(tram.id, phanInId));
  await tracking.moveByPhanIn(phanInId, READY_TRAM, actorId); // theo dõi dòng chảy: đợt vải vào trạm READY
  sockets.emit('ready:confirmed', { phanInId, buoc: ma, tech_done: after.tech_done });
  sockets.emit('dashboard:refresh', {});
  return getDetail(phanInId);
}

// Xác nhận nhiều mục kỹ thuật cùng lúc (1 transaction). items: [{ ma, value }].
async function confirmItemsBatch(phanInId, items, actorId) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError('Chưa chọn mục nào để xác nhận', { status: 400, errorCode: 'EMPTY' });
  }
  const { tram, byMa } = await loadConfig();
  const results = await repo.getResults(tram.id, phanInId);
  const state = buildState(results);
  if (state.qc_done) throw new AppError('Đã QC xác nhận — dữ liệu đã khóa', { status: 409, errorCode: 'LOCKED' });

  // Chuẩn hóa + lọc: mục hợp lệ, có checkpoint, chưa DAT, option có value.
  const todo = [];
  for (const it of items) {
    const ma = String(it.ma || '').toUpperCase();
    if (!INPUT_CPS.includes(ma) || !byMa[ma]) continue;
    if (results.find((r) => r.ma_checkpoint === ma)?.trang_thai === 'DAT') continue;
    if (OPTION_CPS.includes(ma)) {
      if (it.value === undefined || it.value === null || it.value === '') {
        throw new AppError(`Vui lòng chọn giá trị cho ${byMa[ma].ten_checkpoint}`, { status: 422, errorCode: 'VALUE_REQUIRED' });
      }
    }
    todo.push({ ma, value: OPTION_CPS.includes(ma) ? it.value : null });
  }
  if (todo.length === 0) throw new AppError('Không có mục nào đủ điều kiện xác nhận', { status: 422, errorCode: 'NOTHING' });

  const datId = await wf.getTrangThaiId('DAT');
  await withTransaction(async (client) => {
    for (const t of todo) {
      const kqId = await repo.upsertResult(client, {
        phanInId, checkpointId: byMa[t.ma].id, trangThai: 'DAT',
        giaTriText: t.value, nguoiXacNhanId: actorId, tgXacNhan: new Date(), actorId,
      });
      await repo.insertStatusLog(client, {
        ketQuaId: kqId, trangThaiMoiId: datId, nguoiId: actorId, lyDo: `Xác nhận ${byMa[t.ma].ten_checkpoint}`,
      });
    }
  });

  const after = buildState(await repo.getResults(tram.id, phanInId));
  await tracking.moveByPhanIn(phanInId, READY_TRAM, actorId); // theo dõi dòng chảy
  sockets.emit('ready:confirmed', { phanInId, buoc: todo.map((t) => t.ma), tech_done: after.tech_done });
  sockets.emit('dashboard:refresh', {});
  return getDetail(phanInId);
}

// Xác nhận 1 mục cho NHIỀU phần in cùng lúc (theo mã hàng / chọn nhiều). 1 mục + 1 giá trị áp cho tất cả.
async function confirmItemBulk(phanInIds, ma, value, actorId) {
  if (!Array.isArray(phanInIds) || phanInIds.length === 0) {
    throw new AppError('Chưa chọn phần in nào', { status: 400, errorCode: 'EMPTY' });
  }
  if (!INPUT_CPS.includes(ma)) throw new AppError('Mục kỹ thuật không hợp lệ', { status: 400, errorCode: 'INVALID_ITEM' });
  if (OPTION_CPS.includes(ma) && (value === undefined || value === null || value === '')) {
    throw new AppError('Vui lòng chọn giá trị', { status: 422, errorCode: 'VALUE_REQUIRED' });
  }
  const { byMa } = await loadConfig();
  const cp = byMa[ma];
  if (!cp) throw new AppError(`Checkpoint ${ma} không còn hiệu lực`, { status: 404, errorCode: 'NO_CHECKPOINT' });
  const qcId = byMa[QC_CP]?.id;

  // Bỏ qua phần in đã xác nhận mục này, hoặc đã QC (khóa).
  const states = await repo.getBulkStates(phanInIds, [cp.id, qcId].filter(Boolean));
  const itemDone = new Set(states.filter((s) => s.checkpoint_id === cp.id).map((s) => s.phan_in_id));
  const qcDone = new Set(qcId ? states.filter((s) => s.checkpoint_id === qcId).map((s) => s.phan_in_id) : []);
  const eligible = phanInIds.filter((id) => !qcDone.has(id) && !itemDone.has(id));

  const datId = await wf.getTrangThaiId('DAT');
  await withTransaction(async (client) => {
    for (const id of eligible) {
      const kqId = await repo.upsertResult(client, {
        phanInId: id, checkpointId: cp.id, trangThai: 'DAT',
        giaTriText: OPTION_CPS.includes(ma) ? value : null,
        nguoiXacNhanId: actorId, tgXacNhan: new Date(), actorId,
      });
      await repo.insertStatusLog(client, {
        ketQuaId: kqId, trangThaiMoiId: datId, nguoiId: actorId, lyDo: `Xác nhận ${cp.ten_checkpoint}`,
      });
    }
  });
  for (const id of eligible) await tracking.moveByPhanIn(id, READY_TRAM, actorId); // theo dõi dòng chảy
  sockets.emit('ready:confirmed', { bulk: true, ma, count: eligible.length });
  sockets.emit('dashboard:refresh', {});
  return { okCount: eligible.length, skippedCount: phanInIds.length - eligible.length };
}

async function confirmQC(phanInId, actorId) {
  const { tram, byMa } = await loadConfig();
  const state = buildState(await repo.getResults(tram.id, phanInId));
  if (!state.tech_done) {
    throw new AppError('Kỹ thuật chưa hoàn tất 4 mục — QC không thể xác nhận', { status: 409, errorCode: 'TECH_NOT_DONE' });
  }
  if (state.qc_done) throw new AppError('Đã QC xác nhận', { status: 409, errorCode: 'ALREADY' });
  if (!byMa[QC_CP]) throw new AppError('Workflow chưa có checkpoint QC', { status: 500, errorCode: 'NO_CHECKPOINT' });

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

// QC xác nhận hàng loạt nhiều phần in. Mỗi id tự validate; gom kết quả.
async function confirmQcBatch(phanInIds, actorId) {
  if (!Array.isArray(phanInIds) || phanInIds.length === 0) {
    throw new AppError('Chưa chọn phần in nào', { status: 400, errorCode: 'EMPTY' });
  }
  const ok = [];
  const failed = [];
  for (const id of phanInIds) {
    try {
      await confirmQC(id, actorId);
      ok.push(id);
    } catch (e) {
      failed.push({ id, message: e.message || 'Lỗi' });
    }
  }
  sockets.emit('dashboard:refresh', {});
  return { ok, failed, okCount: ok.length, failedCount: failed.length };
}

// Hủy xác nhận 1 mục READY (Admin/quyền READY_CANCEL) — khi bấm nhầm.
// Hủy 1 mục kỹ thuật mà QC đã xác nhận → hủy luôn QC để giữ nhất quán (QC cần đủ 4 mục).
async function cancelItem(phanInId, ma, actorId) {
  const CANCELABLE = [...INPUT_CPS, QC_CP];
  if (!CANCELABLE.includes(ma)) {
    throw new AppError('Mục không hợp lệ để hủy', { status: 400, errorCode: 'INVALID_ITEM' });
  }
  const { tram, byMa } = await loadConfig();
  const cp = byMa[ma];
  if (!cp) throw new AppError(`Checkpoint ${ma} không còn hiệu lực`, { status: 404, errorCode: 'NO_CHECKPOINT' });

  // Không cho hủy xác nhận READY khi phần in ĐÃ RELEASE (đã rời trạm READY, đang ở Release/Test/Sản xuất...).
  // Muốn hủy thì phải hủy release/test trước (theo thứ tự ngược lại) — tránh phần in vừa ở READY vừa ở trạm sau.
  if (await repo.isPhanInReleased(phanInId)) {
    throw new AppError('Phần in đã release — hãy hủy xác nhận ở trạm sau (Release/Test Run) trước khi hủy READY', { status: 409, errorCode: 'ALREADY_RELEASED' });
  }

  const results = await repo.getResults(tram.id, phanInId);
  const state = buildState(results);
  const cur = results.find((r) => r.ma_checkpoint === ma);
  if (cur?.trang_thai !== 'DAT') throw new AppError('Mục này chưa được xác nhận', { status: 409, errorCode: 'NOT_CONFIRMED' });

  const huyList = [ma];
  await withTransaction(async (client) => {
    await repo.cancelResult(client, phanInId, cp.id, actorId);
    if (INPUT_CPS.includes(ma) && state.qc_done && byMa[QC_CP]) {
      await repo.cancelResult(client, phanInId, byMa[QC_CP].id, actorId);
      huyList.push(QC_CP);
    }
  });
  await repo.logCancel(phanInId, huyList, actorId);
  sockets.emit('ready:confirmed', { phanInId, huy: huyList });
  sockets.emit('dashboard:refresh', {});
  return getDetail(phanInId);
}

// Lịch sử xác nhận READY đang hiệu lực (cho trang "Lịch sử trạng thái" — Hệ thống). Kèm nhãn mục.
async function confirmHistory(date, search) {
  const LABEL = { KHUON: 'Khuôn', FILM: 'Film', MUC: 'Mực', HSKT: 'HSKT', QC_XAC_NHAN: 'QC xác nhận' };
  const rows = await repo.listConfirmHistory({ date, search: search || '' });
  return rows.map((r) => ({ ...r, muc_label: LABEL[r.ma_checkpoint] || r.ten_checkpoint || r.ma_checkpoint }));
}

async function history(date, scope) {
  const maList = scope === 'qc' ? ['QC_XAC_NHAN'] : INPUT_CPS;
  const rows = await repo.historyByDate(date, maList);
  return rows.map((r) => ({
    tg: r.tg,
    nguoi: r.nguoi || '—',
    hanh_dong: r.hanh_dong || 'Xác nhận',
    doi_tuong: [r.ma_phan, r.ma_hang].filter(Boolean).join(' · '),
    chi_tiet: r.chi_tiet || '',
  }));
}

// Danh sách phần in đã hoàn thành checkpoint READY theo ngày (cho DonePanel).
async function done(date, scope) {
  return repo.doneByDate(date, scope === 'qc' ? 'qc' : 'tech');
}

module.exports = {
  getConfig, listCandidates, getDetail, confirmItem, confirmItemsBatch, confirmItemBulk,
  confirmQC, confirmQcBatch, cancelItem, history, done, confirmHistory,
};
