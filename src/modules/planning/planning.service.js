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

// GIA CÔNG: đợt SX gửi ra ngoài gia công → KHÔNG in trong xưởng, đi THẲNG OQC.
// Tạo lệnh HOAN_TAT + phiếu HOAN_TAT + tem CHO_OQC (seed sl_kcs_dat = SL ⇒ con_oqc>0, nguồn KCS)
// để lọt vào màn OQC (bốc mẫu → Giao như thường). SLA ở OQC bị bỏ (nhận diện qua chuyền loại GIA_CONG).
async function createGiaCongLenh(client, { versionId, chuyenId, junctions, tongSL, ngayKeHoach, tgBdKh, tgKtKh }, actorId) {
  const maLenh = await repo.nextMaLenhTx(client);
  const lenhId = await repo.createLenh(client, {
    versionId, maLenh, chuyenId, soLuongRelease: tongSL, ngayKeHoach, trangThai: 'HOAN_TAT', giaiDoan: 'IN',
    tgBdKh: tgBdKh || null, tgKtKh: tgKtKh || null,
  }, actorId);
  for (const j of junctions) await repo.addLenhDotVai(client, lenhId, j.dotVaiId, actorId, j.soLuong);
  const maPhieu = await productionRepo.nextMaPhieuTx(client);
  const phieuId = await productionRepo.createPhieuDone(client, { lenhId, chuyenId, maPhieu, soLuong: tongSL }, actorId);
  const maTem = await productionRepo.nextMaTemTx(client);
  await productionRepo.createTemGiaCongOqc(client, { phieuId, maTem, soLuong: tongSL }, actorId);
  return { id: lenhId, ma_lenh_san_xuat: maLenh, ma_tem: maTem };
}

async function createRelease1({ dotVaiIds, chuyenId, soLuongRelease, ngayKeHoach }, actorId) {
  if (!Array.isArray(dotVaiIds) || dotVaiIds.length === 0) {
    throw new AppError('Chọn ít nhất một đợt vải', { status: 422, errorCode: 'NO_DOT_VAI' });
  }
  if (!chuyenId) throw new AppError('Chọn chuyền sản xuất', { status: 422, errorCode: 'NO_CHUYEN' });

  // RELEASE THEO SỐ LƯỢNG: mỗi đợt còn "con_release = SL vải về − đã release". Release 1 lần = 1 lệnh với
  // SL nhập (≤ còn lại); đợt Ở LẠI pool tới khi release đủ ⇒ 1 đợt có thể có NHIỀU lệnh.
  const remain = await repo.getDotVaiRemaining(dotVaiIds);
  const conMap = Object.fromEntries(remain.map((r) => [r.id, r.con_release]));
  const single = dotVaiIds.length === 1;

  // Xác định SL release từng đợt + validate. Single có nhập SL → dùng SL nhập; còn lại → release hết phần còn.
  const plan = [];
  for (const dvId of dotVaiIds) {
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
  if (plan.length === 0) throw new AppError('Các đợt vải đã release đủ số lượng', { status: 409, errorCode: 'ALL_RELEASED' });

  // GIA CÔNG (chuyền loại GIA_CONG): mỗi đợt → 1 lệnh đi THẲNG OQC (bỏ Test Run/Release 2/Sản xuất/KCS/Sửa).
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
    for (const c of created) await tracking.moveByLenh(c.id, 'OQC', actorId);
    await qaRepo.resolveReturnsMany('TEST_RUN', created.map((c) => c.dot_vai_id));
    created.forEach((c) => sockets.emit('workflow:updated', { lenhId: c.id, stage: 'OQC', giaCong: true }));
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
    if (!d.qc_done) throw new AppError(`Đợt ${d.ma_dot_vai} chưa hoàn tất kỹ thuật (QC/READY)`, { status: 409, errorCode: 'NOT_READY' });
    if (p.soLuong > d.con_dua) {
      throw new AppError(`SL đưa vào của đợt ${d.ma_dot_vai} (${p.soLuong}) vượt SL còn lại (${d.con_dua})`,
        { status: 422, errorCode: 'OVER' });
    }
    pins.add(d.phan_in_id);
  }
  if (pins.size > 1) throw new AppError('Chỉ gộp các đợt vải CÙNG PHẦN IN (code phần) vào một đợt sản xuất. Muốn gom nhiều phần in cùng màu → dùng Gom set ở READY.', { status: 422, errorCode: 'MIXED_PHAN_IN' });

  const tongSL = plan.reduce((s, p) => s + p.soLuong, 0);

  // GIA CÔNG (chuyền loại GIA_CONG): gộp mọi đợt vào 1 lệnh đi THẲNG OQC (bỏ Test Run/SX/KCS...).
  const chuyenLoaiDsx = await repo.getChuyenLoai(chuyenId);
  if (chuyenLoaiDsx === 'GIA_CONG') {
    const version = await wf.getActiveVersion();
    const gc = await withTransaction(async (client) => createGiaCongLenh(client, {
      versionId: version.id, chuyenId, junctions: plan.map((p) => ({ dotVaiId: p.dotVaiId, soLuong: p.soLuong })),
      tongSL, ngayKeHoach, tgBdKh, tgKtKh,
    }, actorId));
    await tracking.moveByLenh(gc.id, 'OQC', actorId);
    await qaRepo.resolveReturnsMany('TEST_RUN', ids);
    sockets.emit('workflow:updated', { lenhId: gc.id, stage: 'OQC', giaCong: true });
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
    // Gom set = mỗi đợt vào trọn SL vải về (all-or-nothing) → so_luong junction = SL đợt.
    for (const m of members) await repo.addLenhDotVai(client, id, m.dot_vai_id, actorId, m.so_luong);
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
  const lenh = await repo.getLenhBasic(lenhId);
  if (!lenh) throw new AppError('Đợt sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (lenh.trang_thai !== 'RELEASE_1') {
    throw new AppError('Đợt không ở trạng thái Test Run', { status: 409, errorCode: 'WRONG_STAGE' });
  }
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

// ----- CÀI ĐẶT CA THEO TUẦN -----
async function listCaTuan() { return repo.listCaTuan(); }

async function upsertCaTuan({ nam, tuan, loaiCa, ghiChu }, actorId) {
  const y = Number(nam); const w = Number(tuan);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new AppError('Năm không hợp lệ', { status: 422, errorCode: 'INVALID' });
  if (!Number.isInteger(w) || w < 1 || w > 53) throw new AppError('Tuần không hợp lệ (1–53)', { status: 422, errorCode: 'INVALID' });
  if (!['NGAN', 'DAI'].includes(loaiCa)) throw new AppError('Loại ca phải là NGAN hoặc DAI', { status: 422, errorCode: 'INVALID' });
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
async function testCnspDone(date) { return repo.testDoneByDate(date, CNSP_CP); }
async function testQaDone(date) { return repo.testDoneByDate(date, QA_CP); }

module.exports = {
  listRelease1Candidates, autoPlanCandidates, createRelease1, createDotSanXuat, release1History, listReleaseSets, releaseSet,
  listGopCandidates, gopDotVai, gopHistory,
  listTestRunCandidates, getLenhDetail, recordTestRun, confirmTest, confirmTestBatch, cancelTest,
  listRelease2Candidates, approveRelease2, approveRelease2Batch, skipTestRun, testRunHistory,
  listReplanCandidates, replan, replanBatch, planHistory,
  listCancelableLenh, rollbackLenh, returnTestRunToRelease1,
  release1Done, release2Done, replanDone, testCnspDone, testQaDone,
  releaseList,
  listCaTuan, upsertCaTuan,
};
