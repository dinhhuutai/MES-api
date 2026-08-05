'use strict';

const { withTransaction } = require('../../config/db');
const repo = require('./planning.repository');
const qaRepo = require('../quality/quality.repository'); // qc_tra_ve dùng chung
const productionRepo = require('../production/production.repository'); // phiếu+tem gia công (→ OQC)
const chuyenRepo = require('../chuyen/chuyen.repository');
const wf = require('../workflow/workflow.repository');
const AppError = require('../../utils/AppError');
const { buildMeta } = require('../../utils/pagination');
const sockets = require('../../sockets');
const tracking = require('../workflow/tracking.service');
const erpRepo = require('../erpsync/erpsync.repository'); // reopenReadyForPhanIn (mở lại READY)

const TEST_TRAM = 'TEST_RUN';
const CNSP_CP = 'TEST_CNSP';
const QA_CP = 'TEST_QA';
const SL_NHO_BO_TEST = 100; // đợt SX tổng SL < ngưỡng này → bỏ Test Run (điểm 5). Ngưỡng cấu hình được sau.

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
  rows.forEach((r) => { r.tra_ve = rm[r.dot_vai_id] || null; r.tra_ve_ly_do = rm[r.dot_vai_id]?.ly_do || null; });
  return { items: rows, meta: buildMeta(page, limit, total) };
}

// ----- GỘP SỐ LƯỢNG ĐỢT VẢI -----
async function listGopCandidates({ search }) {
  const rows = await repo.listGopCandidates({ search: search || '' });
  return { items: rows };
}

// Gộp SL từ (các) đợt NGUỒN vào 1 đợt ĐÍCH của CÙNG phần in. Nguồn về 0 → ẩn khỏi hệ thống.
// nguon: [{ dotVaiId, soLuong }].
async function gopDotVai({ dotDichId, nguon }, actorId) {
  if (!dotDichId) throw new AppError('Chưa chọn đợt vải đích (gộp vào)', { status: 422, errorCode: 'NO_DICH' });
  const sources = (Array.isArray(nguon) ? nguon : [])
    .map((n) => ({ dotVaiId: n.dotVaiId, soLuong: Number(n.soLuong) }))
    .filter((n) => n.dotVaiId && n.dotVaiId !== dotDichId);
  if (sources.length === 0) throw new AppError('Chọn ít nhất 1 đợt vải nguồn để gộp', { status: 422, errorCode: 'NO_NGUON' });

  const result = await withTransaction(async (client) => {
    const ids = [dotDichId, ...sources.map((s) => s.dotVaiId)];
    const rows = await repo.getDotVaiForMerge(client, ids);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    const dich = byId[dotDichId];
    if (!dich) throw new AppError('Đợt vải đích không tồn tại', { status: 404, errorCode: 'DICH_NOT_FOUND' });
    if (dich.trang_thai === 'DA_GOP') throw new AppError('Đợt vải đích đã bị ẩn', { status: 409, errorCode: 'DICH_GOP' });
    if (dich.da_release > 0) throw new AppError('Đợt vải đích đã release — không thể gộp', { status: 409, errorCode: 'DICH_RELEASED' });

    let dichQty = dich.so_luong_vai_ve;
    const done = [];
    for (const s of sources) {
      const src = byId[s.dotVaiId];
      if (!src) throw new AppError('Đợt vải nguồn không tồn tại', { status: 404, errorCode: 'NGUON_NOT_FOUND' });
      if (src.phan_in_id !== dich.phan_in_id) {
        throw new AppError('Chỉ gộp được các đợt vải của CÙNG một phần in', { status: 422, errorCode: 'DIFF_PHAN_IN' });
      }
      if (src.trang_thai === 'DA_GOP') throw new AppError(`Đợt ${src.ma_dot_vai} đã bị ẩn`, { status: 409, errorCode: 'NGUON_GOP' });
      if (src.da_release > 0) throw new AppError(`Đợt ${src.ma_dot_vai} đã release — không thể gộp`, { status: 409, errorCode: 'NGUON_RELEASED' });
      if (!(s.soLuong > 0)) throw new AppError(`SL gộp của đợt ${src.ma_dot_vai} phải > 0`, { status: 422, errorCode: 'INVALID_QTY' });
      if (s.soLuong > src.so_luong_vai_ve) {
        throw new AppError(`SL gộp (${s.soLuong}) vượt SL đợt ${src.ma_dot_vai} (${src.so_luong_vai_ve})`, { status: 422, errorCode: 'OVER' });
      }

      const dichTruoc = dichQty;
      const nguonTruoc = src.so_luong_vai_ve;
      dichQty = await repo.adjustDotVaiQty(client, dotDichId, s.soLuong, actorId);
      const nguonSau = await repo.adjustDotVaiQty(client, s.dotVaiId, -s.soLuong, actorId);
      const nguonHet = nguonSau <= 0;
      if (nguonHet) await repo.markDotVaiGop(client, s.dotVaiId, actorId);
      src.so_luong_vai_ve = nguonSau; // cập nhật cho vòng lặp (không dùng lại nhưng an toàn)
      await repo.insertGopHistory(client, {
        dotDichId, dotNguonId: s.dotVaiId, phanInId: dich.phan_in_id, soLuongGop: s.soLuong,
        soLuongDichTruoc: dichTruoc, soLuongDichSau: dichQty,
        soLuongNguonTruoc: nguonTruoc, soLuongNguonSau: nguonSau, nguonHet,
      }, actorId);
      done.push({ dot_nguon_id: s.dotVaiId, so_luong_gop: s.soLuong, nguon_het: nguonHet });
    }
    return { dot_dich_id: dotDichId, so_luong_dich: dichQty, gop: done };
  });

  sockets.emit('workflow:updated', { gop: true });
  sockets.emit('order:updated', { source: 'gop' });
  sockets.emit('dashboard:refresh', {});
  return result;
}

async function gopHistory(date) {
  const rows = await repo.gopHistoryByDate(date || new Date().toISOString().slice(0, 10));
  return rows.map((r) => ({
    tg: r.tg,
    nguoi: r.nguoi || '—',
    hanh_dong: 'Gộp số lượng',
    doi_tuong: [r.ma_phan, r.mau_vai].filter(Boolean).join(' · '),
    chi_tiet: `${r.dot_nguon || '?'} → ${r.dot_dich || '?'}: +${r.so_luong_gop}`
      + ` (đích ${r.so_luong_dich_truoc}→${r.so_luong_dich_sau})`
      + (r.nguon_het ? ' · nguồn hết → ẩn' : ''),
  }));
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

const DAILY_HOURS = 8; // giờ SX / ngày (dùng để đóng gói lịch theo ngày trên chuyền)
const pad2 = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const addDaysIso = (baseDate, n) => { const d = new Date(baseDate); d.setDate(d.getDate() + n); return isoDate(d); };

async function autoPlanCandidates({ search }) {
  const { rows } = await repo.listRelease1Candidates({ search, offset: 0, limit: 1000 });
  const rm = await qaRepo.activeReturnsMap('TEST_RUN', rows.map((r) => r.dot_vai_id));
  const chuyens = (await chuyenRepo.listChuyen({ search: '' }))
    .filter((c) => c.dang_hoat_dong)
    // Số pass lấy từ cấu hình chuyền (mig 048); chưa cấu hình (null/0/1 mặc định) → giữ mock để năng suất còn ý nghĩa.
    .map((c) => ({ id: c.id, ma_chuyen: c.ma_chuyen, ten_chuyen: c.ten_chuyen, so_pass: Number(c.so_pass) > 1 ? Number(c.so_pass) : mockPassChuyen(c.id) }));

  const items = rows.map((r) => {
    const hskt = mockHskt(r.phan_in_id);
    const qtyPlan = Number(r.con_release ?? r.so_luong_vai_ve) || 0; // xếp theo SL CÒN LẠI cần release
    const chuyenOptions = chuyens
      .map((c) => ({
        chuyen_id: c.id, ma_chuyen: c.ma_chuyen, ten_chuyen: c.ten_chuyen, so_pass: c.so_pass,
        ...tinhNangSuat(hskt, c.so_pass, qtyPlan),
      }))
      .sort((a, b) => b.nang_suat_gio - a.nang_suat_gio);
    return { ...r, tra_ve: rm[r.dot_vai_id] || null, tra_ve_ly_do: rm[r.dot_vai_id]?.ly_do || null, hskt, qty_plan: qtyPlan, chuyen_options: chuyenOptions, best_chuyen: null };
  });

  // CÂN BẰNG TẢI MỌI CHUYỀN (điểm 12) — LPT list-scheduling để makespan nhỏ nhất + mọi chuyền có việc:
  //  1) sắp đợt theo SL giảm dần (ưu tiên hạn giao sớm khi bằng);
  //  2) gán mỗi đợt vào chuyền HOÀN THÀNH SỚM NHẤT = min(tải hiện tại + giờ SX đợt trên chuyền đó);
  //  3) ngày kế hoạch = đóng gói tuần tự theo tải (8h/ngày) trên chuyền được gán.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const loadHours = {}; chuyens.forEach((c) => { loadHours[c.id] = 0; });
  const order = [...items].sort((a, b) => {
    if (b.qty_plan !== a.qty_plan) return b.qty_plan - a.qty_plan;
    const ha = a.han_giao_hang ? new Date(a.han_giao_hang).getTime() : Infinity;
    const hb = b.han_giao_hang ? new Date(b.han_giao_hang).getTime() : Infinity;
    return ha - hb;
  });
  order.forEach((it) => {
    const optByChuyen = Object.fromEntries(it.chuyen_options.map((o) => [o.chuyen_id, o]));
    let bestId = null; let bestFinish = Infinity; let bestHours = DAILY_HOURS; let bestOpt = null;
    for (const c of chuyens) {
      const opt = optByChuyen[c.id];
      const ns = (opt && opt.nang_suat_gio) || 0;
      const hours = ns > 0 ? it.qty_plan / ns : DAILY_HOURS;
      const finish = (loadHours[c.id] || 0) + hours;
      if (finish < bestFinish) { bestFinish = finish; bestId = c.id; bestHours = hours; bestOpt = opt; }
    }
    it.best_chuyen = bestOpt || it.chuyen_options[0] || null;
    it.so_gio_sx = Math.round(bestHours * 10) / 10;
    it.ngay_ke_hoach = bestId ? addDaysIso(today, Math.floor((loadHours[bestId] || 0) / DAILY_HOURS)) : isoDate(today);
    if (bestId) loadHours[bestId] += bestHours;
  });
  items.forEach((it) => { if (!it.ngay_ke_hoach) it.ngay_ke_hoach = isoDate(today); });

  // "ĐÃ LÊN KẾ HOẠCH" = lệnh đã Release 1 → chờ sản xuất (RELEASE_1/RELEASE_2) CHƯA có phiếu SX
  // (đã xác nhận chạy → có phiếu → tự loại). Gắn best_chuyen theo chuyền đã chọn để xếp trên sơ đồ.
  const planned = (await repo.listReplanCandidates({ search, offset: 0, limit: 1000 })).rows.map((r) => ({
    ...r, planned: true, dot_vai_id: null,
    best_chuyen: r.chuyen_id ? { chuyen_id: r.chuyen_id, ma_chuyen: r.ma_chuyen, ten_chuyen: r.ten_chuyen, nang_suat_gio: null } : null,
  }));

  return { items, planned, chuyens };
}

// GIA CÔNG: đợt SX gửi ra ngoài gia công → KHÔNG in trong xưởng. Release 1 / Tạo đợt SX chỉ TẠO LỆNH
// ở trạng thái 'GIA_CONG' (đậu ở màn "Gia công" của Kế hoạch); chưa tạo phiếu/tem, CHƯA qua OQC.
// Kế hoạch bấm "Chuyển OQC" (confirmGiaCongToOqc) mới tạo phiếu HOAN_TAT + tem CHO_OQC và sang OQC.
async function createGiaCongLenh(client, { versionId, chuyenId, junctions, tongSL, ngayKeHoach, tgBdKh, tgKtKh }, actorId) {
  const maLenh = await repo.nextMaLenhTx(client);
  const lenhId = await repo.createLenh(client, {
    versionId, maLenh, chuyenId, soLuongRelease: tongSL, ngayKeHoach, trangThai: 'GIA_CONG', giaiDoan: 'IN',
    tgBdKh: tgBdKh || null, tgKtKh: tgKtKh || null,
  }, actorId);
  for (const j of junctions) await repo.addLenhDotVai(client, lenhId, j.dotVaiId, actorId, j.soLuong);
  return { id: lenhId, ma_lenh_san_xuat: maLenh };
}

// Trả 1 đợt vải ở Release 1 NGƯỢC về Kỹ thuật: mở lại READY cho phần in (hủy xác nhận Khuôn/Film/Mực/QC
// + gắn cờ can_lam_lai_ready cho đợt chưa release). Chỉ khi đợt CHƯA release (chưa có lệnh ≠ HUY).
// ⚠⚠ GOM SET → TRẢ VỀ NGUYÊN CẢ SET: các phần in trong set in CHUNG (release ra 1 lệnh, all-or-nothing)
// nên trả lẻ 1 phần in sẽ để set nửa Ready nửa không — set vẫn không release được mà kỹ thuật cũng
// không biết mấy phần còn lại phải làm lại. Chốt: bấm trả về 1 đợt trong set = mở lại READY cho MỌI
// phần in của set đó (mỗi phần in 1 dòng audit + 1 cờ qc_tra_ve để badge/lý do hiện ở màn READY).
async function traVeKyThuat({ dotVaiId, lyDo }, actorId) {
  if (!dotVaiId) throw new AppError('Thiếu đợt vải', { status: 400, errorCode: 'EMPTY' });
  const reason = (lyDo || '').trim();
  if (!reason) throw new AppError('Nhập lý do trả về Kỹ thuật', { status: 422, errorCode: 'NO_LY_DO' });
  const pinId = await repo.phanInIdByDotVai(dotVaiId);
  if (!pinId) throw new AppError('Không tìm thấy đợt vải', { status: 404, errorCode: 'NOT_FOUND' });

  const set = await repo.getOpenSetOfDotVai(dotVaiId);
  const members = set ? await repo.getSetMembersForRelease(set.id) : [];
  const laSet = !!set && members.length > 0;
  // 1 phần in có thể có NHIỀU đợt vải trong set ⇒ gom theo phan_in_id (reopenReadyForPhanIn đã gắn cờ
  // can_lam_lai_ready cho mọi đợt chưa release của phần in đó, chạy 2 lần là thừa).
  const targets = laSet
    ? [...new Map(members.map((m) => [m.phan_in_id, m])).values()].map((m) => ({ pinId: m.phan_in_id, dotVaiId: m.dot_vai_id }))
    : [{ pinId, dotVaiId }];

  const daRelease = laSet ? members.some((m) => m.da_release) : await repo.dotVaiReleasedOne(dotVaiId);
  if (daRelease) {
    throw new AppError(
      laSet
        ? `Set ${set.ma_set} đã có đợt vải release — hãy hủy lệnh trước khi trả về Kỹ thuật`
        : 'Đợt vải đã release — hãy hủy lệnh trước khi trả về Kỹ thuật',
      { status: 409, errorCode: 'RELEASED' }
    );
  }

  for (const t of targets) {
    await erpRepo.reopenReadyForPhanIn(t.pinId);
    await repo.auditTraVeKyThuat(t.pinId, t.dotVaiId, reason, actorId);
    // Ghi qc_tra_ve loai='RELEASE1' (mức phần in) → màn READY/QC READY hiện badge + LÝ DO trả về;
    // cờ tự tắt khi QC xác nhận READY lại (technical.confirmQC → resolveReturns('RELEASE1')).
    await qaRepo.insertQcTraVe({ loai: 'RELEASE1', phanInId: t.pinId, dotVaiId: t.dotVaiId, lyDo: reason }, actorId);
    await tracking.moveByPhanIn(t.pinId, 'READY', actorId);
  }
  sockets.emit('workflow:updated', { stage: 'READY', traVe: true });
  sockets.emit('ready:confirmed', { traVe: true }); // READY & QC READY nghe event này để tải lại ngầm
  sockets.emit('dashboard:refresh', {});
  return { phan_in_id: pinId, so_phan_in: targets.length, ma_set: laSet ? set.ma_set : null };
}

async function createRelease1({ dotVaiIds, chuyenId, soLuongRelease, ngayKeHoach, tgBdKh, tgKtKh }, actorId) {
  if (!Array.isArray(dotVaiIds) || dotVaiIds.length === 0) {
    throw new AppError('Chọn ít nhất một đợt vải', { status: 422, errorCode: 'NO_DOT_VAI' });
  }
  if (!chuyenId) throw new AppError('Chọn chuyền sản xuất', { status: 422, errorCode: 'NO_CHUYEN' });

  // KẾ HOẠCH TẠM (mig 058): tách đợt ĐÃ QC (Ready xong → release ngay) vs CHƯA QC (→ lưu kế hoạch tạm).
  const qcInfo = await repo.getDotVaiForCompose(dotVaiIds);
  const qcMap = Object.fromEntries(qcInfo.map((r) => [r.id, r]));
  const readyIds = dotVaiIds.filter((id) => qcMap[id]?.qc_done);
  const waitIds = dotVaiIds.filter((id) => !qcMap[id]?.qc_done);
  const remainAll = await repo.getDotVaiRemaining(dotVaiIds);
  const conAll = Object.fromEntries(remainAll.map((r) => [r.id, r.con_release]));
  let tamCount = 0;
  for (const dvId of waitIds) {
    const con = Number(conAll[dvId]) || 0;
    if (con <= 0) continue;
    const qty = (dotVaiIds.length === 1 && soLuongRelease != null) ? Math.min(Number(soLuongRelease) || con, con) : con;
    await repo.upsertKeHoachTam({
      dotVaiId: dvId, phanInId: qcMap[dvId]?.phan_in_id, chuyenId, ngayKeHoach,
      tgBdKh: tgBdKh || null, tgKtKh: tgKtKh || null, soLuong: qty,
    }, actorId);
    tamCount += 1;
  }
  if (readyIds.length === 0) {
    sockets.emit('dashboard:refresh', {});
    return { created_count: 0, created_summary: [], ke_hoach_tam_count: tamCount, chi_tam: true };
  }

  // RELEASE THEO SỐ LƯỢNG: mỗi đợt còn "con_release = SL vải về − đã release". Release 1 lần = 1 lệnh với
  // SL nhập (≤ còn lại); đợt Ở LẠI pool tới khi release đủ ⇒ 1 đợt có thể có NHIỀU lệnh.
  const remain = await repo.getDotVaiRemaining(readyIds);
  const conMap = Object.fromEntries(remain.map((r) => [r.id, r.con_release]));
  const single = readyIds.length === 1;

  // Xác định SL release từng đợt + validate. Single có nhập SL → dùng SL nhập; còn lại → release hết phần còn.
  const plan = [];
  for (const dvId of readyIds) {
    const con = Number(conMap[dvId]) || 0;
    if (single && soLuongRelease != null) {
      const qty = Number(soLuongRelease);
      if (!(qty > 0)) throw new AppError('Số lượng release phải > 0', { status: 422, errorCode: 'INVALID_QTY' });
      if (qty > con) throw new AppError(`SL release (${qty}) vượt SL còn lại (${con})`, { status: 422, errorCode: 'OVER' });
      plan.push({ dvId, qty });
    } else if (con > 0) {
      plan.push({ dvId, qty: con }); // batch: release hết phần còn lại; bỏ qua đợt đã release đủ
    }
  }
  if (plan.length === 0) {
    if (tamCount > 0) { sockets.emit('dashboard:refresh', {}); return { created_count: 0, created_summary: [], ke_hoach_tam_count: tamCount, chi_tam: true }; }
    throw new AppError('Các đợt vải đã release đủ số lượng', { status: 409, errorCode: 'ALL_RELEASED' });
  }

  // GIA CÔNG (chuyền loại GIA_CONG): mỗi đợt → 1 lệnh ĐẬU Ở MÀN "GIA CÔNG" (trang_thai='GIA_CONG'),
  // chưa qua OQC. Kế hoạch bấm "Chuyển OQC" mới tạo tem + sang OQC (bỏ Test Run/Release 2/Sản xuất/KCS/Sửa).
  const chuyenLoai = await repo.getChuyenLoai(chuyenId);
  if (chuyenLoai === 'GIA_CONG') {
    const version = await wf.getActiveVersion();
    if (!version) throw new AppError('Chưa cấu hình workflow', { status: 500, errorCode: 'NO_WORKFLOW' });
    const created = await withTransaction(async (client) => {
      const out = [];
      for (const { dvId, qty } of plan) {
        const c = await createGiaCongLenh(client, {
          versionId: version.id, chuyenId, junctions: [{ dotVaiId: dvId, soLuong: qty }], tongSL: qty, ngayKeHoach,
        }, actorId);
        out.push({ ...c, dot_vai_id: dvId });
      }
      return out;
    });
    await qaRepo.resolveReturnsMany('TEST_RUN', created.map((c) => c.dot_vai_id));
    created.forEach((c) => sockets.emit('workflow:updated', { lenhId: c.id, stage: 'GIA_CONG', giaCong: true }));
    sockets.emit('dashboard:refresh', {});
    const detail = await getLenhDetail(created[0].id);
    return {
      ...detail, created_summary: created, created_count: created.length,
      gia_cong: true, skipped_test_count: created.length,
    };
  }

  // ĐI TẮT TEST RUN (nhất quán createDotSanXuat / CLAUDE.md §5): bỏ Test Run khi
  //   (phần in ĐANG IN TEM trên chuyền — phiếu DANG_CHAY) HOẶC (SL release của lệnh < 100),
  //   TRỪ đợt bật cờ LÀM LẠI (can_lam_lai_ready → ép full flow).
  // KHÔNG còn bỏ Test Run chỉ vì "cùng phần in đã test xong ở đợt trước" — đợt MỚI vẫn phải Test Run.
  const { version } = await loadTestConfig();
  const compose = await repo.getDotVaiForCompose(plan.map((p) => p.dvId));
  const cById = Object.fromEntries(compose.map((r) => [r.id, r]));
  const dangChaySet = new Set(await repo.phanInDangChay([...new Set(compose.map((r) => r.phan_in_id))]));

  const created = await withTransaction(async (client) => {
    const out = [];
    for (const { dvId, qty } of plan) {
      const dv = cById[dvId];
      const dangChay = dv ? dangChaySet.has(dv.phan_in_id) : false;
      const diTat = (dangChay || qty < SL_NHO_BO_TEST) && !dv?.can_lam_lai_ready;
      const trangThai = diTat ? 'RELEASE_2' : 'RELEASE_1';
      const maLenh = await repo.nextMaLenhTx(client);
      const id = await repo.createLenh(client, {
        versionId: version.id, maLenh, chuyenId, soLuongRelease: qty, ngayKeHoach, trangThai,
        tgBdKh: tgBdKh || null, tgKtKh: tgKtKh || null,
      }, actorId);
      await repo.addLenhDotVai(client, id, dvId, actorId, qty);
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
    ke_hoach_tam_count: tamCount,
    skipped_test_count: created.filter((c) => c.trang_thai === 'RELEASE_2').length,
  };
}

// ----- TẠO ĐỢT SẢN XUẤT (mig 052) — gộp/tách nhiều đợt vải vào 1 đợt SX với SL TỪNG đợt -----
// items: [{ dotVaiId, soLuong }]. Tạo 1 lenh_san_xuat + N junction (so_luong). Chỉ gộp CÙNG MÀU.
async function createDotSanXuat({ items, chuyenId, ngayKeHoach, tgBdKh, tgKtKh }, actorId) {
  if (!chuyenId) throw new AppError('Chọn chuyền sản xuất', { status: 422, errorCode: 'NO_CHUYEN' });
  const plan = (Array.isArray(items) ? items : [])
    .map((i) => ({ dotVaiId: i.dotVaiId, soLuong: Number(i.soLuong) }))
    .filter((i) => i.dotVaiId && i.soLuong > 0);
  if (plan.length === 0) throw new AppError('Chọn ít nhất một đợt vải và nhập số lượng > 0', { status: 422, errorCode: 'NO_ITEM' });

  const ids = plan.map((p) => p.dotVaiId);
  const info = await repo.getDotVaiForCompose(ids);
  const byId = Object.fromEntries(info.map((r) => [r.id, r]));

  // CHỈ gộp các đợt vải CÙNG PHẦN IN (code phần) vào 1 đợt SX. Muốn gom nhiều phần in cùng màu → dùng Gom set (READY).
  const pins = new Set();
  for (const p of plan) {
    const d = byId[p.dotVaiId];
    if (!d) throw new AppError('Đợt vải không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
    if (p.soLuong > d.con_dua) {
      throw new AppError(`SL đưa vào của đợt ${d.ma_dot_vai} (${p.soLuong}) vượt SL còn lại (${d.con_dua})`,
        { status: 422, errorCode: 'OVER' });
    }
    pins.add(d.phan_in_id);
  }
  if (pins.size > 1) throw new AppError('Chỉ gộp các đợt vải CÙNG PHẦN IN (code phần) vào một đợt sản xuất. Muốn gom nhiều phần in cùng màu → dùng Gom set ở READY.', { status: 422, errorCode: 'MIXED_PHAN_IN' });

  // KẾ HOẠCH TẠM (mig 058): phần in CHƯA QC (Ready chưa xong) → lưu kế hoạch tạm (chuyền/giờ/ngày), chưa tạo lệnh.
  // (createDotSanXuat chỉ 1 phần in nên qc_done đồng nhất cho cả giỏ.)
  if (!plan.every((p) => byId[p.dotVaiId]?.qc_done)) {
    for (const p of plan) {
      await repo.upsertKeHoachTam({
        dotVaiId: p.dotVaiId, phanInId: byId[p.dotVaiId]?.phan_in_id, chuyenId, ngayKeHoach,
        tgBdKh: tgBdKh || null, tgKtKh: tgKtKh || null, soLuong: p.soLuong,
      }, actorId);
    }
    sockets.emit('dashboard:refresh', {});
    return { chi_tam: true, ke_hoach_tam_count: plan.length, so_luong_release: 0 };
  }

  const tongSL = plan.reduce((s, p) => s + p.soLuong, 0);

  // GIA CÔNG (chuyền loại GIA_CONG): gộp mọi đợt vào 1 lệnh ĐẬU Ở MÀN "GIA CÔNG" (trang_thai='GIA_CONG'),
  // chưa qua OQC. Kế hoạch bấm "Chuyển OQC" mới tạo tem + sang OQC (bỏ Test Run/SX/KCS...).
  const chuyenLoaiDsx = await repo.getChuyenLoai(chuyenId);
  if (chuyenLoaiDsx === 'GIA_CONG') {
    const version = await wf.getActiveVersion();
    const gc = await withTransaction(async (client) => createGiaCongLenh(client, {
      versionId: version.id, chuyenId, junctions: plan.map((p) => ({ dotVaiId: p.dotVaiId, soLuong: p.soLuong })),
      tongSL, ngayKeHoach, tgBdKh, tgKtKh,
    }, actorId));
    await qaRepo.resolveReturnsMany('TEST_RUN', ids);
    sockets.emit('workflow:updated', { lenhId: gc.id, stage: 'GIA_CONG', giaCong: true });
    sockets.emit('dashboard:refresh', {});
    return { ...(await getLenhDetail(gc.id)), gia_cong: true, so_luong_release: tongSL };
  }

  // ĐI TẮT TEST RUN (điểm 5): bỏ Test Run khi (phần in ĐANG IN TEM) HOẶC (tổng SL < 100),
  // TRỪ khi có đợt bật cờ LÀM LẠI (đổi HSKT → ép full flow).
  const phanInIds = [...new Set(info.map((r) => r.phan_in_id))];
  const dangChaySet = new Set(await repo.phanInDangChay(phanInIds));
  const dangChay = phanInIds.some((pid) => dangChaySet.has(pid));
  const slNho = tongSL < SL_NHO_BO_TEST;
  const lamLai = plan.some((p) => byId[p.dotVaiId]?.can_lam_lai_ready);
  const diTat = (dangChay || slNho) && !lamLai;
  const trangThai = diTat ? 'RELEASE_2' : 'RELEASE_1';

  // IN KIẾNG (điểm 16): phần in in kiếng → tạo THÊM đợt SX ép ủi (giai_doan EP_UI) ở holding CHO_IN_XONG,
  // liên kết về đợt IN; kích hoạt sang "chờ chạy" khi đợt IN "Chạy hoàn tất" (production.finishRun).
  const inKieng = plan.some((p) => byId[p.dotVaiId]?.la_in_kieng);
  const version = await wf.getActiveVersion();
  const { lenhId, epUiId } = await withTransaction(async (client) => {
    const maLenh = await repo.nextMaLenhTx(client);
    const id = await repo.createLenh(client, {
      versionId: version.id, maLenh, chuyenId, soLuongRelease: tongSL, ngayKeHoach, trangThai, giaiDoan: 'IN',
      tgBdKh: tgBdKh || null, tgKtKh: tgKtKh || null,
    }, actorId);
    for (const p of plan) await repo.addLenhDotVai(client, id, p.dotVaiId, actorId, p.soLuong);
    let ep = null;
    if (inKieng) {
      const maEp = await repo.nextMaLenhTx(client);
      ep = await repo.createLenh(client, {
        versionId: version.id, maLenh: maEp, chuyenId, soLuongRelease: tongSL, ngayKeHoach,
        trangThai: 'CHO_IN_XONG', giaiDoan: 'EP_UI', lenhLienKetId: id,
      }, actorId);
      // Ép ủi = pass thứ 2 trên CÙNG vải, chỉ liên kết qua lenh_lien_ket_id — KHÔNG gắn junction đợt vải
      // (tránh đợt có 2 lệnh non-HUY làm lệch con_dua / suy giai đoạn). Đợt tra qua lệnh IN liên kết.
    }
    return { lenhId: id, epUiId: ep };
  });

  await tracking.moveDotVaiTo(ids, trangThai === 'RELEASE_2' ? 'RELEASE_2' : 'RELEASE_1', actorId);
  await qaRepo.resolveReturnsMany('TEST_RUN', ids); // release lại → tắt cờ "bị Test Run trả về"
  sockets.emit('workflow:updated', { lenhId, stage: trangThai });
  sockets.emit('dashboard:refresh', {});
  return { ...(await getLenhDetail(lenhId)), skipped_test: diTat, so_luong_release: tongSL, in_kieng: inKieng, ep_ui_id: epUiId };
}

// Lịch sử Release 1 = lệnh đã tạo trong ngày + CÁC THAO TÁC KẾ HOẠCH TẠM (lập/sửa/xóa/xác nhận).
// Gộp 2 nguồn vì đứng ở màn Release 1 sẽ KHÔNG thấy đợt vải đã có kế hoạch tạm (candidate loại chúng ra)
// ⇒ không gộp thì không ai biết đợt đó "biến mất" là do có người lập kế hoạch sớm.
async function release1History(date) {
  const [rows, kht] = await Promise.all([
    repo.release1HistoryByDate(date),
    repo.keHoachTamHistoryByDate(date),
  ]);
  const lenh = rows.map((r) => ({
    tg: r.tg,
    nguoi: r.nguoi || '—',
    hanh_dong: 'Release 1',
    doi_tuong: r.ma_lenh || '',
    chi_tiet: [r.ma_phan, r.mau_vai, r.ma_dot_vai].filter(Boolean).join(' · ')
      + (r.ten_chuyen ? ` → ${r.ten_chuyen}` : ''),
  }));
  const tam = kht.map((r) => ({
    tg: r.tg,
    nguoi: r.nguoi || '—',
    hanh_dong: KHT_LABEL[r.hanh_dong] || r.hanh_dong,
    doi_tuong: r.ma_lenh || r.ma_phan || '',
    chi_tiet: khtChiTiet(r),
  }));
  return [...lenh, ...tam].sort((a, b) => new Date(b.tg) - new Date(a.tg));
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
  // ⚠ GIA CÔNG: release SET lên chuyền loại `GIA_CONG` phải ra lệnh `trang_thai='GIA_CONG'` để ĐẬU Ở
  // màn Kế hoạch > Gia công — giống hệt đường release ĐỢT LẺ (`createRelease1`). Thiếu nhánh này thì
  // lệnh ra 'RELEASE_1' và hàng gia công của gom set KHÔNG BAO GIỜ hiện ở trang Gia công (lỗi 04/08/2026).
  const laGiaCong = (await repo.getChuyenLoai(chuyenId)) === 'GIA_CONG';

  const lenhId = await withTransaction(async (client) => {
    const maLenh = await repo.nextMaLenhTx(client);
    const id = await repo.createLenh(client, {
      versionId: version.id, maLenh, chuyenId, soLuongRelease: soLuong, ngayKeHoach,
      trangThai: laGiaCong ? 'GIA_CONG' : 'RELEASE_1',
    }, actorId);
    // Gom set = mỗi đợt vào trọn SL vải về (all-or-nothing) → so_luong junction = SL đợt.
    for (const m of members) await repo.addLenhDotVai(client, id, m.dot_vai_id, actorId, m.so_luong);
    await repo.markSetReleased(client, setId, id, actorId);
    await repo.logGomSetReleased(client, setId, `Release set ${set.ma_set} → lệnh ${maLenh} (${dotVaiIds.length} đợt vải)`, actorId);
    return id;
  });

  // ⚠ DỌN KẾ HOẠCH TẠM của MỌI đợt trong set — release set là một đường release THẬT, đợt vải đã có
  // lệnh nên dòng kế hoạch tạm không còn nghĩa. Thiếu bước này thì các dòng đó ở lại màn "Kế hoạch tạm"
  // (danh sách set KHÔNG lọc `ke_hoach_tam` như `listRelease1Candidates`), bấm "Xác nhận Release 1"
  // sẽ báo `SL release (N) vượt SL còn lại (0)` — lỗi đã gặp thật 04/08/2026 (16 dòng / 6 set).
  await repo.deleteKeHoachTamByDotVai(dotVaiIds);
  // Gia công KHÔNG đi Release 1 → không ghi tracking RELEASE_1 (giống nhánh gia công ở `createRelease1`).
  if (!laGiaCong) await tracking.moveDotVaiTo(dotVaiIds, 'RELEASE_1', actorId); // theo dõi dòng chảy (cả set)
  await qaRepo.resolveReturnsMany('TEST_RUN', dotVaiIds); // release lại → tắt cờ "bị Test Run trả về"
  sockets.emit('workflow:updated', {
    lenhId, stage: laGiaCong ? 'GIA_CONG' : 'RELEASE_1', fromSet: setId, giaCong: laGiaCong || undefined,
  });
  sockets.emit('dashboard:refresh', {});
  return getLenhDetail(lenhId);
}

// ----- TEST RUN -----
async function listTestRunCandidates({ search, page, limit, offset }) {
  const { byMa } = await loadTestConfig();
  const rows = await repo.listTestRunCandidates({ cnspId: byMa[CNSP_CP].id, qaId: byMa[QA_CP].id, search, offset, limit });
  // Lệnh đang CHỜ KỸ THUẬT (đã bị QA trả về READY, `cho_ky_thuat` từ repo): gắn lý do + mục rớt để FE
  // hiện badge "Chờ kỹ thuật làm lại". Lấy theo đợt vải của lệnh (qc_tra_ve loai='TEST_RUN').
  const choKt = rows.filter((r) => r.cho_ky_thuat);
  if (choKt.length) {
    const perLenh = await Promise.all(choKt.map((r) => tracking.dotVaiFromLenh(r.id)));
    const allDv = [...new Set(perLenh.flat())];
    const rm = await qaRepo.activeReturnsMap('TEST_RUN', allDv);
    choKt.forEach((r, i) => { r.tra_ve = (perLenh[i] || []).map((id) => rm[id]).find(Boolean) || null; });
  }
  return { items: rows, meta: buildMeta(page, limit, rows.length) };
}

async function getLenhDetail(lenhId) {
  const { byMa } = await loadTestConfig();
  const lenh = await repo.getLenhBasic(lenhId);
  if (!lenh) throw new AppError('Lệnh sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const [dotVai, testRuns, status, kt] = await Promise.all([
    repo.getLenhDotVai(lenhId),
    repo.getTestRuns(lenhId),
    repo.getLenhTestStatus(lenhId, byMa[CNSP_CP].id, byMa[QA_CP].id),
    repo.lenhChoKyThuat(lenhId), // đã bị QA trả về READY → panel khóa thao tác test
  ]);
  return {
    lenh: { ...lenh, cho_ky_thuat: kt ? kt.cho_ky_thuat === true : false },
    dot_vai: dotVai, test_runs: testRuns, state: status,
  };
}

async function recordTestRun(lenhId, body, actorId) {
  await repo.getLenhBasic(lenhId);
  await assertKhongChoKyThuat(lenhId);
  await repo.insertTestRun(lenhId, body, actorId);
  sockets.emit('workflow:updated', { lenhId, stage: 'TEST_RUN' });
  return getLenhDetail(lenhId);
}

async function confirmTest(lenhId, which, actorId, extra = {}) {
  const { byMa } = await loadTestConfig();
  const lenh = await repo.getLenhBasic(lenhId);
  if (!lenh) throw new AppError('Đợt sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (lenh.trang_thai !== 'RELEASE_1') {
    throw new AppError('Đợt không ở trạng thái Test Run', { status: 409, errorCode: 'WRONG_STAGE' });
  }
  await assertKhongChoKyThuat(lenhId); // đã bị QA trả về READY → chờ kỹ thuật/QC làm lại xong mới test
  const datId = await wf.getTrangThaiId('DAT');

  if (which === 'qa') {
    // GỘP TEST RUN VỀ QA (điểm 11): 1 thao tác QA ghi CẢ TEST_CNSP (người test) + TEST_QA (loại + ghi chú).
    const st = await repo.getLenhTestStatus(lenhId, byMa[CNSP_CP].id, byMa[QA_CP].id);
    const recordPass = !st.qa_done;
    const nguoiTest = (extra.nguoiTest || '').toString().trim() || null;
    // Bắt buộc nhập người test khi QA xác nhận đạt (không cho xác nhận "trống tên").
    if (!nguoiTest) throw new AppError('Bắt buộc nhập người test khi QA xác nhận đạt', { status: 422, errorCode: 'NGUOI_TEST_REQUIRED' });
    const loaiTest = extra.loaiTest === 'DAP_PHAN' ? 'DAP_PHAN' : 'TEST_RUN';
    const ghiChu = (extra.ghiChu || '').toString().trim() || null;
    await withTransaction(async (client) => {
      const kqCnsp = await repo.upsertLenhResult(client, {
        lenhId, checkpointId: byMa[CNSP_CP].id, trangThai: 'DAT', giaTriText: nguoiTest, nguoiXacNhanId: actorId, actorId,
      });
      await repo.insertStatusLog(client, { ketQuaId: kqCnsp, trangThaiMoiId: datId, nguoiId: actorId, lyDo: `CNSP (người test: ${nguoiTest || '—'})` });
      const kqQa = await repo.upsertLenhResult(client, {
        lenhId, checkpointId: byMa[QA_CP].id, trangThai: 'DAT', giaTriText: loaiTest, ghiChu, nguoiXacNhanId: actorId, actorId,
      });
      await repo.insertStatusLog(client, { ketQuaId: kqQa, trangThaiMoiId: datId, nguoiId: actorId, lyDo: `QA xác nhận test (${loaiTest})` });
      if (recordPass) {
        await repo.insertTestRunTx(client, lenhId, { soLuong: extra.soLuong ?? null, ketQua: 'DAT', ghiChu }, actorId);
      }
    });
  } else {
    // CNSP (giữ tương thích — màn UI CNSP đã gỡ; QA đã ghi thay CNSP).
    await withTransaction(async (client) => {
      const kqId = await repo.upsertLenhResult(client, {
        lenhId, checkpointId: byMa[CNSP_CP].id, trangThai: 'DAT', nguoiXacNhanId: actorId, actorId,
      });
      await repo.insertStatusLog(client, { ketQuaId: kqId, trangThaiMoiId: datId, nguoiId: actorId, lyDo: `${CNSP_CP} xác nhận test` });
    });
  }
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

// Xác nhận test hàng loạt (CNSP hoặc QA) cho nhiều lệnh. `extra` (người test/loại/ghi chú) áp cho cả lô khi QA.
async function confirmTestBatch(lenhIds, which, actorId, extra = {}) {
  if (!Array.isArray(lenhIds) || lenhIds.length === 0) {
    throw new AppError('Chọn ít nhất một lệnh', { status: 422, errorCode: 'NO_LENH' });
  }
  // QA đạt bắt buộc có người test (áp chung cho cả lô).
  if (which === 'qa' && !(extra.nguoiTest || '').toString().trim()) {
    throw new AppError('Bắt buộc nhập người test khi QA xác nhận đạt', { status: 422, errorCode: 'NGUOI_TEST_REQUIRED' });
  }
  let okCount = 0;
  const errors = [];
  for (const id of lenhIds) {
    try {
      await confirmTest(id, which, actorId, extra);
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

// "Không test run": bỏ Test Run cho 1 đợt SX (lệnh RELEASE_1) → duyệt thẳng RELEASE_2 (vào chờ sản xuất).
async function skipTestRun(lenhId, actorId) {
  const lenh = await repo.getLenhBasic(lenhId);
  if (!lenh) throw new AppError('Đợt sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (lenh.trang_thai === 'RELEASE_2') throw new AppError('Đợt đã ở Release 2 (chờ sản xuất)', { status: 409, errorCode: 'ALREADY' });
  if (lenh.trang_thai !== 'RELEASE_1') throw new AppError('Chỉ bỏ Test Run khi đợt đang ở Test Run', { status: 409, errorCode: 'WRONG_STAGE' });
  await assertKhongChoKyThuat(lenhId);
  await withTransaction(async (client) => {
    await repo.setLenhTrangThai(client, lenhId, 'RELEASE_2', actorId);
    await repo.logPlanChange(client, lenhId, 'RELEASE_2',
      { trang_thai: 'RELEASE_1' },
      { trang_thai: 'RELEASE_2', bo_test_run: true },
      actorId);
  });
  await tracking.moveByLenh(lenhId, 'RELEASE_2', actorId);
  sockets.emit('workflow:updated', { lenhId, stage: 'RELEASE_2', skipTest: true });
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
async function listCancelableLenh({ search, page, limit, offset, moRong }) {
  const { rows, total } = await repo.listCancelableLenh({ search, offset, limit, moRong });
  return { items: rows, meta: buildMeta(page, limit, total) };
}

// Hoàn tác chuyển trạm 1 lệnh về checkpoint đích (pre-production):
//  - TEST_RUN : chỉ bỏ duyệt Release 2 (RELEASE_2 → RELEASE_1); đợt vải vẫn ở Test Run.
//  - RELEASE_1: hủy lệnh → đợt vải về "chờ release" (Release 1 candidate), giữ QC.
//  - READY    : hủy lệnh + hủy QC ready → phần in về màn READY (làm lại từ kỹ thuật/QC).
// `force` = HỦY TÙY CHỌN (chỉ bật khi user có quyền `LENH_CANCEL_ANY` — controller kiểm, service
// KHÔNG tự tin FE). Bỏ giới hạn trạng thái + cho hủy cả lệnh đã in tem: tem/phiếu của lệnh bị HỦY kèm.
// ⚠ VẪN CHẶN khi tem đã đi tiếp (KCS/Sửa/OQC/giao) — hủy lúc đó làm hỏng SỔ CÁI SỐ LƯỢNG (§11.4);
// muốn gỡ thì đảo từng công đoạn ở tab "Hủy xác nhận KCS/Sửa/OQC" trước.
async function rollbackLenh(lenhId, { target, lyDo, force = false }, actorId) {
  const TARGET = ['READY', 'RELEASE_1', 'TEST_RUN'].includes(target) ? target : 'RELEASE_1';
  const lenh = await repo.getLenhForCancel(lenhId);
  if (!lenh) throw new AppError('Lệnh sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (lenh.trang_thai === 'HUY') throw new AppError('Lệnh đã hủy', { status: 409, errorCode: 'ALREADY' });
  // GIA_CONG = lệnh gia công còn đậu ở màn Kế hoạch > Gia công (chưa "Chuyển OQC" nên chưa có phiếu/tem)
  // ⇒ hoàn tác được như Release 1/2 (đích hợp lệ: RELEASE_1 / READY — không có Test Run).
  if (!force && !['RELEASE_1', 'RELEASE_2', 'GIA_CONG'].includes(lenh.trang_thai)) {
    throw new AppError('Chỉ hoàn tác lệnh đang ở Release 1 / Release 2 / Gia công (chưa vào sản xuất)', { status: 409, errorCode: 'WRONG_STAGE' });
  }
  if (!force && lenh.co_phieu) {
    throw new AppError('Lệnh đã bắt đầu sản xuất (đã in tem) — không thể hoàn tác tự động', { status: 409, errorCode: 'HAS_PHIEU' });
  }
  if (force) {
    if (!String(lyDo || '').trim()) {
      throw new AppError('Hủy tùy chọn phải nhập lý do', { status: 422, errorCode: 'NO_LY_DO' });
    }
    if (lenh.tem_da_xu_ly) {
      throw new AppError(
        'Lệnh có tem đã qua KCS/Sửa/OQC hoặc đã giao — hủy sẽ làm sai sổ cái số lượng. '
        + 'Hãy hủy xác nhận từng công đoạn ở các tab KCS/Sửa/OQC trước.',
        { status: 409, errorCode: 'TEM_DA_XU_LY' });
    }
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
    // Hủy tùy chọn trên lệnh ĐÃ IN TEM: dọn tem + phiếu TRƯỚC (tem chưa đi tiếp nên sổ cái toàn 0,
    // không phải đảo gì) rồi mới hủy lệnh — cùng 1 transaction để không áp dụng nửa vời.
    if (force && lenh.co_phieu) await repo.cancelPhieuTemByLenhTx(client, lenhId, actorId);
    await repo.cancelLenhOrder(client, lenhId, actorId);
    if (TARGET === 'READY') await repo.cancelReadyQcForDotVai(client, dotVaiIds, actorId);
  });
  const ghiChu = force
    ? `[${TARGET}] (HỦY TÙY CHỌN từ ${lenh.trang_thai}${lenh.so_tem ? `, hủy ${lenh.so_tem} tem` : ''}) ${lyDo || ''}`.trim()
    : `[${TARGET}] ${lyDo || ''}`.trim();
  await repo.logLenhCancel(lenhId, lenh.ma_lenh_san_xuat, ghiChu, actorId);
  await tracking.revertToReady(dotVaiIds, actorId);
  sockets.emit('workflow:updated', { lenhId, stage: 'HUY' });
  sockets.emit('dashboard:refresh', {});
  return {
    id: lenhId, target: TARGET, dot_vai: dotVaiIds.length, tu_set: lenh.tu_set === true,
    force: !!force, trang_thai_cu: lenh.trang_thai, so_tem_huy: force ? (lenh.so_tem || 0) : 0,
  };
}

// ─── TEST RUN KHÔNG ĐẠT → TRẢ VỀ KỸ THUẬT (READY) ────────────────────────────
// QA chọn mục rớt (Khuôn/Film/Mực) → đúng mục đó phải xác nhận lại; QC xác nhận xong thì đợt vải
// nhảy THẲNG về Test Run (technical.confirmQC), Kế hoạch KHÔNG phải Release 1 lại.
// ⇒ Vì vậy **GIỮ NGUYÊN lệnh** (khác `rollbackLenh` — hàm đó hủy lệnh, đợt vải rơi về pool Release 1).
const TECH_ITEMS = ['KHUON', 'FILM', 'MUC'];

// Chuẩn hóa mục rớt + LUẬT LAN TRUYỀN: làm lại FILM ⇒ phải chụp lại KHUÔN (không ngược lại).
// Đặt ở service để gọi API trực tiếp cũng không lách được.
function normalizeTechItems(checklists) {
  const set = new Set((Array.isArray(checklists) ? checklists : [])
    .map((m) => String(m || '').trim().toUpperCase())
    .filter((m) => TECH_ITEMS.includes(m)));
  if (set.has('FILM')) set.add('KHUON');
  return TECH_ITEMS.filter((m) => set.has(m)); // giữ thứ tự Khuôn → Film → Mực
}

async function returnTestRunToReady(lenhId, { checklists, lyDo }, actorId) {
  const reason = (lyDo || '').trim();
  if (!reason) throw new AppError('Nhập lý do trả về Kỹ thuật', { status: 422, errorCode: 'NO_LY_DO' });
  const chosen = normalizeTechItems(checklists);
  if (chosen.length === 0) {
    throw new AppError('Chọn ít nhất 1 mục không đạt (Khuôn / Film / Mực)', { status: 422, errorCode: 'NO_ITEM' });
  }
  const lenh = await repo.getLenhBasic(lenhId);
  if (!lenh) throw new AppError('Lệnh sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (lenh.trang_thai !== 'RELEASE_1') {
    throw new AppError('Chỉ trả về Kỹ thuật khi lệnh đang ở Test Run', { status: 409, errorCode: 'WRONG_STAGE' });
  }
  const info = await repo.lenhChoKyThuat(lenhId);
  if (info && info.co_phieu) {
    throw new AppError('Lệnh đã bắt đầu sản xuất (đã in tem) — không trả về Kỹ thuật được', { status: 409, errorCode: 'HAS_PHIEU' });
  }
  const dotVaiIds = await tracking.dotVaiFromLenh(lenhId);
  const pinIds = await repo.phanInIdsByLenh(lenhId);

  await withTransaction(async (client) => {
    await repo.cancelTestResults(client, lenhId, actorId);                        // phải test lại
    await repo.cancelReadyItemsByPhanIn(client, pinIds, chosen, actorId);         // mục rớt → xác nhận lại
    await repo.cancelReadyQcForDotVai(client, dotVaiIds, actorId);                // QC phải duyệt lại
  });

  const checklistList = chosen.join(',');
  // 2 loại: TEST_RUN_KT (mức phần in) → badge ở READY/QC READY · TEST_RUN (mức đợt vải) → Lịch sử QC trả về
  // + badge "Chờ kỹ thuật làm lại" ở màn Test Run.
  for (const pinId of pinIds) {
    await qaRepo.insertQcTraVe({ loai: 'TEST_RUN_KT', phanInId: pinId, lenhId, checklistList, lyDo: reason }, actorId);
  }
  for (const dvId of dotVaiIds) {
    await qaRepo.insertQcTraVe({ loai: 'TEST_RUN', dotVaiId: dvId, lenhId, checklistList, lyDo: reason }, actorId);
  }
  await repo.logPlanChange(null, lenhId, 'TRA_VE_KY_THUAT_TEST_RUN',
    { trang_thai: 'RELEASE_1' },
    { ma_lenh: lenh.ma_lenh_san_xuat, checklists: chosen, ly_do: reason, giu_lenh: true }, actorId);
  await tracking.moveDotVaiTo(dotVaiIds, 'READY', actorId);
  sockets.emit('workflow:updated', { lenhId, stage: 'READY', traVe: true });
  sockets.emit('dashboard:refresh', {});
  return { lenh_id: lenhId, dot_vai: dotVaiIds.length, phan_in: pinIds.length, checklists: chosen };
}

// Chặn mọi thao tác test khi lệnh đang chờ kỹ thuật làm lại (đã bị QA trả về READY).
async function assertKhongChoKyThuat(lenhId) {
  const info = await repo.lenhChoKyThuat(lenhId);
  if (info && info.cho_ky_thuat) {
    throw new AppError('Lệnh đang chờ kỹ thuật làm lại (READY) — chưa test được',
      { status: 409, errorCode: 'CHO_KY_THUAT' });
  }
}

// ----- LẬP KẾ HOẠCH LẠI -----
async function listReplanCandidates({ search, page, limit, offset }) {
  const { rows, total } = await repo.listReplanCandidates({ search, offset, limit });
  return { items: rows, meta: buildMeta(page, limit, total) };
}

// ----- KẾ HOẠCH TẠM (mig 058): màn Kế hoạch xác nhận lại Release 1 khi phần in Ready xong -----
async function listKeHoachTam({ search, page, limit, offset }) {
  const { rows, total } = await repo.listKeHoachTamRows({ search, offset, limit });
  return { items: rows, meta: buildMeta(page, limit, total) };
}

// KẾ HOẠCH TẠM CHO CẢ GOM SET: set chưa đủ QC thì KHÔNG release được (phải in chung 1 lệnh), nhưng
// VẪN phải lập kế hoạch sớm được. Ở đây chỉ ghi kế hoạch tạm cho MỌI đợt vải trong set — không tạo lệnh,
// không đụng tới set. Khi cả set Ready xong, xác nhận ở màn Kế hoạch tạm sẽ release nguyên set thành 1 lệnh.
async function keHoachTamSet(setId, { chuyenId, ngayKeHoach, tgBdKh, tgKtKh }, actorId) {
  if (!chuyenId) throw new AppError('Chọn chuyền sản xuất', { status: 422, errorCode: 'NO_CHUYEN' });
  const set = await repo.getSetForRelease(setId);
  if (!set) throw new AppError('Set không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (set.trang_thai !== 'MO') throw new AppError('Set không ở trạng thái mở', { status: 409, errorCode: 'NOT_OPEN' });
  const members = await repo.getSetMembersForRelease(setId);
  if (members.length === 0) throw new AppError('Set chưa có đợt vải', { status: 422, errorCode: 'EMPTY' });
  if (members.some((m) => m.da_release)) {
    throw new AppError('Có đợt vải trong set đã được release', { status: 409, errorCode: 'ALREADY_RELEASED' });
  }
  for (const m of members) {
    await repo.upsertKeHoachTam({
      dotVaiId: m.dot_vai_id, phanInId: m.phan_in_id, chuyenId, ngayKeHoach,
      tgBdKh: tgBdKh || null, tgKtKh: tgKtKh || null, soLuong: m.so_luong,
    }, actorId);
  }
  sockets.emit('dashboard:refresh', {});
  return { set_id: setId, ma_set: set.ma_set, ke_hoach_tam_count: members.length, chi_tam: true };
}

async function confirmKeHoachTam(id, actorId) {
  const kt = await repo.getKeHoachTam(id);
  if (!kt) throw new AppError('Kế hoạch tạm không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (!kt.qc_done) throw new AppError('Phần in chưa Ready xong (chưa có xác nhận QA) — chưa thể Release 1', { status: 409, errorCode: 'NOT_READY' });

  // Đợt thuộc GOM SET đang mở → phải release CẢ SET thành 1 lệnh chung (không tách lẻ từng đợt).
  const gs = await repo.getOpenSetOfDotVai(kt.dot_vai_ve_id);
  if (gs) {
    if (gs.so_chua_ready > 0) {
      throw new AppError(`Đợt vải thuộc ${gs.ma_set} — còn ${gs.so_chua_ready} đợt trong set chưa Ready, phải chờ cả set xong mới release chung`,
        { status: 409, errorCode: 'SET_NOT_READY' });
    }
    // Lấy danh sách đợt TRƯỚC khi release (sau khi release set đổi trạng thái, khó truy lại).
    const members = await repo.getSetMembersForRelease(gs.id);
    const ids = members.length ? members.map((m) => m.dot_vai_id) : [kt.dot_vai_ve_id];
    const res = await releaseSet(gs.id, {
      chuyenId: kt.chuyen_id, ngayKeHoach: kt.ngay_ke_hoach,
    }, actorId);
    await repo.deleteKeHoachTamByDotVai(ids);
    await repo.logKeHoachTam('XAC_NHAN_KE_HOACH_TAM', kt.dot_vai_ve_id, {
      chuyen_id: kt.chuyen_id, ngay_ke_hoach: kt.ngay_ke_hoach, so_luong: kt.so_luong,
      ma_set: gs.ma_set, ma_lenh: (res && (res.ma_lenh_san_xuat || res.lenh?.ma_lenh_san_xuat)) || null,
    }, actorId);
    return { ...res, ke_hoach_tam_id: id, ma_set: gs.ma_set };
  }
  // Đợt ĐÃ được release ở đường khác (điển hình: release theo GOM SET từ màn Release 1) mà dòng kế hoạch
  // tạm còn sót → `createRelease1` sẽ ném "SL release (N) vượt SL còn lại (0)", người dùng không hiểu gì.
  // Dọn dòng chết rồi trả `da_don` — CỐ Ý KHÔNG ném lỗi: đây không phải người dùng làm sai, và ném lỗi
  // thì xác nhận hàng loạt đếm thành "N lỗi" (toast đỏ) dù dòng đã được dọn xong.
  // (Nguyên nhân gốc đã vá ở `releaseSet`; nhánh này để tự lành dữ liệu cũ.)
  const [con] = await repo.getDotVaiRemaining([kt.dot_vai_ve_id]);
  if (!con || con.con_release <= 0) {
    const l = await repo.lenhMoiNhatCuaDotVai(kt.dot_vai_ve_id);
    await repo.deleteKeHoachTam(id);
    return {
      ke_hoach_tam_id: id, da_don: true, ma_lenh: (l && l.ma_lenh_san_xuat) || null,
      created_count: 0, created_summary: [],
    };
  }

  // Tái dùng createRelease1 với chuyền/giờ/ngày đã lưu (giờ phần in đã QC → đi đường release thật).
  const res = await createRelease1({
    dotVaiIds: [kt.dot_vai_ve_id], chuyenId: kt.chuyen_id,
    soLuongRelease: kt.so_luong != null ? kt.so_luong : undefined,
    ngayKeHoach: kt.ngay_ke_hoach, tgBdKh: kt.tg_bd_kh, tgKtKh: kt.tg_kt_kh,
  }, actorId);
  await repo.deleteKeHoachTam(id);
  await repo.logKeHoachTam('XAC_NHAN_KE_HOACH_TAM', kt.dot_vai_ve_id, {
    chuyen_id: kt.chuyen_id, ngay_ke_hoach: kt.ngay_ke_hoach, so_luong: kt.so_luong,
    ma_lenh: (res.created_summary && res.created_summary[0]?.ma_lenh_san_xuat) || res.ma_lenh_san_xuat || null,
  }, actorId);
  return { ...res, ke_hoach_tam_id: id };
}

async function updateKeHoachTam(id, { chuyenId, ngayKeHoach, soLuong }, actorId) {
  const kt = await repo.getKeHoachTam(id);
  if (!kt) throw new AppError('Kế hoạch tạm không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const sl = soLuong != null && soLuong !== '' ? Number(soLuong) : null;
  if (sl != null && !(sl > 0)) throw new AppError('Số lượng release phải lớn hơn 0', { status: 422, errorCode: 'INVALID_QTY' });
  const res = await repo.updateKeHoachTam(id, { chuyenId, ngayKeHoach, soLuong: sl }, actorId);
  if (!res) throw new AppError('Không cập nhật được kế hoạch tạm', { status: 409, errorCode: 'UPDATE_FAILED' });
  await repo.logKeHoachTam('SUA_KE_HOACH_TAM', kt.dot_vai_ve_id,
    { chuyen_id: chuyenId || null, ngay_ke_hoach: ngayKeHoach || null, so_luong: sl }, actorId);
  sockets.emit('dashboard:refresh', {});
  return { id };
}

async function deleteKeHoachTam(id, actorId) {
  const kt = await repo.getKeHoachTam(id);
  if (!kt) throw new AppError('Kế hoạch tạm không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  await repo.deleteKeHoachTam(id);
  await repo.logKeHoachTam('XOA_KE_HOACH_TAM', kt.dot_vai_ve_id,
    { chuyen_id: kt.chuyen_id, ngay_ke_hoach: kt.ngay_ke_hoach, so_luong: kt.so_luong }, actorId);
  return { id };
}

// Lịch sử thao tác Kế hoạch tạm theo ngày (nguồn audit_log — dòng tạm đã bị xóa khi lên lệnh).
const KHT_LABEL = {
  LUU_KE_HOACH_TAM: 'Lập kế hoạch tạm',
  SUA_KE_HOACH_TAM: 'Sửa kế hoạch tạm',
  XOA_KE_HOACH_TAM: 'Xóa kế hoạch tạm',
  XAC_NHAN_KE_HOACH_TAM: 'Xác nhận Release 1',
};
function khtChiTiet(r) {
  const parts = [[r.ma_phan, r.mau_vai, r.ma_dot_vai].filter(Boolean).join(' · ')];
  if (r.ten_chuyen) parts.push(`chuyền ${r.ten_chuyen}`);
  if (r.so_luong) parts.push(`SL ${r.so_luong}`);
  if (r.ngay_ke_hoach) parts.push(`ngày KH ${String(r.ngay_ke_hoach).slice(0, 10)}`);
  return parts.filter(Boolean).join(' · ');
}
async function keHoachTamHistory(date) {
  const rows = await repo.keHoachTamHistoryByDate(date);
  return rows.map((r) => ({
    tg: r.tg,
    nguoi: r.nguoi || '—',
    hanh_dong: KHT_LABEL[r.hanh_dong] || r.hanh_dong,
    doi_tuong: r.ma_lenh || r.ma_phan || '',
    chi_tiet: khtChiTiet(r),
  }));
}
async function keHoachTamDone(date) { return repo.keHoachTamDoneByDate(date); }

// ----- GIA CÔNG: màn Kế hoạch nhận lại hàng gia công rồi chuyển OQC -----
async function listGiaCong({ search, page, limit, offset }) {
  const { rows, total } = await repo.listGiaCongLenh({ search, offset, limit });
  // Gắn cờ "bị OQC trả về" (mức LỆNH — tem đã hủy khi trả nên cờ phải sống trên lệnh) để FE hiện badge đỏ
  // + biết lệnh đang CHỜ TRẢ LẠI nhà gia công (chưa bấm "Trả lại nhà gia công").
  const rm = await qaRepo.activeReturnsMap('OQC_GIA_CONG', rows.map((r) => r.id));
  const items = rows.map((r) => ({ ...r, tra_ve: rm[r.id] || null, cho_tra_lai: !!rm[r.id] }));
  return { items, meta: buildMeta(page, limit, total) };
}

// Kế hoạch đã mang hàng trả lại cho nhà gia công → tắt cờ trả về, lệnh về trạng thái "đang gia công"
// bình thường, chờ nhận về bằng nút "Nhận hàng → OQC".
async function traLaiNhaGiaCong(lenhId, { ghiChu } = {}, actorId) {
  const lenh = await repo.getGiaCongLenh(lenhId);
  if (!lenh) throw new AppError('Lệnh sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (lenh.trang_thai !== 'GIA_CONG') {
    throw new AppError('Lệnh không ở màn Gia công', { status: 409, errorCode: 'NOT_GIA_CONG' });
  }
  const rm = await qaRepo.activeReturnsMap('OQC_GIA_CONG', [lenhId]);
  if (!rm[lenhId]) {
    throw new AppError('Lệnh không có hàng bị OQC trả về', { status: 409, errorCode: 'KHONG_CO_TRA_VE' });
  }
  await repo.logGiaCongTraLai(lenhId, {
    ma_lenh: lenh.ma_lenh_san_xuat,
    con_lai: (Number(lenh.so_luong_release) || 0) - (Number(lenh.da_chuyen) || 0),
    ly_do_oqc: rm[lenhId].ly_do || null,
    ghi_chu: (ghiChu || '').trim() || null,
  }, actorId);
  await qaRepo.resolveReturns('OQC_GIA_CONG', lenhId);
  sockets.emit('workflow:updated', { lenhId, stage: 'GIA_CONG', giaCong: true });
  sockets.emit('dashboard:refresh', {});
  return { id: lenhId, ma_lenh: lenh.ma_lenh_san_xuat, cho_tra_lai: false };
}

// Lịch sử "hàng về" gia công đã chuyển OQC theo ngày (cho SidePanel + in tem TH VỀ).
async function giaCongHistory(date) {
  const d = date || new Date().toISOString().slice(0, 10);
  return repo.listGiaCongHistory(d);
}

// Kế hoạch xác nhận đã nhận lại hàng gia công → tạo phiếu HOAN_TAT + tem CHO_OQC (seed sl_kcs_dat = SL,
// coi như đã KCS đạt ⇒ con_oqc>0), rồi đưa dòng chảy sang OQC. Nguồn hiển thị = "Gia công".
// ⚠ HÀNG GIA CÔNG CÓ THỂ VỀ NHIỀU LẦN: mỗi lần nhận = 1 phiếu + 1 TEM RIÊNG mang SL của lần đó
// (OQC bốc mẫu từng tem độc lập, truy vết được lô nào về lúc nào). Lệnh CHỈ rời màn Gia công
// (→ HOAN_TAT + tracking sang OQC) khi Σ SL đã chuyển ĐỦ `so_luong_release`; chưa đủ thì vẫn đậu lại
// với phần "còn lại" để nhận tiếp. Bỏ trống `soLuong` = chuyển hết phần còn lại (hành vi cũ).
async function confirmGiaCongToOqc(lenhId, { soLuong } = {}, actorId) {
  const lenh = await repo.getGiaCongLenh(lenhId);
  if (!lenh) throw new AppError('Lệnh sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (lenh.trang_thai !== 'GIA_CONG') {
    throw new AppError('Lệnh không ở trạng thái chờ gia công (đã chuyển OQC?)', { status: 409, errorCode: 'NOT_GIA_CONG' });
  }
  // Đang chờ trả lại nhà gia công (hàng bị OQC đánh không đạt) thì CHƯA được nhận về lượt mới —
  // phải bấm "Trả lại nhà gia công" trước. Chặn ở BE vì nút hàng loạt/API có thể lách nút từng dòng.
  const rmGc = await qaRepo.activeReturnsMap('OQC_GIA_CONG', [lenhId]);
  if (rmGc[lenhId]) {
    throw new AppError('Lệnh đang chờ trả lại nhà gia công (OQC trả về) — bấm "Trả lại nhà gia công" trước',
      { status: 409, errorCode: 'CHO_TRA_LAI' });
  }
  const tong = Number(lenh.so_luong_release) || 0;
  const daChuyen = Number(lenh.da_chuyen) || 0;
  const conLai = tong - daChuyen;
  if (!(tong > 0)) throw new AppError('SL release của lệnh không hợp lệ', { status: 422, errorCode: 'INVALID_QTY' });
  if (!(conLai > 0)) {
    throw new AppError('Lệnh đã chuyển đủ số lượng xuống OQC', { status: 409, errorCode: 'DA_DU_SL' });
  }
  const qty = soLuong == null || soLuong === '' ? conLai : Math.trunc(Number(soLuong));
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new AppError('Số lượng nhận về phải lớn hơn 0', { status: 422, errorCode: 'INVALID_QTY' });
  }
  if (qty > conLai) {
    throw new AppError(`Số lượng nhận về (${qty}) vượt phần còn lại của lệnh (${conLai})`,
      { status: 422, errorCode: 'OVER_REMAINING' });
  }
  const xong = daChuyen + qty >= tong;

  const maTem = await withTransaction(async (client) => {
    const maPhieu = await productionRepo.nextMaPhieuTx(client);
    const phieuId = await productionRepo.createPhieuDone(client, { lenhId, chuyenId: lenh.chuyen_id, maPhieu, soLuong: qty }, actorId);
    const mt = await productionRepo.nextMaTemTx(client);
    await productionRepo.createTemGiaCongOqc(client, { phieuId, maTem: mt, soLuong: qty }, actorId);
    // Chưa đủ SL → GIỮ trạng thái GIA_CONG để lệnh còn ở màn Gia công mà nhận nốt.
    if (xong) await productionRepo.setLenhTrangThai(client, lenhId, 'HOAN_TAT', actorId);
    await client.query(
      `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
       VALUES ('lenh_san_xuat', $1, 'GIA_CONG_CHUYEN_OQC', $2::jsonb, $3, CURRENT_TIMESTAMP, $3)`.replace(/\s+/g, ' '),
      [String(lenhId), JSON.stringify({
        ma_lenh: lenh.ma_lenh_san_xuat, so_luong: qty, ma_tem: mt,
        da_chuyen: daChuyen + qty, con_lai: tong - (daChuyen + qty), hoan_tat: xong,
      }), actorId]
    );
    return mt;
  });
  // Chỉ đẩy dòng chảy sang OQC khi đã nhận đủ; tem của các lần trước vẫn vào màn OQC bình thường
  // (danh sách OQC lọc theo SỔ CÁI tem `con_oqc > 0`, không phụ thuộc trạng thái lệnh).
  if (xong) {
    await tracking.moveByLenh(lenhId, 'OQC', actorId);
    await qaRepo.resolveReturnsMany('TEST_RUN', lenh.dot_vai_ids || []);
  }
  sockets.emit('workflow:updated', { lenhId, stage: xong ? 'OQC' : 'GIA_CONG', giaCong: true });
  sockets.emit('dashboard:refresh', {});
  return {
    id: lenhId, ma_tem: maTem, stage: xong ? 'OQC' : 'GIA_CONG',
    so_luong: qty, da_chuyen: daChuyen + qty, con_lai: tong - (daChuyen + qty), hoan_tat: xong,
  };
}

// ----- HỦY TEM GIA CÔNG (tab "Hủy lệnh xác nhận") -----
// Bấm "Chuyển OQC" nhầm / nhập sai SL → hủy tem đó. SL của tem quay lại phần CHƯA chuyển của lệnh
// (KHÔNG cộng thêm vào `so_luong_release`), lệnh hiện lại ở màn Gia công để nhận tiếp.
async function listGiaCongTemCancelable({ search, page, limit, offset }) {
  const { rows, total } = await repo.listGiaCongTemCancelable({ search: search || '', offset, limit });
  return { items: rows, meta: buildMeta(page, limit, total) };
}

async function cancelGiaCongTem(temId, { lyDo } = {}, actorId) {
  const t = await repo.getGiaCongTem(temId);
  if (!t) throw new AppError('Tem không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (t.ma_loai_chuyen !== 'GIA_CONG') {
    throw new AppError('Tem này không thuộc lệnh gia công', { status: 409, errorCode: 'NOT_GIA_CONG' });
  }
  if (t.trang_thai === 'HUY') throw new AppError('Tem đã bị hủy', { status: 409, errorCode: 'DA_HUY' });
  if (Number(t.sl_oqc_dat) > 0 || Number(t.sl_da_giao) > 0) {
    throw new AppError('Tem đã qua OQC hoặc đã giao — không hủy được', { status: 409, errorCode: 'DA_XU_LY' });
  }
  const ly = String(lyDo || '').trim();
  if (!ly) throw new AppError('Nhập lý do hủy tem gia công', { status: 422, errorCode: 'NO_LY_DO' });

  await withTransaction(async (client) => {
    await repo.cancelGiaCongTemTx(client, {
      temId, phieuId: t.phieu_id, lenhId: t.lenh_id, lenhTrangThai: t.lenh_trang_thai,
    }, actorId);
    await client.query(
      `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
       VALUES ('tem', $1, 'HUY_TEM_GIA_CONG', $2::jsonb, $3, CURRENT_TIMESTAMP, $3)`.replace(/\s+/g, ' '),
      [String(temId), JSON.stringify({
        ma_tem: t.ma_tem, ma_lenh: t.ma_lenh_san_xuat, so_luong: t.so_luong, ly_do: ly,
        lenh_trang_thai_cu: t.lenh_trang_thai,
      }), actorId]
    );
  });
  // Lệnh quay lại chờ gia công ⇒ kéo dòng chảy về theo (best-effort, giống lúc tạo lệnh gia công).
  sockets.emit('workflow:updated', { lenhId: t.lenh_id, stage: 'GIA_CONG', giaCong: true });
  sockets.emit('dashboard:refresh', {});
  const sau = await repo.getGiaCongLenh(t.lenh_id);
  return {
    tem_id: temId, ma_tem: t.ma_tem, lenh_id: t.lenh_id, ma_lenh: t.ma_lenh_san_xuat,
    so_luong: t.so_luong,
    da_chuyen: sau ? Number(sau.da_chuyen) || 0 : null,
    con_lai: sau ? (Number(sau.so_luong_release) || 0) - (Number(sau.da_chuyen) || 0) : null,
  };
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

// ----- CÀI ĐẶT CA THEO TUẦN -----
async function listCaTuan() { return repo.listCaTuan(); }

async function upsertCaTuan({ nam, tuan, loaiCa, ghiChu }, actorId) {
  const y = Number(nam); const w = Number(tuan);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new AppError('Năm không hợp lệ', { status: 422, errorCode: 'INVALID' });
  if (!Number.isInteger(w) || w < 1 || w > 53) throw new AppError('Tuần không hợp lệ (1–53)', { status: 422, errorCode: 'INVALID' });
  if (!['NGAN', 'DAI', 'HANH_CHINH'].includes(loaiCa)) throw new AppError('Loại ca phải là NGAN, DAI hoặc HANH_CHINH', { status: 422, errorCode: 'INVALID' });
  return repo.upsertCaTuan({ nam: y, tuan: w, loaiCa, ghiChu }, actorId);
}

// ----- DANH SÁCH RELEASE theo ngày kế hoạch (modal/report + Excel/In) -----
async function releaseList(date) {
  if (!date) throw new AppError('Thiếu ngày', { status: 422, errorCode: 'NO_DATE' });
  const items = await repo.releaseListByDate(date);
  const uniq = (key) => new Set(items.map((r) => r[key]).filter(Boolean)).size;
  return {
    items,
    meta: {
      ngay: date,
      tong_don: uniq('ma_don_hang'),
      tong_ma: uniq('ma_hang'),
      tong_phan: uniq('ma_phan'),
      sl_release: items.reduce((s, r) => s + (Number(r.so_luong_release) || 0), 0),
    },
  };
}

// ----- Danh sách "đã hoàn thành" theo ngày (cho DonePanel bên trái) -----
async function release1Done(date) { return repo.release1DoneByDate(date); }
async function release2Done(date) { return repo.planDoneByDate(date, 'RELEASE_2'); }
async function replanDone(date) { return repo.planDoneByDate(date, 'REPLAN'); }
// Gắn các LẦN TEST (kết quả + nguyên nhân nếu lỗi) vào từng dòng → cột "Lần test 1..N" ở sidebar/Excel.
async function attachTestRuns(rows) {
  const ids = [...new Set(rows.map((r) => r.lenh_id).filter(Boolean))];
  if (!ids.length) return rows.map((r) => ({ ...r, tests: [] }));
  const trs = await repo.testRunsByLenh(ids);
  const byLenh = {};
  trs.forEach((t) => {
    (byLenh[t.lenh_san_xuat_id] || (byLenh[t.lenh_san_xuat_id] = []))
      .push({ lan: t.lan_test, ket_qua: t.ket_qua, ghi_chu: t.ghi_chu });
  });
  return rows.map((r) => ({ ...r, tests: byLenh[r.lenh_id] || [] }));
}

async function testCnspDone(date) { return attachTestRuns(await repo.testDoneByDate(date, CNSP_CP)); }
async function testQaDone(date) { return attachTestRuns(await repo.testDoneByDate(date, QA_CP)); }

module.exports = {
  listRelease1Candidates, autoPlanCandidates, createRelease1, traVeKyThuat, createDotSanXuat, release1History, listReleaseSets, releaseSet,
  listGopCandidates, gopDotVai, gopHistory,
  listTestRunCandidates, getLenhDetail, recordTestRun, confirmTest, confirmTestBatch, cancelTest,
  returnTestRunToReady,
  listRelease2Candidates, approveRelease2, approveRelease2Batch, skipTestRun, testRunHistory,
  listReplanCandidates, replan, replanBatch, planHistory,
  listGiaCong, confirmGiaCongToOqc, giaCongHistory, listGiaCongTemCancelable, cancelGiaCongTem, traLaiNhaGiaCong,
  listKeHoachTam, keHoachTamSet, confirmKeHoachTam, updateKeHoachTam, deleteKeHoachTam, keHoachTamHistory, keHoachTamDone,
  listCancelableLenh, rollbackLenh,
  release1Done, release2Done, replanDone, testCnspDone, testQaDone,
  releaseList,
  listCaTuan, upsertCaTuan,
};
