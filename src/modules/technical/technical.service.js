'use strict';

const { withTransaction } = require('../../config/db');
const repo = require('./technical.repository');
const qaRepo = require('../quality/quality.repository'); // qc_tra_ve dùng chung
const wf = require('../workflow/workflow.repository');
const AppError = require('../../utils/AppError');
const { buildMeta } = require('../../utils/pagination');
const sockets = require('../../sockets');
const tracking = require('../workflow/tracking.service');
const { isKhuonOptional } = require('../../utils/tech');

const READY_TRAM = 'READY';
const INPUT_CPS = ['KHUON', 'FILM', 'MUC']; // 3 mục kỹ thuật, xác nhận độc lập (HSKT đã bỏ)
const OPTION_CPS = ['KHUON', 'FILM', 'MUC']; // cần chọn option khi xác nhận
const QC_CP = 'QC_XAC_NHAN';
const TECH_TOTAL = INPUT_CPS.length; // số mục kỹ thuật cần đủ để hoàn tất READY
// ĐÃ BỎ ràng buộc thứ tự "Khuôn mới cần Film trước" (theo yêu cầu: READY không còn chọn giá trị mới/cũ/gia công,
// chỉ cần XÁC NHẬN là xong). Giữ CP_REQUIRES rỗng để mọi nhánh phụ thuộc thành no-op — không cần sửa call-site.
const CP_REQUIRES = {};
const depKey = (ma) => `${(CP_REQUIRES[ma] || '').toLowerCase()}_done`;
const depApplies = () => false; // không còn ràng buộc phụ thuộc nào
// Option mặc định (dùng khi cấu hình checkpoint chưa khai báo trong DB).
const DEFAULT_OPTIONS = {};

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
    thoi_gian_quy_dinh_phut: r.cp_sla, canh_bao_truoc_phut: r.cp_cb,
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
  // Khách II/AD: Khuôn KHÔNG bắt buộc → đủ KT = Film + Mực. Khách khác = đủ 3 mục.
  const tenKhach = results[0]?.ten_khach_hang;
  const khuonReq = !isKhuonOptional(tenKhach);
  return {
    khuon_done,
    film_done,
    muc_done,
    khuon_required: khuonReq,
    tech_done: film_done && muc_done && (khuon_done || !khuonReq),
    qc_done: done(QC_CP),
  };
}

async function getConfig() {
  const { tram, checkpoints } = await loadConfig();
  return { tram, checkpoints: checkpoints.map((c) => ({ ...c, options: optionsFor(c.ma_checkpoint, c.cau_hinh_json) })) };
}

// onlyQcReady=true: chỉ phần in đã đủ 3 mục kỹ thuật & chưa QC (cho màn QC bên Chất lượng).
async function listCandidates({ search, page, limit, offset, onlyQcReady = false }) {
  const { tram, byMa } = await loadConfig();
  const inputIds = INPUT_CPS.map((ma) => byMa[ma]?.id).filter(Boolean);
  // SLA hàng READY theo GIAI ĐOẠN (task 3):
  //  - Màn Kỹ thuật (KT chưa đủ 3 mục): dùng SLA trạm READY, đếm từ lúc vào READY. KT xong 3 mục ⇒ ngừng đếm (không đỏ).
  //  - Màn QC (đủ 3 mục, chờ QC): dùng SLA checkpoint QC_XAC_NHAN, đếm từ lúc KT hoàn tất (mục KT cuối được xác nhận).
  const readySla = tram.thoi_gian_quy_dinh_phut != null ? tram.thoi_gian_quy_dinh_phut : 480;
  const readyCanhBao = tram.canh_bao_truoc_phut != null ? tram.canh_bao_truoc_phut : 60;
  const qcCp = byMa[QC_CP] || {};
  const qcSla = qcCp.thoi_gian_quy_dinh_phut != null ? qcCp.thoi_gian_quy_dinh_phut : 60;
  const qcCanhBao = qcCp.canh_bao_truoc_phut != null ? qcCp.canh_bao_truoc_phut : 15;
  const { rows, total } = await repo.listCandidates({
    search, inputIds, qcId: byMa[QC_CP]?.id,
    khuonId: byMa.KHUON?.id, filmId: byMa.FILM?.id, mucId: byMa.MUC?.id,
    onlyQcReady, offset, limit, readySla, readyCanhBao, qcSla, qcCanhBao, techTotal: TECH_TOTAL,
  });
  // Đánh dấu phần in bị QC (READY) trả về (badge + lọc "chỉ hiện phần bị trả về").
  const rm = await qaRepo.activeReturnsMap('READY', rows.map((r) => r.id));
  const items = rows.map((r) => ({
    ...r,
    trang_thai_ready: r.qc_done ? 'DONE' : r.tech_done ? 'CHO_QC' : r.n_tech_done > 0 ? 'DANG' : 'CHUA',
    tra_ve: rm[r.id] || null,
    tra_ve_ly_do: rm[r.id]?.ly_do || null, // giữ tương thích cũ
  }));
  return { items, meta: buildMeta(page, limit, total) };
}

// Đếm số phần in CHƯA xác nhận từng mục kỹ thuật (KHUON/FILM/MUC) trên toàn hệ thống.
async function itemCounts() {
  const { byMa } = await loadConfig();
  return repo.countReadyItems({
    khuonId: byMa.KHUON?.id, filmId: byMa.FILM?.id, mucId: byMa.MUC?.id, qcId: byMa[QC_CP]?.id,
  });
}

// QC chuẩn bị kỹ thuật TRẢ VỀ Ready kỹ thuật: chọn các checklist rớt → hủy xác nhận các mục đó
// (+ hủy QC nếu đã có) để bộ phận kỹ thuật làm lại. Lý do bắt buộc.
async function returnToTech(phanInId, { checklists, lyDo }, actorId) {
  const reason = (lyDo || '').trim();
  if (!reason) throw new AppError('Nhập lý do trả về', { status: 422, errorCode: 'NO_LY_DO' });
  const chosen = (Array.isArray(checklists) ? checklists : [])
    .map((m) => String(m || '').toUpperCase()).filter((m) => INPUT_CPS.includes(m));
  if (chosen.length === 0) throw new AppError('Chọn ít nhất 1 mục kỹ thuật không đạt', { status: 422, errorCode: 'NO_ITEM' });

  if (await repo.isPhanInReleased(phanInId)) {
    throw new AppError('Phần in đã release — không thể trả về kỹ thuật', { status: 409, errorCode: 'ALREADY_RELEASED' });
  }
  const { tram, byMa } = await loadConfig();
  const results = await repo.getResults(tram.id, phanInId);
  const state = buildState(results);

  const huyList = [];
  await withTransaction(async (client) => {
    for (const ma of chosen) {
      if (!byMa[ma]) continue;
      const cur = results.find((r) => r.ma_checkpoint === ma);
      if (cur?.trang_thai === 'DAT') { await repo.cancelResult(client, phanInId, byMa[ma].id, actorId); huyList.push(ma); }
    }
    // Hủy luôn QC nếu đã xác nhận (để làm lại từ kỹ thuật → QC).
    if (state.qc_done && byMa[QC_CP]) { await repo.cancelResult(client, phanInId, byMa[QC_CP].id, actorId); }
  });
  await qaRepo.insertQcTraVe({ loai: 'READY', phanInId, checklistList: chosen.join(','), lyDo: reason }, actorId);
  sockets.emit('ready:confirmed', { phanInId, tra_ve: chosen });
  sockets.emit('dashboard:refresh', {});
  return { phan_in_id: phanInId, huy: huyList, checklists: chosen };
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
  // Giá trị (mới/cũ/gia công) KHÔNG còn bắt buộc — chỉ cần xác nhận là xong.
  const { tram, byMa } = await loadConfig();
  const cp = byMa[ma];
  if (!cp) throw new AppError(`Checkpoint ${ma} không còn hiệu lực`, { status: 404, errorCode: 'NO_CHECKPOINT' });

  const results = await repo.getResults(tram.id, phanInId);
  const state = buildState(results);
  if (state.qc_done) throw new AppError('Đã QC xác nhận — dữ liệu đã khóa', { status: 409, errorCode: 'LOCKED' });
  const cur = results.find((r) => r.ma_checkpoint === ma);
  if (cur?.trang_thai === 'DAT') throw new AppError(`Mục ${cp.ten_checkpoint} đã được xác nhận`, { status: 409, errorCode: 'ALREADY' });
  // Ràng buộc phụ thuộc: vd chưa xác nhận Film thì không xác nhận Khuôn (chỉ khi Khuôn MỚI).
  const dep = CP_REQUIRES[ma];
  if (dep && !state[depKey(ma)] && depApplies(ma, value)) {
    throw new AppError(`Phải xác nhận ${byMa[dep]?.ten_checkpoint || dep} trước khi xác nhận ${cp.ten_checkpoint} (khuôn mới)`, { status: 409, errorCode: 'DEP_NOT_MET' });
  }

  const datId = await wf.getTrangThaiId('DAT');
  await withTransaction(async (client) => {
    const kqId = await repo.upsertResult(client, {
      phanInId,
      checkpointId: cp.id,
      trangThai: 'DAT',
      giaTriText: OPTION_CPS.includes(ma) ? (value ?? null) : null,
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
    // Giá trị không bắt buộc — lưu nếu có gửi, không thì null.
    todo.push({ ma, value: OPTION_CPS.includes(ma) ? (it.value ?? null) : null });
  }
  if (todo.length === 0) throw new AppError('Không có mục nào đủ điều kiện xác nhận', { status: 422, errorCode: 'NOTHING' });
  // Ràng buộc phụ thuộc: mục phụ thuộc phải đã DAT HOẶC được xác nhận cùng lô này (vd Khuôn cần Film).
  for (const t of todo) {
    const dep = CP_REQUIRES[t.ma];
    if (dep && !state[depKey(t.ma)] && !todo.some((x) => x.ma === dep) && depApplies(t.ma, t.value)) {
      throw new AppError(`Phải xác nhận ${byMa[dep]?.ten_checkpoint || dep} trước (hoặc cùng lúc) khi xác nhận ${byMa[t.ma].ten_checkpoint} (khuôn mới)`, { status: 409, errorCode: 'DEP_NOT_MET' });
    }
  }

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
  // Giá trị không còn bắt buộc — chỉ cần xác nhận.
  const { byMa } = await loadConfig();
  const cp = byMa[ma];
  if (!cp) throw new AppError(`Checkpoint ${ma} không còn hiệu lực`, { status: 404, errorCode: 'NO_CHECKPOINT' });
  const qcId = byMa[QC_CP]?.id;
  const depMa = CP_REQUIRES[ma];
  const depId = (depMa && depApplies(ma, value)) ? byMa[depMa]?.id : null; // Khuôn cũ/Gia công → bỏ ràng buộc Film

  // Bỏ qua phần in đã xác nhận mục này, đã QC (khóa), hoặc CHƯA xác nhận mục phụ thuộc (vd Khuôn cần Film).
  const states = await repo.getBulkStates(phanInIds, [cp.id, qcId, depId].filter(Boolean));
  const itemDone = new Set(states.filter((s) => s.checkpoint_id === cp.id).map((s) => s.phan_in_id));
  const qcDone = new Set(qcId ? states.filter((s) => s.checkpoint_id === qcId).map((s) => s.phan_in_id) : []);
  const depDone = new Set(depId ? states.filter((s) => s.checkpoint_id === depId).map((s) => s.phan_in_id) : []);
  const eligible = phanInIds.filter((id) => !qcDone.has(id) && !itemDone.has(id) && (!depId || depDone.has(id)));

  const datId = await wf.getTrangThaiId('DAT');
  await withTransaction(async (client) => {
    for (const id of eligible) {
      const kqId = await repo.upsertResult(client, {
        phanInId: id, checkpointId: cp.id, trangThai: 'DAT',
        giaTriText: OPTION_CPS.includes(ma) ? (value ?? null) : null,
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
    throw new AppError('Kỹ thuật chưa hoàn tất — QC không thể xác nhận', { status: 409, errorCode: 'TECH_NOT_DONE' });
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
  await qaRepo.resolveReturns('READY', phanInId); // QC đạt lại → tắt cờ "bị QC trả về"
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

// Bỏ tích 1 mục kỹ thuật (KHUON/FILM/MUC) NGAY TRONG luồng Quét/tích — cho phép người có quyền tech
// tự sửa khi tích LỘN phần in (khác `cancelItem` cần quyền READY_CANCEL). Chỉ mục kỹ thuật, chưa QC, chưa release.
async function uncheckItem(phanInId, ma, actorId) {
  if (!INPUT_CPS.includes(ma)) throw new AppError('Mục kỹ thuật không hợp lệ', { status: 400, errorCode: 'INVALID_ITEM' });
  const { tram, byMa } = await loadConfig();
  const cp = byMa[ma];
  if (!cp) throw new AppError(`Checkpoint ${ma} không còn hiệu lực`, { status: 404, errorCode: 'NO_CHECKPOINT' });
  if (await repo.isPhanInReleased(phanInId)) {
    throw new AppError('Phần in đã release — không thể bỏ tích', { status: 409, errorCode: 'ALREADY_RELEASED' });
  }
  const results = await repo.getResults(tram.id, phanInId);
  const state = buildState(results);
  if (state.qc_done) throw new AppError('Đã QC xác nhận — không thể bỏ tích', { status: 409, errorCode: 'LOCKED' });
  const cur = results.find((r) => r.ma_checkpoint === ma);
  if (cur?.trang_thai !== 'DAT') throw new AppError('Mục này chưa được xác nhận', { status: 409, errorCode: 'NOT_CONFIRMED' });
  await withTransaction(async (client) => { await repo.cancelResult(client, phanInId, cp.id, actorId); });
  await repo.logCancel(phanInId, [ma], actorId);
  sockets.emit('ready:confirmed', { phanInId, huy: [ma] });
  sockets.emit('dashboard:refresh', {});
  return { phan_in_id: phanInId, ma };
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

// ─── "Mở READY" (admin) — phần in đi tắt READY (đợt mới tự vào Release 1) ─────
async function reopenCandidates(search) {
  return repo.listReopenCandidates({ search: search || '' });
}

// Mở lại READY cho 1 phần in: hủy xác nhận READY (Khuôn/Film/Mực/QC) + gắn cờ đợt mới làm lại READY/Test Run.
// Phần in quay lại danh sách Chuẩn bị kỹ thuật (đợt đã sản xuất trước không bị ảnh hưởng).
async function reopenReady(phanInId, actorId) {
  const pin = await repo.getPhanInBasic(phanInId);
  if (!pin) throw new AppError('Phần in không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  let huy = 0; let flagged = 0;
  await withTransaction(async (client) => {
    huy = await repo.reopenReadyResults(client, phanInId, actorId);
    flagged = await repo.flagUnreleasedDotLamLai(client, phanInId, actorId);
  });
  if (huy === 0 && flagged === 0) {
    throw new AppError('Phần in không ở trạng thái đi tắt READY (không có gì để mở lại)', { status: 409, errorCode: 'NOTHING_TO_REOPEN' });
  }
  await repo.logReopenReady(phanInId, { huy_xac_nhan: huy, dot_lam_lai: flagged }, actorId);
  sockets.emit('ready:confirmed', { phanInId, mo_lai_ready: true });
  sockets.emit('dashboard:refresh', {});
  return { phanInId, huy, flagged };
}

module.exports = {
  getConfig, listCandidates, itemCounts, getDetail, confirmItem, confirmItemsBatch, confirmItemBulk,
  confirmQC, confirmQcBatch, cancelItem, uncheckItem, history, done, confirmHistory, returnToTech,
  reopenCandidates, reopenReady,
};
