'use strict';

const { withTransaction } = require('../../config/db');
const repo = require('./planning.repository');
const qaRepo = require('../quality/quality.repository'); // qc_tra_ve dùng chung
const productionRepo = require('../production/production.repository'); // phiếu+tem gia công (→ OQC)
const chuyenRepo = require('../chuyen/chuyen.repository');
const wf = require('../workflow/workflow.repository');
const AppError = require('../../utils/AppError');
const erpHuy = require('../../utils/erpHuy');
const wfCache = require('../../utils/wfCache');
const { buildMeta } = require('../../utils/pagination');
const { layBarcodeTem, layBarcodeTem13 } = require('../../utils/erpTemBarcode');
const { STAGE_LABEL } = require('../../utils/stage'); // nhãn giai đoạn — dùng chung với dashboard
const { kiemCap } = require('../../utils/phuongAnChuyen'); // luật PA in ↔ loại chuyền (chặn ở Release 1)
const { tinhNangBat } = require('../../utils/caiDatTinhNang'); // công tắc bật/tắt luật trên (mig 087)
const { coCotThoInKh, chuanHoaThoIn } = require('../../utils/thoInKeHoach'); // thợ in kế hoạch (mig 111)
const { LOAI_TRA_VE_KH } = require('../../utils/traVeKeHoach'); // Test Run trả về Kế hoạch (giữ lệnh)
const { NHOM_CA_RIENG, ngayCaKeHoach } = require('../../utils/ca'); // nhóm cài ca riêng được (mig 112; KHAC = chuyền khác, 09/10/2026)
const sockets = require('../../sockets');
const tracking = require('../workflow/tracking.service');
const erpRepo = require('../erpsync/erpsync.repository'); // reopenReadyForPhanIn (mở lại READY)
// Chuông thông báo cho Kỹ thuật khi phần in bị trả về (mig 085).
// ⚠ Không tạo vòng require: `thongbao.service` chỉ phụ thuộc repo của chính nó + utils + sockets.
const thongBao = require('../thongbao/thongbao.service');
// Gửi dữ liệu lệnh sang ERP sau Release 1 / Xác nhận kế hoạch tạm / Lập lại kế hoạch (04/10/2026) — chạy ngầm.
const release1Erp = require('./release1Erp');
// Khách gia công (II/AD) miễn Khuôn — nhãn cột Khuôn của Danh sách release.
const { isKhuonOptional } = require('../../utils/tech');
const { ngayHomNayVN } = require('../../utils/khoangNgay');
const { trongGioHanhChinh } = require('../../utils/gioHanhChinh'); // Test Run ngoài giờ ⇒ QA kiêm Release 2
const { khoaNgc, tenNgc } = require('../../utils/nhaGiaCong'); // đợt khác nhà gia công không gom (27/10/2026)
const { coCotBtp, datSoDauTx, coDauCho } = require('../../utils/btpKhacKh'); // BTP khác kế hoạch (mig 120, 28/10/2026)

const TEST_TRAM = 'TEST_RUN';
const CNSP_CP = 'TEST_CNSP';
const QA_CP = 'TEST_QA';
// ⚠⚠⚠ 27/10/2026 (người dùng chốt: "tất cả chỗ này sửa lại đều qua Test Run; Test Run bấm Không test run thì nhảy vào
//   chờ sản xuất, có đợt của phần đó đang sản xuất thì cộng thẳng vào"): RELEASE 1 KHÔNG CÒN TỰ BỎ TEST RUN — mọi lệnh
//   tạo ra (Release 1 · xác nhận Kế hoạch tạm · Gom đợt vải · gia công → chuyền xưởng) đều vào `RELEASE_1` = màn Test Run.
//   ĐÃ GỠ cả 3 luật đi tắt cũ: (a) đợt BO_SUNG (5I) / MAU_SO_LUONG (6I) — chốt 21/08 · (b) phần in đang in tem · (c) SL < 100.
//   Bỏ test giờ CHỈ do QA bấm "Không test run" (`skipTestRun`). Đừng đưa lại luật đi tắt nếu người dùng chưa yêu cầu.

// ⚠ Bọc CACHE RAM (`utils/wfCache.js`, TTL 60s): bản gốc chạy **3 query TUẦN TỰ** (version → trạm →
//   checkpoint) và được gọi ở 8 chỗ ⇒ ~75 ms độ trễ mạng thừa cho mỗi request dùng nó. Cấu hình này
//   chỉ đổi khi sửa workflow, mà lúc đó `wfconfig` gọi `xoaCache()`.
async function loadTestConfig() {
  return wfCache.nho('TEST_RUN_CONFIG', docTestConfigTuDb);
}

async function docTestConfigTuDb() {
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
  const rows = await repo.gopHistoryByDate(date || ngayHomNayVN());
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
async function createGiaCongLenh(client, { versionId, chuyenId, junctions, tongSL, ngayKeHoach, tgBdKh, tgKtKh, thoInKh }, actorId) {
  const maLenh = await repo.nextMaLenhTx(client);
  const lenhId = await repo.createLenh(client, {
    versionId, maLenh, chuyenId, soLuongRelease: tongSL, ngayKeHoach, trangThai: 'GIA_CONG', giaiDoan: 'IN',
    tgBdKh: tgBdKh || null, tgKtKh: tgKtKh || null, thoInKh,
  }, actorId);
  for (const j of junctions) await repo.addLenhDotVai(client, lenhId, j.dotVaiId, actorId, j.soLuong);
  return { id: lenhId, ma_lenh_san_xuat: maLenh };
}

// Trả 1 đợt vải ở Release 1 NGƯỢC về Kỹ thuật: mở lại READY cho phần in (hủy xác nhận Khuôn/Film/Mực/QC
// + gắn cờ can_lam_lai_ready cho đợt chưa release). Chỉ khi đợt CHƯA release (chưa có lệnh ≠ HUY).
//
// ⚠⚠ TRẢ **LẺ ĐÚNG 1 PHẦN IN**, KỂ CẢ KHI ĐỢT VẢI THUỘC GOM SET (chốt 15/08/2026).
// Bản trước trả về NGUYÊN CẢ SET, với lý do: "set in chung, release all-or-nothing nên trả lẻ sẽ để
// set nửa Ready nửa không — set vẫn không release được". Tiền đề đó KHÔNG CÒN kể từ khi Release 1
// cho release LẺ từng phần in: set nửa Ready nửa không nay là trạng thái BÌNH THƯỜNG (phần Ready đi
// trước, phần chưa Ready đi sau). Giữ luật cũ thì bấm trả về 1 phần in sẽ **xóa công đã làm của các
// phần in khác trong set** — làm quá tay, và người bấm không hề thấy chúng trên màn hình.
async function traVeKyThuat({ dotVaiId, lyDo }, actorId) {
  if (!dotVaiId) throw new AppError('Thiếu đợt vải', { status: 400, errorCode: 'EMPTY' });
  const reason = (lyDo || '').trim();
  if (!reason) throw new AppError('Nhập lý do trả về Kỹ thuật', { status: 422, errorCode: 'NO_LY_DO' });
  const pinId = await repo.phanInIdByDotVai(dotVaiId);
  if (!pinId) throw new AppError('Không tìm thấy đợt vải', { status: 404, errorCode: 'NOT_FOUND' });

  // ⚠ Guard chỉ xét ĐÚNG đợt vải được bấm (trước đây xét cả set). Đợt đã release thì phải hủy lệnh
  //   trước, vì mở lại READY khi lệnh còn sống sẽ cho ra "chưa Ready mà đã ở Test Run".
  if (await repo.dotVaiReleasedOne(dotVaiId)) {
    throw new AppError('Đợt vải đã release — hãy hủy lệnh trước khi trả về Kỹ thuật',
      { status: 409, errorCode: 'RELEASED' });
  }

  // ⚠⚠ GIỮ NGUYÊN xác nhận Khuôn/Film/Mực, CHỈ hủy QC (người dùng chốt 16/09/2026) — để 2 sidebar
  //   *Lịch sử* + *Đã hoàn thành* của màn READY không mất dấu công tổ kỹ thuật đã làm. Phần in vẫn
  //   quay về màn READY vì `qc_done` đã false; kỹ thuật biết phải làm lại gì qua badge + lý do.
  //   Chi tiết đánh đổi: `erpsync.repository.chiHuyQcReady`.
  await erpRepo.chiHuyQcReady(pinId);
  await repo.auditTraVeKyThuat(pinId, dotVaiId, reason, actorId);
  // Ghi qc_tra_ve loai='RELEASE1' (mức phần in) → màn READY/QC READY hiện badge + LÝ DO trả về;
  // cờ tự tắt khi QC xác nhận READY lại (technical.confirmQC → resolveReturns('RELEASE1')).
  await qaRepo.insertQcTraVe({ loai: 'RELEASE1', phanInId: pinId, dotVaiId, lyDo: reason }, actorId);
  // Chuông cho Kỹ thuật (mig 085). ⚠ KHÔNG `await`: có thể phải gửi Web Push tới nhiều thiết bị,
  // chặn response từng ấy giây là hỏng thao tác. Hàm tự nuốt mọi lỗi.
  thongBao.banThongBao({ loaiTraVe: 'RELEASE1', phanInId: pinId, actorId });
  await tracking.moveByPhanIn(pinId, 'READY', actorId);

  sockets.emit('workflow:updated', { stage: 'READY', traVe: true });
  sockets.emit('ready:confirmed', { traVe: true }); // READY & QC READY nghe event này để tải lại ngầm
  sockets.emit('dashboard:refresh', {});
  return { phan_in_id: pinId, so_phan_in: 1, ma_set: null };
}

// Kiểm luật "phương án in ↔ loại chuyền" cho danh sách đợt vải sắp release.
// Lệch ⇒ ném 422 `PAIN_LECH_CHUYEN` kèm danh sách CHI TIẾT từng phần in (`details`) để FE chỉ đúng
// dòng nào sai, thay vì chỉ báo một câu chung chung rồi người dùng phải tự dò.
// ⚠ Gom theo PHẦN IN (nhiều đợt vải có thể cùng 1 phần in) — không thì cùng một lỗi báo lặp N lần.
async function kiemPainVsChuyen(dotVaiIds, chuyenId) {
  // ⚠⚠ CÔNG TẮC Ở *Hệ thống > Cài đặt tính năng* (mig 087). TẮT ⇒ bỏ qua hoàn toàn, release lên
  //   chuyền nào cũng được. Kiểm NGAY ĐẦU để khi tắt thì không tốn thêm query nào.
  //   ⚠ Thiếu bảng cấu hình / DB lỗi ⇒ `tinhNangBat` trả mặc định **BẬT** ⇒ giữ nguyên luật.
  if (!(await tinhNangBat('RELEASE1_KHOP_LOAI_CHUYEN'))) return;

  const rows = await repo.getPainVsChuyen(dotVaiIds, chuyenId);
  const loi = [];
  const daBao = new Set();
  rows.forEach((r) => {
    const kq = kiemCap({
      maLoaiChuyen: r.ma_loai_chuyen,
      phuongAnIn: r.phuong_an_in,
      maChuyen: r.ma_chuyen,
      maPhan: r.ma_phan,
    });
    if (!kq || daBao.has(r.phan_in_id)) return;
    daBao.add(r.phan_in_id);
    loi.push({ ...kq, phan_in_id: r.phan_in_id, ma_phan: r.ma_phan, phuong_an_in: r.phuong_an_in });
  });
  if (!loi.length) return;
  const dau = loi[0];
  throw new AppError(
    loi.length === 1 ? dau.thong_diep : `${loi.length} phần in có phương án in không khớp loại chuyền. ${dau.thong_diep}`,
    { status: 422, errorCode: dau.ma_loi, details: loi }
  );
}

// Chia `tong` cho các đợt theo thứ tự `ids`, mỗi đợt tối đa phần còn (`conMap`). Trả Map dvId → SL (đợt không nhận
// gì thì vắng). Dùng cho SL nhập tay khi 1 dòng Release 1 gom nhiều đợt cùng code phần (18/10/2026).
function chiaSlTheoDot(ids, conMap, tong) {
  const out = new Map();
  let conLai = Math.max(0, Number(tong) || 0);
  for (const id of ids) {
    if (conLai <= 0) break;
    const lay = Math.min(Math.max(0, Number(conMap[id]) || 0), conLai);
    if (lay > 0) { out.set(id, lay); conLai -= lay; }
  }
  return out;
}

// `opts.nguonErp` = nhãn thao tác gửi kèm lượt báo ERP (`release1Erp`): mặc định RELEASE_1; Xác nhận kế
//   hoạch tạm truyền KE_HOACH_TAM.
// `thoIn` (mig 111, 07/10/2026) = danh sách thợ in KẾ HOẠCH (chuỗi tên ngăn dấu phẩy, hoặc mảng) — ghi vào
//   mọi lệnh tạo ra / mọi dòng kế hoạch tạm của lượt này. Chưa chạy migration ⇒ bỏ qua (fail-open, release vẫn
//   chạy) và trả `tho_in_chua_luu: true` để FE báo.
// KIỂM LẠI SL còn release SAU KHI KHÓA đợt vải, trong transaction tạo lệnh (21/10/2026 — chặn release gấp đôi khi 2
//   lượt chạy song song, xem `repo.khoaConReleaseTx`). `nhomLenh` = [[{dvId, qty}]]. SL NHẬP TAY (`chat`) mà không còn
//   đủ ⇒ 409 OVER; release hết phần còn ⇒ cắt về phần còn thật, đợt hết thì bỏ; không còn gì ⇒ 409 ALL_RELEASED.
async function kiemLaiConReleaseTx(client, nhomLenh, chat) {
  const con = await repo.khoaConReleaseTx(client, nhomLenh.flat().map((p) => p.dvId));
  const out = [];
  for (const nhom of nhomLenh) {
    const n = [];
    for (const p of nhom) {
      const c = Number(con[String(p.dvId)]) || 0;
      if (chat && p.qty > c) {
        throw new AppError(`SL release (${p.qty}) vượt SL còn lại (${c}) — đợt vải vừa được release ở lượt khác, tải lại trang`,
          { status: 409, errorCode: 'OVER' });
      }
      const q = Math.min(p.qty, c);
      if (q > 0) n.push({ ...p, qty: q });
    }
    if (n.length) out.push(n);
  }
  if (!out.length) {
    throw new AppError('Các đợt vải đã release đủ số lượng (vừa được release ở lượt khác) — tải lại trang',
      { status: 409, errorCode: 'ALL_RELEASED' });
  }
  return out;
}

// `btpKhacKh` (mig 120, 28/10/2026): ô tích "BTP khác KH" — in BTP nhiều đầu tấm vải ở các kế hoạch khác nhau ⇒ THÊM 1
//   ĐẦU cho mọi đợt của lượt (cả đợt vào lệnh lẫn đợt lưu kế hoạch tạm) — 29/10/2026: tích ở lần 2, 3… thêm đầu 3, 4…
//   ⇒ đợt ở lại Release 1 với còn = SL vải cho đầu kế (luật `utils/btpKhacKh.js`). Ghi TRONG transaction tạo lệnh (sau
//   khi gắn đợt vào lệnh ⇒ phần vừa release đã tính). Chưa chạy mig ⇒ bỏ qua, trả `btp_chua_luu`.
async function createRelease1({ dotVaiIds, chuyenId, soLuongRelease, ngayKeHoach, tgBdKh, tgKtKh, thoIn, btpKhacKh }, actorId, opts = {}) {
  if (!Array.isArray(dotVaiIds) || dotVaiIds.length === 0) {
    throw new AppError('Chọn ít nhất một đợt vải', { status: 422, errorCode: 'NO_DOT_VAI' });
  }
  if (!chuyenId) throw new AppError('Chọn chuyền sản xuất', { status: 422, errorCode: 'NO_CHUYEN' });
  const thoInKh = chuanHoaThoIn(thoIn);
  const thoInChuaLuu = !!thoInKh && !(await coCotThoInKh());
  const batBtp = !!btpKhacKh && (await coCotBtp());
  const btpChuaLuu = !!btpKhacKh && !batBtp;

  // ⚠ CHẶN: phần in đang ở Giao nhận (trả về GN, chưa "Xác nhận lại") thì chưa release / chưa lưu kế hoạch
  //   tạm được — màn Release 1 đã ẩn, chặn này cho đường Xác nhận kế hoạch tạm + màn để lâu chưa tải lại.
  //   Chạy TRƯỚC mọi thao tác ghi (kể cả nhánh kế hoạch tạm bên dưới).
  const dangOGn = await repo.phanInDangOGnTheoDot(dotVaiIds);
  if (dangOGn.length) {
    throw new AppError(`${dangOGn.join(', ')} đang chờ Giao nhận sửa thông tin — chưa release được`,
      { status: 409, errorCode: 'DANG_O_GN', details: dangOGn });
  }

  // ⚠⚠ CHẶN: PHƯƠNG ÁN IN PHẢI KHỚP LOẠI CHUYỀN (chốt 18/08/2026 — `utils/phuongAnChuyen.js`).
  //   CHẶN TUYỆT ĐỐI, không có cờ bỏ qua. Lệch ⇒ phải đổi phương án in (lý do + người duyệt, mig 086).
  // ⚠ Kiểm TRƯỚC MỌI thao tác ghi (kể cả nhánh Kế hoạch tạm bên dưới): để lọt xuống dưới thì đợt
  //   CHƯA QC đã kịp lưu kế hoạch tạm với chuyền sai rồi mới báo lỗi — nửa vời, khó gỡ.
  // ⚠ PHẠM VI: người dùng chốt CHỈ chặn ở Release 1 (chính hàm này). 4 đường gán chuyền còn lại
  //   (Tạo đợt SX · Kế hoạch tạm xác nhận · Lập kế hoạch lại · Đổi chuyền ở Sản xuất) CỐ Ý KHÔNG
  //   chặn — nếu sau này muốn bịt thì gọi đúng khối này ở đó, đừng chép luật ra chỗ mới.
  await kiemPainVsChuyen(dotVaiIds, chuyenId);

  // KẾ HOẠCH TẠM (mig 058): tách đợt ĐÃ QC (Ready xong → release ngay) vs CHƯA QC (→ lưu kế hoạch tạm).
  const qcInfo = await repo.getDotVaiForCompose(dotVaiIds);
  const qcMap = Object.fromEntries(qcInfo.map((r) => [r.id, r]));
  const readyIds = dotVaiIds.filter((id) => qcMap[id]?.qc_done);
  const waitIds = dotVaiIds.filter((id) => !qcMap[id]?.qc_done);
  const remainAll = await repo.getDotVaiRemaining(dotVaiIds);
  const conAll = Object.fromEntries(remainAll.map((r) => [r.id, r.con_release]));
  // SL NHẬP TAY (panel lẻ) áp được khi MỌI đợt cùng 1 phần in (18/10/2026 — Release 1 gom nhiều đợt cùng code phần
  //   thành 1 dòng): chia lần lượt cho các đợt theo THỨ TỰ gửi lên, mỗi đợt tối đa phần còn lại của nó.
  const motPhanIn = new Set(dotVaiIds.map((id) => qcMap[id]?.phan_in_id)).size === 1;
  const nhapSl = soLuongRelease != null && motPhanIn;
  let chiaNhap = null; // dvId → SL (chỉ khi nhập tay) — chia 1 lần cho đợt Ready trước rồi tới đợt chờ Ready
  if (nhapSl) {
    const qty = Number(soLuongRelease);
    const tongCon = dotVaiIds.reduce((s, id) => s + (Number(conAll[id]) || 0), 0);
    if (!(qty > 0)) throw new AppError('Số lượng release phải > 0', { status: 422, errorCode: 'INVALID_QTY' });
    if (qty > tongCon) throw new AppError(`SL release (${qty}) vượt SL còn lại (${tongCon})`, { status: 422, errorCode: 'OVER' });
    chiaNhap = chiaSlTheoDot([...readyIds, ...waitIds], conAll, qty);
  }
  const slTam = chiaNhap;
  let tamCount = 0;
  const tamIds = [];
  for (const dvId of waitIds) {
    const con = Number(conAll[dvId]) || 0;
    if (con <= 0) continue;
    const qty = slTam ? (slTam.get(dvId) || 0) : con;
    if (qty <= 0) continue;
    await repo.upsertKeHoachTam({
      dotVaiId: dvId, phanInId: qcMap[dvId]?.phan_in_id, chuyenId, ngayKeHoach,
      tgBdKh: tgBdKh || null, tgKtKh: tgKtKh || null, soLuong: qty, thoInKh,
    }, actorId);
    tamCount += 1;
    tamIds.push(dvId);
  }
  if (batBtp && tamIds.length) await datSoDauTx(null, tamIds, actorId, { them: true, nguon: 'KE_HOACH_TAM' });
  const btpTra = { btp_khac_kh: batBtp, btp_chua_luu: btpChuaLuu };
  if (readyIds.length === 0) {
    sockets.emit('dashboard:refresh', {});
    return { created_count: 0, created_summary: [], ke_hoach_tam_count: tamCount, chi_tam: true, tho_in_chua_luu: thoInChuaLuu, ...btpTra };
  }

  // RELEASE THEO SỐ LƯỢNG: mỗi đợt còn "con_release = SL vải về − đã release". Release 1 lần = 1 lệnh với
  // SL nhập (≤ còn lại); đợt Ở LẠI pool tới khi release đủ ⇒ 1 đợt có thể có NHIỀU lệnh.
  const remain = await repo.getDotVaiRemaining(readyIds);
  const conMap = Object.fromEntries(remain.map((r) => [r.id, r.con_release]));

  // Xác định SL release từng đợt + validate. Có nhập SL (mọi đợt cùng 1 phần in) → chia SL nhập cho các đợt; còn lại
  // → release hết phần còn của từng đợt.
  const plan = [];
  if (chiaNhap) {
    readyIds.forEach((dvId) => {
      const qty = Math.min(chiaNhap.get(dvId) || 0, Number(conMap[dvId]) || 0);
      if (qty > 0) plan.push({ dvId, qty });
    });
  } else {
    for (const dvId of readyIds) {
      const con = Number(conMap[dvId]) || 0;
      if (con > 0) plan.push({ dvId, qty: con }); // batch: release hết phần còn lại; bỏ qua đợt đã release đủ
    }
  }
  if (plan.length === 0) {
    if (tamCount > 0) { sockets.emit('dashboard:refresh', {}); return { created_count: 0, created_summary: [], ke_hoach_tam_count: tamCount, chi_tam: true, tho_in_chua_luu: thoInChuaLuu, ...btpTra }; }
    throw new AppError('Các đợt vải đã release đủ số lượng', { status: 409, errorCode: 'ALL_RELEASED' });
  }

  // ⚠⚠ GOM ĐỢT CÙNG CODE PHẦN VÀO 1 LỆNH (18/10/2026, người dùng: "1 code phần mà có nhiều đợt vải ở Release 1 thì tự
  //   động gom số lượng lại"): các đợt Ready của CÙNG phần in trong 1 lượt release ⇒ 1 lệnh, SL = tổng, mỗi đợt 1 dòng
  //   `lenh_sx_dot_vai` (đúng luật "gộp đợt vào 1 lệnh chỉ khi cùng phần in" — §10, như Gom đợt vải). Trước đó mỗi đợt
  //   1 lệnh riêng.
  // 27/10/2026: hết luật bỏ Test Run theo loại đợt ⇒ đợt bổ sung / mẫu SL gom CHUNG với đợt thường của cùng phần in.
  // ⚠ 27/10/2026 (người dùng chốt): đợt KHÁC NHÀ GIA CÔNG (`nha_gia_cong`, ERP NGC) không gom — mỗi NGC 1 lệnh.
  const compose = await repo.getDotVaiForCompose(plan.map((p) => p.dvId));
  const cById = Object.fromEntries(compose.map((r) => [r.id, r]));
  const nhomMap = new Map();
  for (const p of plan) {
    const dv = cById[p.dvId];
    const k = `${dv?.phan_in_id || p.dvId}|${khoaNgc(dv?.nha_gia_cong)}`;
    if (!nhomMap.has(k)) nhomMap.set(k, []);
    nhomMap.get(k).push(p);
  }
  const nhomLenh = [...nhomMap.values()];

  // GIA CÔNG (chuyền loại GIA_CONG): mỗi đợt → 1 lệnh ĐẬU Ở MÀN "GIA CÔNG" (trang_thai='GIA_CONG'),
  // chưa qua OQC. Kế hoạch bấm "Chuyển OQC" mới tạo tem + sang OQC (bỏ Test Run/Release 2/Sản xuất/KCS/Sửa).
  const chuyenLoai = await repo.getChuyenLoai(chuyenId);
  if (chuyenLoai === 'GIA_CONG') {
    const version = await wf.getActiveVersion();
    if (!version) throw new AppError('Chưa cấu hình workflow', { status: 500, errorCode: 'NO_WORKFLOW' });
    const created = await withTransaction(async (client) => {
      const out = [];
      for (const nhom of await kiemLaiConReleaseTx(client, nhomLenh, !!chiaNhap)) {
        const c = await createGiaCongLenh(client, {
          // ⚠ Phải truyền giờ BD/KT: `createGiaCongLenh` nhận sẵn 2 tham số này nhưng caller quên
          //   ⇒ lệnh gia công release từ màn Release 1 mất giờ kế hoạch (fix 2026-08-12).
          versionId: version.id, chuyenId, junctions: nhom.map((p) => ({ dotVaiId: p.dvId, soLuong: p.qty })),
          tongSL: nhom.reduce((s, p) => s + p.qty, 0), ngayKeHoach,
          tgBdKh: tgBdKh || null, tgKtKh: tgKtKh || null, thoInKh,
        }, actorId);
        if (batBtp) await datSoDauTx(client, nhom.map((p) => p.dvId), actorId, { them: true, nguon: 'RELEASE_1' });
        out.push({ ...c, dot_vai_id: nhom[0].dvId, dot_vai_ids: nhom.map((p) => p.dvId), so_dot_vai: nhom.length });
      }
      return out;
    });
    const dotDaTao = created.flatMap((c) => c.dot_vai_ids);
    await qaRepo.resolveReturnsMany('TEST_RUN', dotDaTao);
    await repo.dongSetDaReleaseHet(dotDaTao, actorId);
    created.forEach((c) => sockets.emit('workflow:updated', { lenhId: c.id, stage: 'GIA_CONG', giaCong: true }));
    sockets.emit('dashboard:refresh', {});
    release1Erp.xepHang(created.map((c) => c.id), actorId, opts.nguonErp || 'RELEASE_1');
    const detail = await getLenhDetail(created[0].id);
    return {
      ...detail, created_summary: created, created_count: created.length,
      gia_cong: true, skipped_test_count: created.length, tho_in_chua_luu: thoInChuaLuu, ...btpTra,
    };
  }

  // MỌI LỆNH QUA TEST RUN (27/10/2026, người dùng chốt — xem đầu file): lệnh vào `RELEASE_1` = màn Test Run. Bỏ test chỉ
  //   do QA bấm "Không test run" (`skipTestRun` — vào chờ sản xuất / cộng thẳng vào lệnh đang chạy của phần in).
  const { version } = await loadTestConfig();

  const created = await withTransaction(async (client) => {
    const out = [];
    for (const nhom of await kiemLaiConReleaseTx(client, nhomLenh, !!chiaNhap)) {
      const tong = nhom.reduce((s, p) => s + p.qty, 0);
      const trangThai = 'RELEASE_1';
      const maLenh = await repo.nextMaLenhTx(client);
      const id = await repo.createLenh(client, {
        versionId: version.id, maLenh, chuyenId, soLuongRelease: tong, ngayKeHoach, trangThai,
        tgBdKh: tgBdKh || null, tgKtKh: tgKtKh || null, thoInKh,
      }, actorId);
      for (const p of nhom) await repo.addLenhDotVai(client, id, p.dvId, actorId, p.qty);
      if (batBtp) await datSoDauTx(client, nhom.map((p) => p.dvId), actorId, { them: true, nguon: 'RELEASE_1' });
      out.push({ id, ma_lenh_san_xuat: maLenh, trang_thai: trangThai, so_dot_vai: nhom.length,
        dot_vai_id: nhom[0].dvId, dot_vai_ids: nhom.map((p) => p.dvId) });
    }
    return out;
  });

  // Theo dõi dòng chảy: mỗi lệnh → trạm tương ứng (đợt đã test xong vào thẳng RELEASE_2).
  for (const c of created) {
    await tracking.moveDotVaiTo(c.dot_vai_ids, c.trang_thai === 'RELEASE_2' ? 'RELEASE_2' : 'RELEASE_1', actorId);
  }
  const dotDaTao = created.flatMap((c) => c.dot_vai_ids);
  await qaRepo.resolveReturnsMany('TEST_RUN', dotDaTao); // release lại → tắt cờ "bị Test Run trả về"
  // Đợt vải thuộc gom set nay release LẺ được ⇒ set tự đóng khi member cuối cùng đã release.
  await repo.dongSetDaReleaseHet(dotDaTao, actorId);

  created.forEach((c) => sockets.emit('workflow:updated', { lenhId: c.id, stage: c.trang_thai }));
  sockets.emit('dashboard:refresh', {});
  release1Erp.xepHang(created.map((c) => c.id), actorId, opts.nguonErp || 'RELEASE_1');

  const detail = await getLenhDetail(created[0].id);
  return {
    ...detail,
    created_summary: created,
    created_count: created.length,
    so_dot_vai: dotDaTao.length,
    ke_hoach_tam_count: tamCount,
    skipped_test_count: created.filter((c) => c.trang_thai === 'RELEASE_2').length,
    tho_in_chua_luu: thoInChuaLuu,
    ...btpTra,
  };
}

// ----- GOM ĐỢT VẢI (màn "Gom đợt vải" — tên cũ "Tạo đợt sản xuất", mig 052) — gộp/tách nhiều đợt vải vào 1 đợt SX
// với SL TỪNG đợt. items: [{ dotVaiId, soLuong }]. Tạo 1 lenh_san_xuat + N junction (so_luong). Chỉ gộp CÙNG PHẦN IN.
// `thoIn` (13/10/2026, mig 111): thợ in KẾ HOẠCH — cùng nghĩa + cùng cách ghi với `createRelease1` (lệnh tạo ra /
//   lệnh gia công / kế hoạch tạm khi phần in chưa Ready; không chọn ⇒ NULL; thiếu cột ⇒ vẫn tạo, trả `tho_in_chua_luu`).
async function createDotSanXuat({ items, chuyenId, ngayKeHoach, tgBdKh, tgKtKh, thoIn }, actorId) {
  if (!chuyenId) throw new AppError('Chọn chuyền sản xuất', { status: 422, errorCode: 'NO_CHUYEN' });
  const thoInKh = chuanHoaThoIn(thoIn);
  const thoInChuaLuu = !!thoInKh && !(await coCotThoInKh());
  const plan = (Array.isArray(items) ? items : [])
    .map((i) => ({ dotVaiId: i.dotVaiId, soLuong: Number(i.soLuong) }))
    .filter((i) => i.dotVaiId && i.soLuong > 0);
  if (plan.length === 0) throw new AppError('Chọn ít nhất một đợt vải và nhập số lượng > 0', { status: 422, errorCode: 'NO_ITEM' });

  const ids = plan.map((p) => p.dotVaiId);
  const info = await repo.getDotVaiForCompose(ids);
  const byId = Object.fromEntries(info.map((r) => [r.id, r]));

  // Đợt khác nhà gia công không cộng chung 1 lệnh (27/10/2026, người dùng chốt) — gom riêng từng nhà.
  const ngcs = [...new Set(plan.map((p) => khoaNgc(byId[p.dotVaiId]?.nha_gia_cong)))];
  if (ngcs.length > 1) {
    throw new AppError(`Các đợt vải khác nhà gia công (${ngcs.map(tenNgc).join(', ')}) — không gộp chung một đợt sản xuất, gom riêng từng nhà gia công`,
      { status: 422, errorCode: 'KHAC_NHA_GIA_CONG' });
  }

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
        tgBdKh: tgBdKh || null, tgKtKh: tgKtKh || null, soLuong: p.soLuong, thoInKh,
      }, actorId);
    }
    sockets.emit('dashboard:refresh', {});
    return { chi_tam: true, ke_hoach_tam_count: plan.length, so_luong_release: 0, tho_in_chua_luu: thoInChuaLuu };
  }

  const tongSL = plan.reduce((s, p) => s + p.soLuong, 0);

  // GIA CÔNG (chuyền loại GIA_CONG): gộp mọi đợt vào 1 lệnh ĐẬU Ở MÀN "GIA CÔNG" (trang_thai='GIA_CONG'),
  // chưa qua OQC. Kế hoạch bấm "Chuyển OQC" mới tạo tem + sang OQC (bỏ Test Run/SX/KCS...).
  const chuyenLoaiDsx = await repo.getChuyenLoai(chuyenId);
  if (chuyenLoaiDsx === 'GIA_CONG') {
    const version = await wf.getActiveVersion();
    const gc = await withTransaction(async (client) => {
      await kiemLaiConReleaseTx(client, [plan.map((p) => ({ dvId: p.dotVaiId, qty: p.soLuong }))], true);
      return createGiaCongLenh(client, {
        versionId: version.id, chuyenId, junctions: plan.map((p) => ({ dotVaiId: p.dotVaiId, soLuong: p.soLuong })),
        tongSL, ngayKeHoach, tgBdKh, tgKtKh, thoInKh,
      }, actorId);
    });
    await qaRepo.resolveReturnsMany('TEST_RUN', ids);
    await repo.dongSetDaReleaseHet(ids, actorId);
    sockets.emit('workflow:updated', { lenhId: gc.id, stage: 'GIA_CONG', giaCong: true });
    sockets.emit('dashboard:refresh', {});
    return { ...(await getLenhDetail(gc.id)), gia_cong: true, so_luong_release: tongSL, tho_in_chua_luu: thoInChuaLuu };
  }

  // MỌI LỆNH QUA TEST RUN (27/10/2026 — cùng luật `createRelease1`, xem đầu file).
  const diTat = false;
  const trangThai = 'RELEASE_1';

  // IN KIẾNG (điểm 16): phần in in kiếng → tạo THÊM đợt SX ép ủi (giai_doan EP_UI) ở holding CHO_IN_XONG,
  // liên kết về đợt IN; kích hoạt sang "chờ chạy" khi đợt IN "Chạy hoàn tất" (production.finishRun).
  const inKieng = plan.some((p) => byId[p.dotVaiId]?.la_in_kieng);
  const version = await wf.getActiveVersion();
  const { lenhId, epUiId } = await withTransaction(async (client) => {
    await kiemLaiConReleaseTx(client, [plan.map((p) => ({ dvId: p.dotVaiId, qty: p.soLuong }))], true); // chặn lượt song song
    const maLenh = await repo.nextMaLenhTx(client);
    const id = await repo.createLenh(client, {
      versionId: version.id, maLenh, chuyenId, soLuongRelease: tongSL, ngayKeHoach, trangThai, giaiDoan: 'IN',
      tgBdKh: tgBdKh || null, tgKtKh: tgKtKh || null, thoInKh,
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
  await repo.dongSetDaReleaseHet(ids, actorId);
  sockets.emit('workflow:updated', { lenhId, stage: trangThai });
  sockets.emit('dashboard:refresh', {});
  return { ...(await getLenhDetail(lenhId)), skipped_test: diTat, so_luong_release: tongSL, in_kieng: inKieng, ep_ui_id: epUiId, tho_in_chua_luu: thoInChuaLuu };
}

// Lịch sử Release 1 = lệnh đã tạo trong ngày + CÁC THAO TÁC KẾ HOẠCH TẠM (lập/sửa/xóa/xác nhận).
// Gộp 2 nguồn vì đứng ở màn Release 1 sẽ KHÔNG thấy đợt vải đã có kế hoạch tạm (candidate loại chúng ra)
// ⇒ không gộp thì không ai biết đợt đó "biến mất" là do có người lập kế hoạch sớm.
async function release1History(date) {
  const [rows, kht] = await Promise.all([
    repo.release1HistoryByDate(date),
    repo.keHoachTamHistoryByDate(date),
  ]);
  // ⚠ LỊCH SỬ thì GIỮ cả lệnh đã hủy (thao tác đó CÓ xảy ra) nhưng phải ghi rõ "đã hủy" — khác
  //   "Đã hoàn thành" (`release1DoneByDate`) vốn đã LOẠI hẳn lệnh hủy vì thao tác bị hoàn tác.
  const lenh = rows.map((r) => ({
    tg: r.tg,
    nguoi: r.nguoi || '—',
    hanh_dong: r.da_huy ? 'Release 1 (đã hủy)' : 'Release 1',
    doi_tuong: r.ma_lenh || '',
    chi_tiet: [r.ma_phan, r.mau_vai, r.ma_dot_vai].filter(Boolean).join(' · ')
      + (r.ten_chuyen ? ` → ${r.ten_chuyen}` : '')
      + (r.da_huy ? ' · ĐÃ HỦY LỆNH' : ''),
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

// ⚠⚠ TỪ 15/08/2026 KHÔNG CÒN NÚT NÀO GỌI HÀM NÀY. Màn Release 1 đã bỏ dòng SET (đợt vải trong set
// hiện thành dòng lẻ, release riêng) nên đường "release cả set thành 1 lệnh chung" không còn lối vào.
// GIỮ LẠI hàm + route: (a) đây là code đang chạy ổn định, gỡ đi là rủi ro thừa; (b) nếu sau này muốn
// bật lại lối in chung (chọn nhiều dòng cùng set → hỏi "chung 1 lệnh hay tách riêng?") thì dùng ngay.
// ⚠ ĐỪNG nối lại vào `confirmKeHoachTam` — chính nhánh đó đẻ ra lỗi `SET_NOT_READY` chặn phần in
//   đã Ready phải chờ cả set.
async function releaseSet(setId, { chuyenId, soLuongRelease, ngayKeHoach, tgBdKh, tgKtKh }, actorId) {
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
      tgBdKh: tgBdKh || null, tgKtKh: tgKtKh || null,
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

// Gắn `phan_in_list` (danh sách phần in) cho các lệnh GOM SET ở những màn mức LỆNH.
// ⚠⚠ BẮT BUỘC vì `PHAN_INFO_LATERAL` chỉ `LIMIT 1` ⇒ hàng chỉ mang phần in ĐẠI DIỆN:
//   (a) tìm ra lệnh nhưng cột Code phần hiện phần in KHÁC cái vừa gõ (lỗi thật 14/08/2026);
//   (b) bộ lọc client so `r.ma_phan` sẽ LÀM MẤT CẢ LỆNH khi lọc theo phần in thứ hai.
// ⚠ CHỈ gắn cho lệnh >1 phần in (`so_phan_in`) — lệnh thường giữ nguyên hình dạng dữ liệu cũ,
//   FE không phải sửa gì. 1 QUERY GỘP cho cả danh sách (N+1 làm IPS reset).
async function attachPhanInList(rows, idKey = 'id') {
  const ids = (rows || []).filter((r) => Number(r.so_phan_in) > 1).map((r) => r[idKey]);
  if (!ids.length) return rows || [];
  const all = await repo.phanInRowsByLenh(ids);
  const byLenh = {};
  for (const p of all) (byLenh[p.lenh_san_xuat_id] ||= []).push(p);
  return rows.map((r) => (byLenh[r[idKey]] ? { ...r, phan_in_list: byLenh[r[idKey]] } : r));
}

// ----- TEST RUN -----
async function listTestRunCandidates({ search, page, limit, offset }) {
  const { byMa } = await loadTestConfig();
  const { rows, total } = await repo.listTestRunCandidates({ cnspId: byMa[CNSP_CP].id, qaId: byMa[QA_CP].id, search, offset, limit });
  // Lệnh đang CHỜ KỸ THUẬT (đã bị QA trả về READY, `cho_ky_thuat` từ repo): gắn lý do + mục rớt để FE
  // hiện badge "Chờ kỹ thuật làm lại". Lấy theo đợt vải của lệnh (qc_tra_ve loai='TEST_RUN').
  //
  // ⚠⚠ GỘP QUERY, KHÔNG PHẢI N+1 (19/08/2026): bản cũ gọi `tracking.dotVaiFromLenh` cho TỪNG lệnh —
  //   đo prod 24 lệnh chờ kỹ thuật = 24 lượt gọi DB cho một lần mở màn. Nay 1 query gộp.
  const choKt = rows.filter((r) => r.cho_ky_thuat);

  // ⚠ 2 query ĐỘC LẬP ⇒ chạy chồng thời gian. `activeReturnsMap` KHÔNG vào đây được vì nó cần
  //   danh sách đợt vải do `dotVaiIdsByLenh` trả về.
  const [phanInTheoLenh, dotVaiTheoLenh] = await Promise.all([
    repo.phanInRowsByLenh(rows.filter((r) => Number(r.so_phan_in) > 1).map((r) => r.id)),
    choKt.length ? repo.dotVaiIdsByLenh(choKt.map((r) => r.id)) : {},
  ]);

  const allDv = [...new Set(Object.values(dotVaiTheoLenh).flat())];
  if (allDv.length) {
    const rm = await qaRepo.activeReturnsMap('TEST_RUN', allDv);
    choKt.forEach((r) => { r.tra_ve = (dotVaiTheoLenh[r.id] || []).map((id) => rm[id]).find(Boolean) || null; });
  }

  // ⚠⚠ GẮN `phan_in_list` PHẢI LÀ BƯỚC CUỐI: nó tạo object MỚI (`{...r, phan_in_list}`), nên mọi thứ
  //   sửa tại chỗ trên `rows` (ở đây là `r.tra_ve`) phải xong TRƯỚC — nếu không, bản sao sẽ thiếu
  //   `tra_ve` và badge "Chờ kỹ thuật làm lại" biến mất ở đúng các lệnh gom set.
  const byLenh = {};
  for (const p of phanInTheoLenh) (byLenh[p.lenh_san_xuat_id] ||= []).push(p);
  const items = rows.map((r) => (byLenh[r.id] ? { ...r, phan_in_list: byLenh[r.id] } : r));

  // ⚠⚠ `total` là TỔNG THẬT từ repo, KHÔNG phải `rows.length` (số dòng của trang). Dùng `rows.length`
  //   thì FE không bao giờ biết còn trang nữa — đúng lỗi khiến màn này chỉ hiện 200/658 lệnh.
  return { items, meta: buildMeta(page, limit, total) };
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

// Owner được phép "cho IN" khi test không đạt — chốt theo TÀI KHOẢN (người dùng chỉ định).
// Thêm/bớt người = sửa mảng này, không cần migration.
const OWNER_CHO_IN_USERNAMES = ['011000052', '021000052'];

async function listOwnerChoIn() {
  return repo.usersByUsernames(OWNER_CHO_IN_USERNAMES);
}

// Kiểm dữ liệu "In không đạt": owner CHỈ được là owner trong danh sách; lý do tùy chọn.
// Ô tích "KHÁC" (18/10/2026, người dùng yêu cầu): `nguoiKhac` = người khác cho IN (chuỗi tên ngăn dấu phẩy — chọn tài
//   khoản hoặc gõ tên ngoài danh sách) · `lyDoKhac` = lý do khác. Phải có ≥1 trong: owner · người khác · lý do khác.
//   Người khác ghi chung vào `owner_ten` (hiện "… cho IN" như owner); lý do khác nối vào lý do ("Khác: …").
const TOI_DA_KHAC = 300;
async function chuanHoaInKhongDat(raw = {}) {
  const ids = [...new Set((Array.isArray(raw.ownerIds) ? raw.ownerIds : []).map(String).filter(Boolean))];
  const nguoiKhac = [...new Set(String(raw.nguoiKhac || '').split(',').map((s) => s.trim()).filter(Boolean))];
  const lyDoKhac = String(raw.lyDoKhac || '').trim();
  if (nguoiKhac.join(', ').length > TOI_DA_KHAC || lyDoKhac.length > TOI_DA_KHAC) {
    throw new AppError(`Người khác / lý do khác tối đa ${TOI_DA_KHAC} ký tự`, { status: 422, errorCode: 'KHAC_QUA_DAI' });
  }
  if (!ids.length && !nguoiKhac.length && !lyDoKhac) {
    throw new AppError('Chọn ít nhất 1 owner cho IN, hoặc tích "Khác" để nhập người khác / lý do khác', { status: 422, errorCode: 'NO_OWNER_CHO_IN' });
  }
  const hopLe = ids.length ? await listOwnerChoIn() : [];
  const owners = hopLe.filter((u) => ids.includes(String(u.id)));
  if (owners.length !== ids.length) {
    throw new AppError('Owner cho IN không hợp lệ', { status: 422, errorCode: 'OWNER_CHO_IN_KHONG_HOP_LE' });
  }
  const lyDo = [String(raw.lyDo || '').trim(), lyDoKhac ? `Khác: ${lyDoKhac}` : ''].filter(Boolean).join(' · ') || null;
  return { owners, nguoiKhac, lyDoKhac: lyDoKhac || null, lyDo, ten: [...owners.map((o) => o.ho_ten), ...nguoiKhac] };
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
    let ghiChu = (extra.ghiChu || '').toString().trim() || null;
    const ghiChuGoc = ghiChu;
    // "XÁC NHẬN IN KHÔNG ĐẠT": đi y như xác nhận đạt, chỉ khác lần test ghi KHONG_DAT_CHO_IN + owner cho in.
    const ikd = extra.inKhongDat ? await chuanHoaInKhongDat(extra.inKhongDat) : null;
    if (ikd && st.qa_done) throw new AppError('QA đã xác nhận lệnh này', { status: 409, errorCode: 'ALREADY' });
    if (ikd) {
      const tomTat = `In không đạt — ${ikd.ten.length ? `${ikd.ten.join(', ')} ` : ''}cho IN${ikd.lyDo ? `: ${ikd.lyDo}` : ''}`;
      ghiChu = ghiChu ? `${tomTat} · ${ghiChu}` : tomTat;
    }
    await withTransaction(async (client) => {
      const kqCnsp = await repo.upsertLenhResult(client, {
        lenhId, checkpointId: byMa[CNSP_CP].id, trangThai: 'DAT', giaTriText: nguoiTest, nguoiXacNhanId: actorId, actorId,
      });
      await repo.insertStatusLog(client, { ketQuaId: kqCnsp, trangThaiMoiId: datId, nguoiId: actorId, lyDo: `CNSP (người test: ${nguoiTest || '—'})` });
      const kqQa = await repo.upsertLenhResult(client, {
        lenhId, checkpointId: byMa[QA_CP].id, trangThai: 'DAT', giaTriText: loaiTest, ghiChu, nguoiXacNhanId: actorId, actorId,
      });
      await repo.insertStatusLog(client, { ketQuaId: kqQa, trangThaiMoiId: datId, nguoiId: actorId, lyDo: `QA xác nhận test (${loaiTest})` });
      if (ikd) {
        const tr = await repo.insertTestRunTx(client, lenhId,
          // ⚠ LỖI của lần test = lý do + ghi chú QA (30/09/2026): QA hay gõ lỗi vào ô ghi chú chung
          //   (vd "Mặt in nhăn, sần") mà trước đây chỉ vào kết quả QA ⇒ cột "Lần test" không biết lỗi gì.
          { soLuong: extra.soLuong ?? null, ketQua: repo.KET_QUA_IN_KHONG_DAT,
            ghiChu: [ikd.lyDo, ghiChuGoc].filter(Boolean).join(' · ') || null }, actorId);
        await repo.logInKhongDatTx(client, tr.id, {
          lenh_san_xuat_id: lenhId, lan_test: tr.lan_test, ly_do: ikd.lyDo,
          owner_ids: ikd.owners.map((o) => o.id),
          owner_ten: ikd.ten,
          owner_username: ikd.owners.map((o) => o.ten_dang_nhap),
          nguoi_khac: ikd.nguoiKhac, ly_do_khac: ikd.lyDoKhac,
        }, actorId);
      } else if (recordPass) {
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
  // ⚠ NGOÀI GIỜ HÀNH CHÍNH (25/10/2026, người dùng chốt): nút QA đạt / In không đạt kiêm Release 2 ⇒ lệnh vào
  //   chờ sản xuất ngay (không đợi Kế hoạch duyệt). Giờ do SERVER quyết (`utils/gioHanhChinh.js`); trong giờ ⇒
  //   như cũ, cờ bị bỏ qua. Xác nhận test ĐÃ ghi xong ở trên — duyệt R2 lỗi (vd phần in vừa bị trả về GN) thì
  //   KHÔNG hoàn tác test, chỉ báo lại để Kế hoạch duyệt tay.
  let release2 = null;
  if (which === 'qa' && extra.release2 && !trongGioHanhChinh()) {
    try {
      await approveRelease2(lenhId, actorId, { qaNgoaiGio: true });
      release2 = { ok: true };
    } catch (e) {
      release2 = { ok: false, loi: e.message };
    }
  }
  const detail = await getLenhDetail(lenhId);
  return release2 ? { ...detail, release2 } : detail;
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
  let release2Count = 0;
  const errors = [];
  for (const id of lenhIds) {
    try {
      const kq = await confirmTest(id, which, actorId, extra);
      okCount += 1;
      if (kq && kq.release2 && kq.release2.ok) release2Count += 1;
      else if (kq && kq.release2) errors.push({ lenhId: id, message: `Đã xác nhận test nhưng chưa Release 2: ${kq.release2.loi}` });
    } catch (e) {
      errors.push({ lenhId: id, message: e.message });
    }
  }
  sockets.emit('dashboard:refresh', {});
  return { okCount, release2Count, failedCount: errors.length, errors };
}

// ----- RELEASE 2 (Kế hoạch duyệt cuối) -----
async function listRelease2Candidates({ search, page, limit, offset }) {
  const { byMa } = await loadTestConfig();
  const { rows, total } = await repo.listRelease2Candidates({ cnspId: byMa[CNSP_CP].id, qaId: byMa[QA_CP].id, search, offset, limit });
  return { items: await attachPhanInList(rows), meta: buildMeta(page, limit, total) };
}

async function approveRelease2(lenhId, actorId, { qaNgoaiGio = false } = {}) {
  const { byMa } = await loadTestConfig();
  const lenh = await repo.getLenhBasic(lenhId);
  if (!lenh) throw new AppError('Lệnh sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (lenh.trang_thai === 'RELEASE_2') throw new AppError('Lệnh đã Release 2', { status: 409, errorCode: 'ALREADY' });
  await assertKhongOGn(lenhId);
  const status = await repo.getLenhTestStatus(lenhId, byMa[CNSP_CP].id, byMa[QA_CP].id);
  if (!status.cnsp_done || !status.qa_done) {
    throw new AppError('Test Run chưa đủ xác nhận CNSP và QA', { status: 409, errorCode: 'TEST_INCOMPLETE' });
  }
  await withTransaction(async (client) => {
    await repo.setLenhTrangThai(client, lenhId, 'RELEASE_2', actorId);
    await repo.logPlanChange(client, lenhId, 'RELEASE_2',
      { trang_thai: 'RELEASE_1' },
      { trang_thai: 'RELEASE_2', chuyen_id: lenh.chuyen_id || null, ngay_ke_hoach: toDateStr(lenh.ngay_ke_hoach),
        ...(qaNgoaiGio ? { qa_ngoai_gio: true } : {}) },
      actorId);
  });
  await tracking.moveByLenh(lenhId, 'RELEASE_2', actorId); // theo dõi dòng chảy
  sockets.emit('workflow:updated', { lenhId, stage: 'RELEASE_2' });
  sockets.emit('dashboard:refresh', {});
  return getLenhDetail(lenhId);
}

// "Không test run": bỏ Test Run cho 1 đợt SX (lệnh RELEASE_1) → duyệt thẳng RELEASE_2 (vào chờ sản xuất).
// ⚠⚠ 27/10/2026 (người dùng: "bấm không test run thì nhảy cộng số lượng vào phần in đang có đợt vải nếu đang sản xuất"):
//   lệnh 1 phần in mà phần in đó có lệnh ĐANG CHẠY (`repo.lenhDangChayCuaPhanIn`, ưu tiên cùng chuyền) ⇒ sau khi vào
//   RELEASE_2 gộp luôn vào lệnh đang chạy bằng CHÍNH `production.gopLenhCungPhan` (đợt + SL dồn vào lệnh đang chạy, lệnh
//   bỏ test HUY + audit `GOP_VAO_LENH`, ERP: hủy kế hoạch lệnh này + gửi lại kế hoạch lệnh đang chạy). Lệnh đang chạy ở
//   CHUYỀN KHÁC ⇒ đổi chuyền kế hoạch của lệnh bỏ test sang chuyền đó trước (gộp đòi cùng chuyền). Gộp lỗi ⇒ lệnh ở lại
//   Chờ chạy như cũ (không chặn việc bỏ test). Trả thêm `cong_vao_lenh_chay` { ma_lenh } khi đã cộng.
// 27/10/2026 (người dùng): bấm "Không test run" phải nhập LÝ DO (422 `NO_LY_DO`) — ghi ở audit `RELEASE_2.ly_do`, hiện ở
//   sidebar *Lịch sử* màn Test Run (`repo.testRunHistoryByDate` nối thêm các lượt Không test run).
async function skipTestRun(lenhId, actorId, lyDoVao = '') {
  const lyDo = String(lyDoVao || '').trim().slice(0, 500);
  if (!lyDo) throw new AppError('Nhập lý do không test run', { status: 422, errorCode: 'NO_LY_DO' });
  const lenh = await repo.getLenhBasic(lenhId);
  if (!lenh) throw new AppError('Đợt sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (lenh.trang_thai === 'RELEASE_2') throw new AppError('Đợt đã ở Release 2 (chờ sản xuất)', { status: 409, errorCode: 'ALREADY' });
  if (lenh.trang_thai !== 'RELEASE_1') throw new AppError('Chỉ bỏ Test Run khi đợt đang ở Test Run', { status: 409, errorCode: 'WRONG_STAGE' });
  await assertKhongChoKyThuat(lenhId);

  let dich = null;
  const info = await repo.phanInChuyenCuaLenh(lenhId);
  if (info && (info.phan_in_ids || []).length === 1) {
    dich = (await repo.lenhDangChayCuaPhanIn(info.phan_in_ids, info.chuyen_id, lenhId))[0] || null; // cùng nhà gia công
    if (dich && dich.id === lenhId) dich = null;
  }
  const doiChuyen = dich && dich.chuyen_id && dich.chuyen_id !== info.chuyen_id;
  await withTransaction(async (client) => {
    await repo.setLenhTrangThai(client, lenhId, 'RELEASE_2', actorId);
    if (doiChuyen) await repo.doiChuyenLenhTx(client, lenhId, dich.chuyen_id, actorId);
    await repo.logPlanChange(client, lenhId, 'RELEASE_2',
      { trang_thai: 'RELEASE_1', ...(doiChuyen ? { chuyen_id: info.chuyen_id } : {}) },
      { trang_thai: 'RELEASE_2', bo_test_run: true, ly_do: lyDo,
        ...(dich ? { cong_vao_lenh_id: dich.id, cong_vao_lenh: dich.ma_lenh_san_xuat } : {}),
        ...(doiChuyen ? { chuyen_id: dich.chuyen_id } : {}) },
      actorId);
  });
  await tracking.moveByLenh(lenhId, 'RELEASE_2', actorId);

  let congVao = null;
  if (dich) {
    try {
      const production = require('../production/production.service');
      await production.gopLenhCungPhan([lenhId, dich.id], actorId, { lyDo: `Không test run — cộng thẳng vào lệnh đang chạy: ${lyDo}` });
      await tracking.moveDotVaiTo(info.dot_vai_ids || [], 'SAN_XUAT', actorId);
      congVao = { lenh_id: dich.id, ma_lenh: dich.ma_lenh_san_xuat, tu_lenh: lenh.ma_lenh_san_xuat };
    } catch (e) {
      console.error(`[test-run] ✗ Không cộng được ${lenh.ma_lenh_san_xuat} vào lệnh đang chạy ${dich.ma_lenh_san_xuat}: ${e.message}`);
      if (doiChuyen) { // gộp không được ⇒ trả lại chuyền kế hoạch cũ
        try { await withTransaction((client) => repo.doiChuyenLenhTx(client, lenhId, info.chuyen_id, actorId)); }
        catch (e2) { console.error(`[test-run] ✗ Không trả lại chuyền cho ${lenh.ma_lenh_san_xuat}: ${e2.message}`); }
      }
    }
  }
  sockets.emit('workflow:updated', { lenhId, stage: 'RELEASE_2', skipTest: true });
  sockets.emit('dashboard:refresh', {});
  if (congVao) return { ...(await getLenhDetail(dich.id)), cong_vao_lenh_chay: congVao };
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
// Lượt test của lệnh (chưa bị gỡ) — tab Hủy lệnh sản xuất, đích TEST_RUN: người dùng chọn lượt nào GIỮ.
async function testRunsChoHuy(lenhId) {
  return repo.testRunsChoHuy(lenhId);
}

async function rollbackLenh(lenhId, { target, lyDo, force = false, boTestRunIds }, actorId) {
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

  // ─── VỀ LẠI TEST RUN (giữ lệnh, vẫn đã release) ───────────────────────────
  // ⚠⚠ PHẢI HỦY LUÔN KẾT QUẢ TEST (chốt 04/09/2026 — "có trường hợp bấm nhầm Test Run đạt").
  //   Bản cũ chỉ hạ `RELEASE_2 → RELEASE_1` mà GIỮ `TEST_CNSP`/`TEST_QA` DAT ⇒ lệnh **không quay lại
  //   màn Test Run** (`listTestRunCandidates` lọc `NOT EXISTS TEST_QA DAT`) mà rơi thẳng sang màn
  //   Release 2 chờ duyệt lại — đúng chỗ nó vừa được gỡ ra, không test lại được.
  // ⚠⚠ NHẬN CẢ LỆNH CÒN `RELEASE_1`: bấm nhầm "đạt" ở Test Run thì lệnh CHƯA đổi trạng thái (vẫn
  //   `RELEASE_1`) nhưng đã rời màn Test Run vì có `TEST_QA` DAT. Bản cũ ném NOOP đúng ca này ⇒
  //   không có đường nào sửa. Nay chỉ NOOP khi thật sự không có gì để gỡ.
  if (TARGET === 'TEST_RUN') {
    const laR2 = lenh.trang_thai === 'RELEASE_2';
    const coKqTest = await repo.coKetQuaTest(lenhId);
    // Lượt test người dùng BỎ TÍCH (22/09/2026) — chỉ nhận id dạng uuid, việc "có thuộc lệnh này không"
    // do chính câu UPDATE lọc theo `lenh_san_xuat_id` (id lạ bị bỏ qua êm, không gỡ nhầm lệnh khác).
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const boIds = [...new Set((Array.isArray(boTestRunIds) ? boTestRunIds : []).map(String).filter((x) => UUID_RE.test(x)))];
    if (!laR2 && !coKqTest && !boIds.length) {
      throw new AppError('Lệnh đang ở Test Run và chưa có kết quả test — không có gì để hoàn tác',
        { status: 409, errorCode: 'NOOP' });
    }
    let daGo = [];
    await withTransaction(async (client) => {
      if (laR2) await repo.setLenhTrangThai(client, lenhId, 'RELEASE_1', actorId);
      // Gỡ kết quả TEST_CNSP + TEST_QA ⇒ lệnh hiện lại ở màn Test Run - QA để test lại từ đầu.
      if (coKqTest) await repo.cancelTestResults(client, lenhId, actorId);
      daGo = await repo.huyTestRunsTx(client, lenhId, boIds, actorId);
      await repo.logPlanChange(client, lenhId, 'HUY_RELEASE_2',
        { trang_thai: lenh.trang_thai, co_ket_qua_test: coKqTest },
        { trang_thai: 'RELEASE_1', huy_ket_qua_test: coKqTest, ly_do: (lyDo || '').trim() || null,
          go_lan_test: daGo.map((r) => ({ id: r.id, lan_test: r.lan_test, ket_qua_cu: r.ket_qua_cu })) }, actorId);
    });
    await tracking.revertToTram(dotVaiIds, 'TEST_RUN', actorId);
    sockets.emit('workflow:updated', { lenhId, stage: 'RELEASE_1' });
    sockets.emit('dashboard:refresh', {});
    return { id: lenhId, target: TARGET, dot_vai: dotVaiIds.length, huy_ket_qua_test: coKqTest, so_lan_test_go: daGo.length };
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
  // Báo ERP hủy kế hoạch lệnh đã gửi (`MES_spr_MES21X0_Huy`, 18/10/2026) — NGẦM, không chặn việc hủy.
  release1Erp.baoHuyLenhNgam([lenhId], actorId, lyDo);
  sockets.emit('workflow:updated', { lenhId, stage: 'HUY' });
  sockets.emit('dashboard:refresh', {});
  return {
    id: lenhId, target: TARGET, dot_vai: dotVaiIds.length, tu_set: lenh.tu_set === true,
    force: !!force, trang_thai_cu: lenh.trang_thai, so_tem_huy: force ? (lenh.so_tem || 0) : 0,
  };
}

// ─── TAB "HỦY TEST RUN" (02/10/2026): gỡ 1 LƯỢT TEST xác nhận nhầm phần in ──────────────────────
// · Lượt đang ĐỨNG SAU kết quả đạt (`dang_hieu_luc`) ⇒ gỡ kết quả TEST_CNSP/TEST_QA + hạ RELEASE_2 → RELEASE_1
//   ⇒ lệnh QUAY LẠI màn Test Run. Gọi lại `rollbackLenh` đích TEST_RUN (một luật, không chép).
// · Lượt khác (test lỗi, lượt đạt cũ) ⇒ chỉ đánh dấu `test_run.ket_qua='HUY'` (không còn hiện ở cột "Lần test",
//   Excel, dataset báo cáo), lệnh đứng yên.
// Chỉ lệnh chưa vào sản xuất — đã có phiếu thì phải hủy chạy trước (tab "Hủy lệnh đang chạy").
async function listLanTestChoHuy({ search, page, limit, offset }) {
  const { rows, total } = await repo.listLanTestChoHuy({ search, offset, limit });
  return { items: rows, meta: buildMeta(page, limit, total) };
}

async function huyLanTest(testRunId, { lyDo } = {}, actorId) {
  const reason = String(lyDo || '').trim();
  if (!reason) throw new AppError('Nhập lý do hủy lần test', { status: 422, errorCode: 'NO_LY_DO' });
  const tr = await repo.getLanTestForHuy(testRunId);
  if (!tr) throw new AppError('Lần test không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (tr.ket_qua === 'HUY') throw new AppError('Lần test này đã được hủy', { status: 409, errorCode: 'ALREADY' });
  if (tr.co_phieu || !['RELEASE_1', 'RELEASE_2'].includes(tr.trang_thai)) {
    throw new AppError('Lệnh đã vào sản xuất / đã hủy — không hủy lần test được', { status: 409, errorCode: 'WRONG_STAGE' });
  }
  const ghiChu = `Hủy lần test (xác nhận nhầm): ${reason}`;
  if (tr.dang_hieu_luc) {
    const r = await rollbackLenh(tr.lenh_san_xuat_id,
      { target: 'TEST_RUN', lyDo: `[Hủy lần test ${tr.lan_test}] ${reason}`, boTestRunIds: [tr.id] }, actorId);
    return { ...r, lan_test: tr.lan_test, ma_lenh: tr.ma_lenh_san_xuat, ve_test_run: true };
  }
  await withTransaction(async (client) => {
    const daGo = await repo.huyTestRunsTx(client, tr.lenh_san_xuat_id, [tr.id], actorId, ghiChu);
    if (!daGo.length) throw new AppError('Lần test này đã được hủy', { status: 409, errorCode: 'ALREADY' });
    await repo.logPlanChange(client, tr.lenh_san_xuat_id, 'HUY_LAN_TEST',
      { test_run_id: tr.id, lan_test: tr.lan_test, ket_qua: tr.ket_qua },
      { ket_qua: 'HUY', ly_do: reason, ma_lenh: tr.ma_lenh_san_xuat }, actorId);
  });
  sockets.emit('workflow:updated', { lenhId: tr.lenh_san_xuat_id, stage: 'TEST_RUN' });
  sockets.emit('dashboard:refresh', {});
  return { id: tr.lenh_san_xuat_id, lan_test: tr.lan_test, ma_lenh: tr.ma_lenh_san_xuat, ve_test_run: false };
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

// `loai` = LÝ DO trả về, quyết định lệnh có được GIỮ hay không (chốt 15/08/2026):
//   · `TEST_LOI` (mặc định) — test run lỗi: **GIỮ lệnh** ⇒ QC xác nhận READY xong là đợt vải nhảy
//     THẲNG lại Test Run, Kế hoạch không phải Release 1 lần nữa. (Hành vi cũ, không đổi.)
//   · `DOI_PA_IN` — đổi phương án in: **HỦY lệnh** ⇒ đợt vải rơi về pool Release 1 để Kế hoạch
//     **release lại từ đầu**. Bắt buộc phải hủy: đổi phương án in là đổi chuyền/cách in, mà lệnh cũ
//     đã chốt chuyền — giữ lệnh thì hàng quay lại đúng cái chuyền vừa bị chê.
const LOAI_TRA_VE = new Set(['TEST_LOI', 'DOI_PA_IN']);

// `nguon` (25/10/2026): 'RELEASE2' = Kế hoạch trả về Kỹ thuật ngay ở màn Release 2 (lệnh đã test xong, chờ duyệt).
//   Cùng luật với Test Run trả về (giữ lệnh, hủy kết quả test + QC ⇒ KT làm lại xong lệnh tự về Test Run, phải
//   test lại) — chỉ khác lý do mang tiền tố "Release 2:" + audit `TRA_VE_KY_THUAT_RELEASE_2`.
async function returnTestRunToReady(lenhId, { checklists, lyDo, loai, nguon }, actorId) {
  const tuRelease2 = nguon === 'RELEASE2';
  const reasonGoc = (lyDo || '').trim();
  const reason = tuRelease2 && reasonGoc ? `Release 2: ${reasonGoc}` : reasonGoc;
  if (!reason) throw new AppError('Nhập lý do trả về Kỹ thuật', { status: 422, errorCode: 'NO_LY_DO' });
  const kieu = LOAI_TRA_VE.has(loai) ? loai : 'TEST_LOI';
  const doiPaIn = kieu === 'DOI_PA_IN';
  // ⚠⚠ ĐỔI PHƯƠNG ÁN IN ⇒ HỦY **CẢ 3 MỤC** Khuôn/Film/Mực, KHÔNG phụ thuộc người dùng tick gì
  //   (chốt 15/08/2026). Đổi phương án in là đổi hẳn cách in (Bàn ↔ Máy ↔ Robot) nên khuôn/film/mực
  //   phải làm lại từ đầu ⇒ phần in phải quay về **READY (Kỹ thuật)**.
  //   ⚠ Bản đầu chỉ hủy QC nên phần in dừng ở **READY (QA)**: 3 mục KT vẫn còn `DAT` nên `tech_done`
  //     vẫn TRUE, QC chỉ việc bấm duyệt lại — kỹ thuật KHÔNG hề làm lại gì. Đó là lỗi, không phải
  //     lựa chọn; đừng "tối ưu" về lại kiểu cũ.
  const chosen = doiPaIn ? TECH_ITEMS.slice() : normalizeTechItems(checklists);
  // Test run lỗi thì vẫn BẮT BUỘC chọn mục (phải biết mục nào rớt để chỉ làm lại đúng mục đó).
  if (!doiPaIn && chosen.length === 0) {
    throw new AppError('Chọn ít nhất 1 mục không đạt (Khuôn / Film / Mực)', { status: 422, errorCode: 'NO_ITEM' });
  }
  const lenh = await repo.getLenhBasic(lenhId);
  if (!lenh) throw new AppError('Lệnh sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (lenh.trang_thai !== 'RELEASE_1') {
    throw new AppError(tuRelease2 ? 'Lệnh đã duyệt Release 2 — trả về Kỹ thuật ở màn Xác nhận chạy'
      : 'Chỉ trả về Kỹ thuật khi lệnh đang ở Test Run', { status: 409, errorCode: 'WRONG_STAGE' });
  }
  const info = await repo.lenhChoKyThuat(lenhId);
  if (tuRelease2 && info && (info.cho_ky_thuat || info.cho_gn || info.cho_ke_hoach)) {
    throw new AppError('Lệnh không ở màn Release 2 (đang chờ Kỹ thuật / Giao nhận / Kế hoạch)', { status: 409, errorCode: 'WRONG_STAGE' });
  }
  if (info && info.co_phieu) {
    throw new AppError('Lệnh đã bắt đầu sản xuất (đã in tem) — không trả về Kỹ thuật được', { status: 409, errorCode: 'HAS_PHIEU' });
  }
  const dotVaiIds = await tracking.dotVaiFromLenh(lenhId);
  const pinIds = await repo.phanInIdsByLenh(lenhId);

  await withTransaction(async (client) => {
    await repo.cancelTestResults(client, lenhId, actorId);                        // phải test lại
    // ⚠⚠⚠ TEST LỖI: **GIỮ NGUYÊN xác nhận Khuôn/Film/Mực**, chỉ hủy QC (người dùng chốt 16/09/2026).
    //   Mục rớt vẫn được GHI vào `qc_tra_ve.checklist_list` nên badge ở READY/QC READY vẫn nêu đúng
    //   mục nào không đạt — chỉ là hệ thống không tự bỏ tích nữa, để 2 sidebar *Lịch sử* +
    //   *Đã hoàn thành* giữ được dấu ai đã xác nhận. Đánh đổi (QC duyệt lại được ngay mà kỹ thuật
    //   không phải thao tác) đã báo và người dùng chấp nhận — xem `erpsync.chiHuyQcReady`.
    // ⚠⚠ NGOẠI LỆ **ĐỔI PHƯƠNG ÁN IN**: VẪN hủy cả 3 mục. Đổi Bàn ↔ Máy ↔ Robot là đổi hẳn cách in
    //   nên khuôn/film/mực CŨ không dùng được về mặt VẬT LÝ — giữ lại là nói dối "đã có khuôn" cho
    //   một phương án in khác hẳn. Đây là hành động khác bản chất với "test lỗi" (nó còn hủy cả lệnh).
    if (doiPaIn && chosen.length) await repo.cancelReadyItemsByPhanIn(client, pinIds, chosen, actorId);
    await repo.cancelReadyQcForDotVai(client, dotVaiIds, actorId);                // QC phải duyệt lại
    // ĐỔI PHƯƠNG ÁN IN → HỦY LỆNH trong CÙNG transaction ⇒ đợt vải quay về pool Release 1.
    // ⚠ Đã chặn `co_phieu` ở trên nên chắc chắn chưa in tem — không phải dọn tem/phiếu.
    // ⚠ `cancelLenhOrder` cũng lo luôn việc mở lại gom set nếu đợt vải thuộc set đã đóng.
    if (doiPaIn) await repo.cancelLenhOrder(client, lenhId, actorId);
  });
  // Đổi phương án in đã HỦY lệnh ⇒ báo ERP hủy kế hoạch lệnh (18/10/2026, ngầm).
  if (doiPaIn) release1Erp.baoHuyLenhNgam([lenhId], actorId, reason);

  const checklistList = chosen.join(',');
  // 2 loại: TEST_RUN_KT (mức phần in) → badge ở READY/QC READY · TEST_RUN (mức đợt vải) → Lịch sử QC trả về
  // + badge "Chờ kỹ thuật làm lại" ở màn Test Run.
  for (const pinId of pinIds) {
    await qaRepo.insertQcTraVe({ loai: 'TEST_RUN_KT', phanInId: pinId, lenhId, checklistList, lyDo: reason }, actorId);
    thongBao.banThongBao({ loaiTraVe: 'TEST_RUN_KT', phanInId: pinId, actorId }); // chuông Kỹ thuật (mig 085)
  }
  for (const dvId of dotVaiIds) {
    await qaRepo.insertQcTraVe({ loai: 'TEST_RUN', dotVaiId: dvId, lenhId, checklistList, lyDo: reason }, actorId);
  }
  await repo.logPlanChange(null, lenhId, tuRelease2 ? 'TRA_VE_KY_THUAT_RELEASE_2' : 'TRA_VE_KY_THUAT_TEST_RUN',
    { trang_thai: 'RELEASE_1' },
    { ma_lenh: lenh.ma_lenh_san_xuat, checklists: chosen, ly_do: reason, loai: kieu, giu_lenh: !doiPaIn,
      nguon: tuRelease2 ? 'RELEASE2' : 'TEST_RUN' }, actorId);
  await tracking.moveDotVaiTo(dotVaiIds, 'READY', actorId);
  sockets.emit('workflow:updated', { lenhId, stage: 'READY', traVe: true });
  // Đổi phương án in ⇒ đợt vải quay lại màn Release 1 ⇒ báo cho màn đó tải lại ngầm.
  if (doiPaIn) sockets.emit('ready:confirmed', { traVe: true });
  sockets.emit('dashboard:refresh', {});
  return {
    lenh_id: lenhId, dot_vai: dotVaiIds.length, phan_in: pinIds.length,
    checklists: chosen, loai: kieu, huy_lenh: doiPaIn,
  };
}

// Chặn mọi thao tác test khi lệnh đang chờ kỹ thuật làm lại (đã bị QA trả về READY)
// hoặc có phần in đang ở Giao nhận (trả về GN — 06/10/2026).
async function assertKhongChoKyThuat(lenhId) {
  const info = await repo.lenhChoKyThuat(lenhId);
  if (info && info.cho_ky_thuat) {
    throw new AppError('Lệnh đang chờ kỹ thuật làm lại (READY) — chưa test được',
      { status: 409, errorCode: 'CHO_KY_THUAT' });
  }
  if (info && info.cho_gn) throw loiDangOGn();
  if (info && info.cho_ke_hoach) throw loiChoKeHoach();
}

// ─── TEST RUN TRẢ VỀ KẾ HOẠCH (RELEASE 1) — GIỮ LỆNH (07/10/2026, `utils/traVeKeHoach.js`) ──────────────
// KHÁC `returnTestRunToReady` (về Kỹ thuật) và `DOI_PA_IN` (hủy lệnh): ở đây KHÔNG đụng lệnh, KHÔNG hủy kết quả
// test / KT / QC — chỉ gắn cờ TEST_RUN_KH (+ chuông cho Kế hoạch). Lệnh tạm rời Test Run, hiện ở khối "Test
// Run trả về" màn Release 1; Kế hoạch "Xác nhận Release 1" (`xacNhanLaiTestRunTraVe`) ⇒ quay lại Test Run.
const loiChoKeHoach = () => new AppError('Lệnh đang được trả về Kế hoạch — chờ Kế hoạch xác nhận lại Release 1',
  { status: 409, errorCode: 'CHO_KE_HOACH' });

async function traVeKeHoachTuTestRun(lenhId, { lyDo } = {}, actorId) {
  const reason = (lyDo || '').trim();
  if (!reason) throw new AppError('Nhập lý do trả về Kế hoạch', { status: 422, errorCode: 'NO_LY_DO' });
  const lenh = await repo.getLenhBasic(lenhId);
  if (!lenh) throw new AppError('Lệnh sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (lenh.trang_thai !== 'RELEASE_1') {
    throw new AppError('Chỉ trả về Kế hoạch khi lệnh đang ở Test Run', { status: 409, errorCode: 'WRONG_STAGE' });
  }
  // ⚠ Guard chạy TRƯỚC mọi thao tác ghi; đủ các ca lệnh KHÔNG còn nằm ở hàng đợi Test Run.
  const info = (await repo.lenhChoKyThuat(lenhId)) || {};
  if (info.co_phieu) throw new AppError('Lệnh đã bắt đầu sản xuất — không trả về Kế hoạch được', { status: 409, errorCode: 'HAS_PHIEU' });
  if (info.qa_dat) throw new AppError('QA đã xác nhận Test Run — lệnh đang chờ Kế hoạch duyệt Release 2', { status: 409, errorCode: 'DA_TEST_DAT' });
  if (info.cho_ke_hoach) throw loiChoKeHoach();
  if (info.cho_ky_thuat) throw new AppError('Lệnh đang chờ kỹ thuật làm lại (READY)', { status: 409, errorCode: 'CHO_KY_THUAT' });
  if (info.cho_gn) throw loiDangOGn();

  const dots = await repo.dotPhanInCuaLenh(lenhId);
  if (!dots.length) throw new AppError('Lệnh không có đợt vải', { status: 409, errorCode: 'EMPTY' });
  for (const d of dots) {
    await qaRepo.insertQcTraVe({ loai: LOAI_TRA_VE_KH, phanInId: d.phan_in_id, dotVaiId: d.dot_vai_id, lenhId, lyDo: reason }, actorId);
  }
  await repo.logPlanChange(null, lenhId, 'TRA_VE_KE_HOACH_TEST_RUN',
    { trang_thai: 'RELEASE_1' }, { ma_lenh: lenh.ma_lenh_san_xuat, ly_do: reason, giu_lenh: true }, actorId);
  // Chuông cho Kế hoạch — 1 lần / phần in. ⚠ KHÔNG `await` (Web Push có thể chậm), hàm tự nuốt lỗi.
  [...new Set(dots.map((d) => d.phan_in_id))].forEach((pinId) => {
    thongBao.banThongBao({ loaiTraVe: LOAI_TRA_VE_KH, phanInId: pinId, actorId });
  });
  sockets.emit('workflow:updated', { lenhId, stage: 'RELEASE_1', traVe: true });
  sockets.emit('ready:confirmed', { traVe: true }); // màn Release 1 nghe sự kiện này để tải lại ngầm
  sockets.emit('dashboard:refresh', {});
  return { lenh_id: lenhId, ma_lenh: lenh.ma_lenh_san_xuat, dot_vai: dots.length };
}

// Khối "Test Run trả về" của màn Release 1 — kèm `tra_ve` (khuôn `TraVeBadge`).
async function listTestRunTraVeKh() {
  const rows = await repo.listLenhTraVeKh();
  return rows.map((r) => ({
    ...r,
    _key: `${r.lenh_id}|${r.dot_vai_id}`,
    tra_ve: { ly_do: r.tra_ve_ly_do, tg: r.tra_ve_tg, nguoi: r.tra_ve_nguoi, so_lan: r.tra_ve_so_lan || 1 },
  }));
}

// Kế hoạch XÁC NHẬN LẠI Release 1 cho lệnh bị Test Run trả về ⇒ gỡ cờ ⇒ Test Run.
// ⚠⚠ LUÔN = MỘT LẦN "LẬP LẠI KẾ HOẠCH" (08/10/2026, người dùng chốt — trước đó chỉ đi `replan` khi KHÁC kế hoạch
//   cũ, giữ nguyên thì không báo ERP): gọi `replan` kể cả khi chuyền / ngày / giờ / thợ in không đổi ⇒ audit
//   `REPLAN` (hiện ở sidebar Đã hoàn thành màn Lập lại kế hoạch) + gửi ERP `ERP_GUI_RELEASE_1` (Nguon REPLAN) +
//   đổi chặng nếu chuyển sang chuyền gia công. Thợ in đi chung `replan` (không gửi = giữ, rỗng = xóa).
// ⚠ Giờ FE gửi dạng `YYYY-MM-DDTHH:MM:00` (y như Release 1); bỏ trống = giữ giờ cũ (luật `replan`).
async function xacNhanLaiTestRunTraVe(lenhId, { chuyenId, ngayKeHoach, tgBdKh, tgKtKh, thoIn } = {}, actorId) {
  const lenh = await repo.getLenhForReplan(lenhId);
  if (!lenh) throw new AppError('Lệnh sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const info = (await repo.lenhChoKyThuat(lenhId)) || {};
  if (lenh.trang_thai !== 'RELEASE_1' || lenh.co_phieu || !info.cho_ke_hoach) {
    throw new AppError('Lệnh không còn chờ Kế hoạch xác nhận lại', { status: 409, errorCode: 'KHONG_CHO_KH' });
  }
  if (info.cho_gn) throw loiDangOGn();

  const gioGui = (v) => (v ? String(v).slice(11, 16) : null);
  const ngayMoi = ngayKeHoach ? toDateStr(ngayKeHoach) : toDateStr(lenh.ngay_ke_hoach);
  const doiKeHoach = (!!chuyenId && chuyenId !== lenh.chuyen_id)
    || (!!ngayKeHoach && toDateStr(ngayKeHoach) !== toDateStr(lenh.ngay_ke_hoach))
    || (!!tgBdKh && gioGui(tgBdKh) !== gioCua(lenh.tg_bd_kh))
    || (!!tgKtKh && gioGui(tgKtKh) !== gioCua(lenh.tg_kt_kh));
  const kq = await replan(lenhId, {
    chuyenId: chuyenId || lenh.chuyen_id, ngayKeHoach: ngayMoi, tgBdKh: tgBdKh || null, tgKtKh: tgKtKh || null,
    thoIn, lyDo: 'Xác nhận lại Release 1 sau khi Test Run trả về Kế hoạch',
  }, actorId);
  const thoInChuaLuu = !!kq.tho_in_chua_luu && !!chuanHoaThoIn(thoIn);
  await qaRepo.resolveReturns(LOAI_TRA_VE_KH, lenhId);
  await repo.logPlanChange(null, lenhId, 'XAC_NHAN_LAI_RELEASE_1',
    { trang_thai: lenh.trang_thai }, { ma_lenh: lenh.ma_lenh_san_xuat, doi_ke_hoach: doiKeHoach, nguon: LOAI_TRA_VE_KH }, actorId);
  sockets.emit('workflow:updated', { lenhId, stage: kq.trang_thai || 'TEST_RUN' });
  sockets.emit('dashboard:refresh', {});
  return {
    lenh_id: lenhId, ma_lenh: lenh.ma_lenh_san_xuat, doi_ke_hoach: doiKeHoach,
    trang_thai: kq.trang_thai || lenh.trang_thai, tho_in_chua_luu: thoInChuaLuu,
  };
}

// Lệnh có phần in đang ở Giao nhận ⇒ khóa test / duyệt Release 2 / xác nhận chạy tới khi GN "Xác nhận lại"
// (`utils/traVeGn.js`). Production gọi lại hàm này — đừng chép điều kiện sang chỗ khác.
const loiDangOGn = () => new AppError('Phần in của lệnh đang chờ Giao nhận sửa thông tin — chờ GN xác nhận lại',
  { status: 409, errorCode: 'DANG_O_GN' });
async function assertKhongOGn(lenhId) {
  const info = await repo.lenhChoKyThuat(lenhId);
  if (info && info.cho_gn) throw loiDangOGn();
}

// ----- LẬP KẾ HOẠCH LẠI -----
// `loc` = bộ lọc từng trường (khóa như FILTER_FIELDS của ReplanPage) · `tuNgay`/`denNgay` = ngày SX KH.
// Lọc + phân trang Ở SERVER (30/09/2026) — xem ghi chú `planning.repository.replanWhere`.
async function listReplanCandidates({ search, page, limit, offset, loc, tuNgay, denNgay }) {
  const { rows, total } = await repo.listReplanCandidates({ search, offset, limit, loc, tuNgay, denNgay });
  // Nhãn tiếng Việt của giai đoạn ĐANG Ở (dùng chung `STAGE_LABEL` với dashboard/Đơn hàng/Danh sách
  // release). Trước 04/09/2026 FE tự suy từ `trang_thai` nên `RELEASE_1` luôn hiện "Test Run" — kể cả
  // lệnh đã test xong (thực tế đang chờ duyệt Release 2) hay lệnh bị QA trả về Kỹ thuật (đang ở READY).
  const items = rows.map((r) => ({
    ...r, giai_doan_ten: STAGE_LABEL[r.giai_doan_hien_tai] || r.giai_doan_hien_tai || '—',
  }));
  return { items: await attachPhanInList(items), meta: buildMeta(page, limit, total) };
}

// ----- KẾ HOẠCH TẠM (mig 058): màn Kế hoạch xác nhận lại Release 1 khi phần in Ready xong -----
async function listKeHoachTam({ search, page, limit, offset }) {
  const { rows, total } = await repo.listKeHoachTamRows({ search, offset, limit });
  return { items: rows, meta: buildMeta(page, limit, total) };
}

// KẾ HOẠCH TẠM CHO CẢ GOM SET — ghi kế hoạch tạm cho MỌI đợt vải trong set.
// ⚠⚠ TỪ 15/08/2026 KHÔNG CÒN NÚT NÀO GỌI HÀM NÀY (màn Release 1 bỏ dòng SET; mỗi đợt vải tự lập kế
// hoạch tạm riêng qua `createRelease1`). Đây chính là hành vi người dùng phản ánh: "làm kế hoạch cho
// 1 phần thì mấy phần gom set kia dính kế hoạch luôn". GIỮ hàm + route như `releaseSet` — xem ghi chú ở đó.
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

  // ⚠⚠ ĐÃ GỠ NHÁNH "RELEASE CẢ SET" (15/08/2026 — cùng đợt với việc cho release LẺ ở Release 1).
  // Trước đây: đợt thuộc gom set đang MỞ thì `confirmKeHoachTam` gọi `releaseSet` để ra 1 lệnh chung,
  // và chặn `SET_NOT_READY` nếu còn member chưa Ready ⇒ **phần in đã Ready không đi được, phải chờ
  // cả set** (ca thật SET0184: C02/C03 đã Ready vẫn kẹt vì C01 chưa xong).
  // Nay xác nhận kế hoạch tạm chỉ release ĐÚNG đợt vải của dòng đó, y như đợt vải lẻ; set tự đóng
  // khi member cuối cùng được release (`repo.dongSetDaReleaseHet` trong `createRelease1`).
  // Đợt ĐÃ được release ở đường khác (dữ liệu cũ: release theo GOM SET từ màn Release 1) mà dòng kế hoạch
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
  // Thợ in kế hoạch (mig 111) lưu ở dòng kế hoạch tạm ⇒ chép sang lệnh.
  const res = await createRelease1({
    dotVaiIds: [kt.dot_vai_ve_id], chuyenId: kt.chuyen_id,
    soLuongRelease: kt.so_luong != null ? kt.so_luong : undefined,
    ngayKeHoach: kt.ngay_ke_hoach, tgBdKh: kt.tg_bd_kh, tgKtKh: kt.tg_kt_kh, thoIn: kt.tho_in_kh,
  }, actorId, { nguonErp: 'KE_HOACH_TAM' });
  await repo.deleteKeHoachTam(id);
  await repo.logKeHoachTam('XAC_NHAN_KE_HOACH_TAM', kt.dot_vai_ve_id, {
    chuyen_id: kt.chuyen_id, ngay_ke_hoach: kt.ngay_ke_hoach, so_luong: kt.so_luong,
    ma_lenh: (res.created_summary && res.created_summary[0]?.ma_lenh_san_xuat) || res.ma_lenh_san_xuat || null,
  }, actorId);
  return { ...res, ke_hoach_tam_id: id };
}

// Sửa kế hoạch tạm — 19/10/2026 sửa được cả giờ BĐ/KT + thợ in như panel Release 1. Khóa không gửi (undefined)
//   ⇒ giữ nguyên (bên gọi cũ chỉ gửi chuyền/SL/ngày). Thợ in chuẩn hóa như `createRelease1`; rỗng = xóa.
async function updateKeHoachTam(id, { chuyenId, ngayKeHoach, soLuong, tgBdKh, tgKtKh, thoIn }, actorId) {
  const kt = await repo.getKeHoachTam(id);
  if (!kt) throw new AppError('Kế hoạch tạm không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const sl = soLuong != null && soLuong !== '' ? Number(soLuong) : null;
  if (sl != null && !(sl > 0)) throw new AppError('Số lượng release phải lớn hơn 0', { status: 422, errorCode: 'INVALID_QTY' });
  const guiGio = tgBdKh !== undefined || tgKtKh !== undefined;
  const thoMoi = thoIn !== undefined ? chuanHoaThoIn(thoIn) : undefined;
  const res = await repo.updateKeHoachTam(id, {
    chuyenId, ngayKeHoach, soLuong: sl,
    ...(guiGio ? { tgBdKh: tgBdKh || null, tgKtKh: tgKtKh || null } : {}),
    thoInKh: thoMoi,
  }, actorId);
  if (!res) throw new AppError('Không cập nhật được kế hoạch tạm', { status: 409, errorCode: 'UPDATE_FAILED' });
  const thoInChuaLuu = !!thoMoi && !(await coCotThoInKh());
  await repo.logKeHoachTam('SUA_KE_HOACH_TAM', kt.dot_vai_ve_id, {
    chuyen_id: chuyenId || null, ngay_ke_hoach: ngayKeHoach || null, so_luong: sl,
    ...(guiGio ? { gio_bd: gioCua(tgBdKh), gio_kt: gioCua(tgKtKh) } : {}),
    ...(thoMoi !== undefined && !thoInChuaLuu ? { tho_in: thoMoi } : {}),
  }, actorId);
  sockets.emit('dashboard:refresh', {});
  return { id, tho_in_chua_luu: thoInChuaLuu };
}

async function deleteKeHoachTam(id, actorId) {
  const kt = await repo.getKeHoachTam(id);
  if (!kt) throw new AppError('Kế hoạch tạm không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  await repo.deleteKeHoachTam(id);
  await repo.logKeHoachTam('XOA_KE_HOACH_TAM', kt.dot_vai_ve_id,
    { chuyen_id: kt.chuyen_id, ngay_ke_hoach: kt.ngay_ke_hoach, so_luong: kt.so_luong }, actorId);
  return { id };
}

// ─── TAB "HỦY KẾ HOẠCH TẠM" ở *Hủy lệnh xác nhận* (19/10/2026) ──────────────────────────────────────
// Phần in đã lập kế hoạch Release 1 nhưng CHƯA Ready (QC READY chưa xác nhận) nằm ở `ke_hoach_tam` — hủy =
//   xóa dòng (như nút thùng rác ở màn Kế hoạch tạm) nhưng LÝ DO BẮT BUỘC + audit `HUY_KE_HOACH_TAM` (ghi đủ
//   chuyền/ngày/giờ/SL/thợ in cũ). Đợt vải quay về pool Release 1 (badge Chờ Ready / Đã Ready như thường).
//   Không có lệnh ⇒ không có gì báo ERP. Danh sách KHÔNG lọc *Hiển thị theo PA in* (§5.7).
async function listKeHoachTamHuy({ search, page, limit, offset }) {
  const { rows, total } = await repo.listKeHoachTamRows({ search, offset, limit, locPain: false });
  return { items: rows, meta: buildMeta(page, limit, total) };
}

async function huyKeHoachTam(id, { lyDo } = {}, actorId) {
  const lyDoSach = String(lyDo || '').trim();
  if (!lyDoSach) throw new AppError('Nhập lý do hủy kế hoạch tạm', { status: 422, errorCode: 'NO_REASON' });
  const kt = await repo.getKeHoachTam(id);
  if (!kt) throw new AppError('Kế hoạch tạm không còn (đã xác nhận Release 1 hoặc đã bị xóa)', { status: 404, errorCode: 'NOT_FOUND' });
  await repo.deleteKeHoachTam(id);
  await repo.logKeHoachTam('HUY_KE_HOACH_TAM', kt.dot_vai_ve_id, {
    chuyen_id: kt.chuyen_id, ngay_ke_hoach: toDateStr(kt.ngay_ke_hoach), so_luong: kt.so_luong,
    gio_bd: gioCua(kt.tg_bd_kh), gio_kt: gioCua(kt.tg_kt_kh), tho_in: kt.tho_in_kh || null,
    qc_done: !!kt.qc_done, ly_do: lyDoSach,
  }, actorId);
  sockets.emit('workflow:updated', { dotVaiId: kt.dot_vai_ve_id, huyKeHoachTam: true });
  sockets.emit('dashboard:refresh', {});
  return { id, dot_vai_ve_id: kt.dot_vai_ve_id };
}

// Lịch sử thao tác Kế hoạch tạm theo ngày (nguồn audit_log — dòng tạm đã bị xóa khi lên lệnh).
const KHT_LABEL = {
  LUU_KE_HOACH_TAM: 'Lập kế hoạch tạm',
  SUA_KE_HOACH_TAM: 'Sửa kế hoạch tạm',
  XOA_KE_HOACH_TAM: 'Xóa kế hoạch tạm',
  HUY_KE_HOACH_TAM: 'Hủy kế hoạch tạm',
  XAC_NHAN_KE_HOACH_TAM: 'Xác nhận Release 1',
};
function khtChiTiet(r) {
  const parts = [[r.ma_phan, r.mau_vai, r.ma_dot_vai].filter(Boolean).join(' · ')];
  if (r.ten_chuyen) parts.push(`chuyền ${r.ten_chuyen}`);
  if (r.so_luong) parts.push(`SL ${r.so_luong}`);
  if (r.ngay_ke_hoach) parts.push(`ngày KH ${String(r.ngay_ke_hoach).slice(0, 10)}`);
  if (r.gio_bd || r.gio_kt) parts.push(`giờ ${r.gio_bd || '—'}–${r.gio_kt || '—'}`);
  if (r.tho_in) parts.push(`thợ in ${r.tho_in}`);
  if (r.ly_do) parts.push(`lý do: ${r.ly_do}`);
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

// "Danh sách kế hoạch tạm" (21/08/2026) — mọi đợt vải TỪNG đi qua kế hoạch tạm + tình trạng hiện tại.
// ⚠ Trả kèm `tong` theo từng tình trạng để FE dựng chip mà không phải đếm lại (và để biết ngay
//   "lập N đợt → M đã thực sự release"). Xem `repo.keHoachTamTheoDoi` cho vì sao phải đọc `audit_log`.
async function keHoachTamTheoDoi(q = {}) {
  const items = await repo.keHoachTamTheoDoi({
    search: q.search || '', tuNgay: q.tuNgay || '', denNgay: q.denNgay || '',
    loaiNgay: q.loaiNgay || 'NGAY_KE_HOACH',
  });
  const dem = items.reduce((a, r) => ({ ...a, [r.tinh_trang]: (a[r.tinh_trang] || 0) + 1 }), {});
  return { items, meta: { total: items.length, theo_tinh_trang: dem } };
}

// ----- GIA CÔNG: màn Kế hoạch nhận lại hàng gia công rồi chuyển OQC -----
// Lọc + phân trang Ở SERVER (01/10/2026) — `loc`/`tuNgay`/`denNgay` như màn Lập kế hoạch lại.
async function listGiaCong({ search, page, limit, offset, loc, tuNgay, denNgay }) {
  const { rows, total } = await repo.listGiaCongLenh({ search, offset, limit, loc, tuNgay, denNgay });
  // Gắn cờ "bị OQC trả về" (mức LỆNH — tem đã hủy khi trả nên cờ phải sống trên lệnh) để FE hiện badge đỏ
  // + biết lệnh đang CHỜ TRẢ LẠI nhà gia công (chưa bấm "Trả lại nhà gia công").
  const rm = await qaRepo.activeReturnsMap('OQC_GIA_CONG', rows.map((r) => r.id));
  const items = rows.map((r) => ({ ...r, tra_ve: rm[r.id] || null, cho_tra_lai: !!rm[r.id] }));
  return { items: await ganPhanInGiaCong(items), meta: buildMeta(page, limit, total) };
}

// Gắn `phan_in_list` cho màn *Gia công* — 1 phần tử / CODE PHẦN, kèm SL release / đã nhận / CÒN LẠI
// của RIÊNG code phần đó (nguồn: `repo.giaCongPhanInRows`).
//
// ⚠⚠ KHÔNG dùng `attachPhanInList` dùng chung: hàm đó chỉ gắn khi `so_phan_in > 1` và KHÔNG mang theo
//   số lượng — mà ở màn này số lượng theo từng code phần CHÍNH LÀ thứ quyết định dòng nào còn hiện.
// ⚠⚠ LỌC BỎ CODE PHẦN ĐÃ NHẬN ĐỦ (`con_lai_phan <= 0`) — yêu cầu 09/09/2026: "số lượng về 0 thì phần
//   in đó mới mất ở trang này". Lệnh vẫn ở màn chừng nào còn code phần chưa đủ.
// ⚠⚠ CÒN ĐÚNG 1 CODE PHẦN thì phải DỘI SỐ LIỆU LÊN CHÍNH HÀNG LỆNH: `DataTable` coi `subRows` có ≤1
//   phần tử là "không tách dòng" và vẽ hàng cha nguyên vẹn ⇒ không dội thì hàng đó hiện SL của CẢ
//   LỆNH trong khi chỉ còn 1 code phần chưa nhận — sai số ngay trên màn.
async function ganPhanInGiaCong(items) {
  if (!items.length) return items;
  const rows = await repo.giaCongPhanInRows(items.map((r) => r.id));
  const theoLenh = new Map();
  for (const r of rows) {
    if (!(Number(r.con_lai_phan) > 0)) continue; // đã nhận đủ ⇒ rời màn
    const ds = theoLenh.get(r.lenh_id) || [];
    ds.push({
      phan_in_id: r.phan_in_id, dot_vai_ve_id: r.dot_vai_ve_id, ma_phan: r.ma_phan,
      ten_khach_hang: r.ten_khach_hang, ma_don_hang: r.ma_don_hang, ma_hang: r.ma_hang,
      mau_vai: r.mau_vai, kich_vai: r.kich_vai, kich_phim: r.kich_phim,
      tinh_chat_in: r.tinh_chat_in, so_luong_don_hang: r.so_luong_don_hang,
      so_luong_vai_ve: r.so_luong_vai_ve, han_giao_hang: r.han_giao_hang,
      loai_dot_vai: r.loai_dot_vai, nha_gia_cong: r.nha_gia_cong, bo_phan_bh: r.bo_phan_bh,
      // ⚠ Trùng TÊN với khóa mức lệnh để `{...row, ...sub}` của DataTable ĐÈ đúng chỗ ⇒ mỗi dòng con
      //   hiện số của chính code phần đó, không phải số của cả lệnh.
      so_luong_release: r.sl_release_phan, da_chuyen: r.da_chuyen_phan, con_lai: r.con_lai_phan,
    });
    theoLenh.set(r.lenh_id, ds);
  }
  return items.map((r) => {
    const ds = theoLenh.get(r.id) || [];
    if (ds.length <= 1) {
      // 0 phần tử: dữ liệu cũ/bất thường ⇒ giữ nguyên hàng lệnh. 1 phần tử: dội lên hàng cha.
      return ds.length === 1 ? { ...r, ...ds[0], phan_in_list: ds } : { ...r, phan_in_list: ds };
    }
    return { ...r, phan_in_list: ds };
  });
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
  const d = date || ngayHomNayVN();
  return repo.listGiaCongHistory(d);
}

// Kế hoạch xác nhận đã nhận lại hàng gia công → tạo phiếu HOAN_TAT + tem CHO_OQC (seed sl_kcs_dat = SL,
// coi như đã KCS đạt ⇒ con_oqc>0), rồi đưa dòng chảy sang OQC. Nguồn hiển thị = "Gia công".
// ⚠ HÀNG GIA CÔNG CÓ THỂ VỀ NHIỀU LẦN: mỗi lần nhận = 1 phiếu + 1 TEM RIÊNG mang SL của lần đó
// (OQC bốc mẫu từng tem độc lập, truy vết được lô nào về lúc nào). Lệnh CHỈ rời màn Gia công
// (→ HOAN_TAT + tracking sang OQC) khi Σ SL đã chuyển ĐỦ `so_luong_release`; chưa đủ thì vẫn đậu lại
// với phần "còn lại" để nhận tiếp. Bỏ trống `soLuong` = chuyển hết phần còn lại (hành vi cũ).
async function confirmGiaCongToOqc(lenhId, { soLuong, items } = {}, actorId) {
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
  // ─── NHẬN THEO TỪNG CODE PHẦN (09/09/2026) ──────────────────────────────────────────────────
  // `items` = [{ dotVaiId, soLuong }] — mỗi phần tử là MỘT code phần, tối đa `TOI_DA_IN_TEM` (in 2 tem/tờ,
  // nhiều tờ 1 cửa sổ). Không truyền `items` ⇒ giữ NGUYÊN đường cũ (nhận ở MỨC LỆNH), đó là
  // đường mà nút "Chuyển OQC (N lệnh)" hàng loạt đang dùng.
  const dsItem = Array.isArray(items) ? items.filter((x) => x && x.dotVaiId) : [];
  if (dsItem.length) {
    return nhanGiaCongTheoPhanIn(lenh, dsItem, actorId);
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

  // ⚠⚠⚠ MÃ TEM 13 XIN RIÊNG CỦA ERP (`/barcode-tem-13`, chốt 06/09/2026) — trước đây tem gia công
  //   xin mã của dãy tem 15 rồi chỉ ĐỔI 2 SỐ ĐẦU lúc IN NHÃN, nên DB lưu `15…` mà giấy in `13…`:
  //   ERP không phân biệt được 2 nhãn, còn người cầm nhãn `13…` soi bảng lại thấy `15…`.
  //   Nay `ma_tem` lưu ĐÚNG mã `13…` mà ERP cấp ⇒ nhãn giấy = mã trong DB.
  // Lấy TRƯỚC transaction, SAU mọi guard ở trên để không tiêu số vô ích.
  // Lùi 2 nấc khi API tắt: mã tem 15 (như trước) → dãy `TEM00123` của MES.
  const mt = (await layBarcodeTem13(actorId))
    || (await layBarcodeTem(actorId))
    || (await productionRepo.nextMaTem());

  let temIdMoi = null;
  const maTem = await withTransaction(async (client) => {
    const maPhieu = await productionRepo.nextMaPhieuTx(client);
    const phieuId = await productionRepo.createPhieuDone(client, { lenhId, chuyenId: lenh.chuyen_id, maPhieu, soLuong: qty }, actorId);
    temIdMoi = await productionRepo.createTemGiaCongOqc(client, { phieuId, maTem: mt, soLuong: qty }, actorId);
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
  // ⚠⚠ BÁO NGƯỢC LÊN ERP CHO TEM 13 (nhiệm vụ #13, 05/09/2026). Trước đây chỉ `printTem`/
  // `printTemBatch` báo ERP ⇒ tem "TH VỀ" của hàng gia công KHÔNG bao giờ được ghi sang ERP, dù nó
  // cũng là một lượt tem thật đi vào OQC → Giao.
  // ⚠ CHẠY NGẦM, KHÔNG `await` — giữ đúng luật của `guiGhiInTem`: ERP chậm/lỗi KHÔNG BAO GIỜ chặn
  //   nghiệp vụ (xấu nhất ~33s do timeout 10s × 3 lần); mọi lỗi tự ghi `audit_log` để gửi lại tay.
  // ⚠⚠ REQUIRE TRỄ TRONG HÀM, KHÔNG ở đầu file: `production.service` ĐÃ require `planning.service`
  //   (rollbackLenh) ⇒ require ở đầu file là **vòng require**, `module.exports` một bên sẽ rỗng lúc
  //   nạp. Gọi lúc chạy thì cả 2 module đã nạp xong.
  // ⚠ Không truyền `dotVaiId`: lệnh gia công có thể gom nhiều đợt vải nhưng tem 13 là MỘT lượt nhận
  //   chung cho cả lệnh (không tách theo đợt) ⇒ để `duLieuGhiInTem` lấy đợt đại diện, y như `printTem`.
  if (temIdMoi) {
    const { guiGhiInTem } = require('../production/production.service');
    // ⚠⚠ Kênh `/gui-du-lieu-tem-gia-cong` (proc JQ6, 27/09/2026) — KHÔNG còn qua `ghi-in-tem` (SF0).
    guiGhiInTem([{ temId: temIdMoi, dotVaiId: null, soLuongHuy: 0, soLuongThieu: 0 }], actorId, null,
      { maApi: 'ERP_GUI_TEM_GIA_CONG' });
  }
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// NHẬN HÀNG GIA CÔNG THEO TỪNG CODE PHẦN (09/09/2026, nền: `tem.dot_vai_ve_id` mig 095)
//
// Trước đây hàng gia công nhận ở MỨC LỆNH: lệnh gom set 6 code phần chỉ có MỘT ô "còn lại" chung, nên
// không biết code phần nào đã về, code phần nào chưa — mà nhà gia công trả hàng theo từng màu/kích.
// Nay mỗi lượt nhận chọn tối đa `TOI_DA_IN_TEM` code phần, nhập SL cho từng cái ⇒ 1 phiếu + N tem, mỗi
// tem gắn ĐỢT VẢI của đúng code phần đó. Phần in nào về đủ thì RỜI màn, các phần còn lại ở lại.
//
// ⚠⚠ 07/10/2026 nâng trần 2 → 50 (người dùng chốt "in bao nhiêu tem cũng được, mỗi lượt vẫn 2 tem"): FE in
//   N tem thành ⌈N/2⌉ tờ trong 1 cửa sổ (`printTemLabel.printGiaCongVeTem`). Vẫn giữ trần vì mỗi tem xin 1 mã
//   ERP TUẦN TỰ trước transaction. Gương FE `GiaCongPage TOI_DA_PHAN`.
// ⚠⚠ GHI **1 DÒNG AUDIT CHO MỖI CODE PHẦN** (không phải 1 dòng cho cả lượt): nhờ vậy màn *Lịch sử
//   chuyển* liệt kê đúng từng code phần và in lại được tem của riêng nó.
// ⚠ MÃ TEM xin RIÊNG cho từng tem (mỗi lượt gọi ERP TIÊU MỘT SỐ) — lấy TRƯỚC transaction, SAU mọi
//   guard, đúng luật đã ghi ở §6 "BA DÃY SỐ ĐỘC LẬP".
const TOI_DA_IN_TEM = 50;

async function nhanGiaCongTheoPhanIn(lenh, items, actorId) {
  const lenhId = lenh.id;
  if (items.length > TOI_DA_IN_TEM) {
    throw new AppError(`Mỗi lần nhận chỉ chọn tối đa ${TOI_DA_IN_TEM} code phần`,
      { status: 422, errorCode: 'QUA_NHIEU_PHAN' });
  }
  // Phần còn lại của TỪNG code phần — nguồn tính giống hệt màn Gia công đang hiện, không tự tính lại.
  const pinRows = await repo.giaCongPhanInRows([lenhId]);
  const theoDot = new Map(pinRows.map((r) => [String(r.dot_vai_ve_id), r]));

  const daXet = new Set();
  const canhan = [];
  for (const it of items) {
    const key = String(it.dotVaiId);
    const p = theoDot.get(key);
    if (!p) {
      throw new AppError('Code phần không thuộc lệnh gia công này', { status: 422, errorCode: 'PHAN_IN_LA' });
    }
    if (daXet.has(key)) {
      throw new AppError(`Code phần ${p.ma_phan} bị chọn 2 lần`, { status: 422, errorCode: 'TRUNG_PHAN' });
    }
    daXet.add(key);
    // ⚠⚠ `soLuong` = SL **ĐẠT** · `soLuongHuy` = SL **HỦY** (hàng hỏng nhà gia công trả về).
    //   CẢ HAI đều là vải THỰC SỰ nhận về ⇒ **tổng đạt+hủy** mới là phần trừ vào "còn phải nhận".
    //   Đạt được phép = 0 (cả lô hỏng), miễn tổng > 0.
    // ⚠ 02/10/2026 thêm `soLuongThieu` (nhà gia công trả THIẾU) · `soLuongLoiVai` (LỖI VẢI) — cùng trừ vào "còn lại",
    //   KHÔNG sang OQC (xem `production.repository.createTemGiaCongOqc`) · `slMotBo` (SL 1 BÓ) chỉ để in trên tem.
    const soKhongAm = (v, mac = 0) => (v == null || v === '' ? mac : Math.trunc(Number(v)));
    const qty = soKhongAm(it.soLuong, p.con_lai_phan);
    const huy = soKhongAm(it.soLuongHuy);
    const loiVai = soKhongAm(it.soLuongLoiVai);
    const thieu = soKhongAm(it.soLuongThieu);
    const motBo = soKhongAm(it.slMotBo);
    for (const [ten, v] of [['đạt', qty], ['hủy', huy], ['lỗi vải', loiVai], ['thiếu', thieu], ['1 bó', motBo]]) {
      if (!Number.isFinite(v) || v < 0) {
        throw new AppError(`Số lượng ${ten} của ${p.ma_phan} không hợp lệ`, { status: 422, errorCode: 'INVALID_QTY' });
      }
    }
    const tongLuot = qty + huy + loiVai + thieu;
    if (tongLuot <= 0) {
      throw new AppError(`Nhập số lượng nhận của ${p.ma_phan} (đạt / hủy / lỗi vải / thiếu) lớn hơn 0`,
        { status: 422, errorCode: 'INVALID_QTY' });
    }
    if (tongLuot > p.con_lai_phan) {
      throw new AppError(`Số lượng của ${p.ma_phan} (đạt ${qty} + hủy ${huy} + lỗi vải ${loiVai} + thiếu ${thieu} = ${tongLuot}) `
        + `vượt phần còn lại (${p.con_lai_phan})`, { status: 422, errorCode: 'OVER_REMAINING' });
    }
    canhan.push({ pin: p, qty, huy, loiVai, thieu, motBo, tongLuot });
  }

  // Sau lượt này lệnh đã nhận đủ chưa (để đổi trạng thái + đẩy dòng chảy sang OQC).
  const tong = Number(lenh.so_luong_release) || 0;
  const daChuyen = Number(lenh.da_chuyen) || 0;
  // ⚠ Phần trừ vào "còn phải nhận" là ĐẠT + HỦY + LỖI VẢI + THIẾU (khớp `tem.so_luong` của tem 13).
  const themLan = canhan.reduce((s, x) => s + x.tongLuot, 0);
  const xong = daChuyen + themLan >= tong;

  // Mã tem: mỗi code phần MỘT mã riêng. Lùi 2 nấc khi API tắt (giống nhánh nhận theo lệnh).
  const maTems = [];
  for (let i = 0; i < canhan.length; i += 1) {
    maTems.push((await layBarcodeTem13(actorId))
      || (await layBarcodeTem(actorId))
      || (await productionRepo.nextMaTem()));
  }

  const ketQua = await withTransaction(async (client) => {
    const maPhieu = await productionRepo.nextMaPhieuTx(client);
    const phieuId = await productionRepo.createPhieuDone(client,
      { lenhId, chuyenId: lenh.chuyen_id, maPhieu, soLuong: themLan }, actorId);
    const ra = [];
    for (let i = 0; i < canhan.length; i += 1) {
      const { pin, qty, huy, loiVai, thieu, motBo, tongLuot } = canhan[i];
      const temId = await productionRepo.createTemGiaCongOqc(client,
        { phieuId, maTem: maTems[i], soLuong: qty, slHuy: huy, slLoiVai: loiVai, slThieu: thieu, dotVaiVeId: pin.dot_vai_ve_id }, actorId);
      const soBo = motBo > 0 ? Math.ceil(qty / motBo) : null;
      await client.query(
        `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
         VALUES ('lenh_san_xuat', $1, 'GIA_CONG_CHUYEN_OQC', $2::jsonb, $3, CURRENT_TIMESTAMP, $3)`.replace(/\s+/g, ' '),
        [String(lenhId), JSON.stringify({
          ma_lenh: lenh.ma_lenh_san_xuat, so_luong: qty, so_luong_huy: huy, ma_tem: maTems[i],
          sl_loi_vai: loiVai, sl_thieu: thieu, sl_mot_bo: motBo || null, so_bo: soBo,
          ma_phan: pin.ma_phan, dot_vai_ve_id: pin.dot_vai_ve_id,
          sl_release_phan: pin.sl_release_phan,
          da_chuyen_phan: pin.da_chuyen_phan + tongLuot,
          con_lai_phan: pin.con_lai_phan - tongLuot,
          da_chuyen: daChuyen + themLan, con_lai: tong - (daChuyen + themLan), hoan_tat: xong,
        }), actorId]
      );
      ra.push({
        tem_id: temId, ma_tem: maTems[i], ma_phan: pin.ma_phan, so_luong: qty, so_luong_huy: huy,
        sl_loi_vai: loiVai, sl_thieu: thieu, sl_mot_bo: motBo || null, so_bo: soBo, tong_luot: tongLuot,
      });
    }
    if (xong) await productionRepo.setLenhTrangThai(client, lenhId, 'HOAN_TAT', actorId);
    return ra;
  });

  // Báo ngược lên ERP từng tem — CHẠY NGẦM, không `await` (xem ghi chú ở nhánh nhận theo lệnh).
  // ⚠ Truyền `dotVaiId` THẬT: mỗi tem nay đích danh 1 đợt vải, không phải "đợt đại diện" như trước.
  const { guiGhiInTem } = require('../production/production.service');
  // ⚠ `soLuong` = SL ĐẠT · `soLuongHuy` = HỦY + LỖI VẢI (ERP `Soluongloi` — hàng không dùng được) ·
  //   `soLuongThieu` = THIẾU (ERP `SOLUONGTHIEU`). ERP chưa có tham số riêng cho lỗi vải.
  // ⚠⚠ Kênh `/gui-du-lieu-tem-gia-cong` (proc JQ6, 27/09/2026). In 2 tem ⇒ 2 phần tử ⇒ `guiGhiInTem`
  //   gọi ERP 2 LẦN, mỗi tem 1 IDMES riêng (proc khóa phiếu theo Soctcu = IDMES).
  guiGhiInTem(ketQua.map((t, i) => ({
    temId: t.tem_id, dotVaiId: canhan[i].pin.dot_vai_ve_id,
    soLuong: canhan[i].qty, soLuongHuy: canhan[i].huy + canhan[i].loiVai, soLuongThieu: canhan[i].thieu,
  })), actorId, null, { maApi: 'ERP_GUI_TEM_GIA_CONG' });

  if (xong) {
    await tracking.moveByLenh(lenhId, 'OQC', actorId);
    await qaRepo.resolveReturnsMany('TEST_RUN', lenh.dot_vai_ids || []);
  }
  sockets.emit('workflow:updated', { lenhId, stage: xong ? 'OQC' : 'GIA_CONG', giaCong: true });
  sockets.emit('dashboard:refresh', {});
  return {
    id: lenhId, stage: xong ? 'OQC' : 'GIA_CONG', hoan_tat: xong,
    so_luong: themLan, da_chuyen: daChuyen + themLan, con_lai: tong - (daChuyen + themLan),
    tems: ketQua, ma_tem: ketQua[0] && ketQua[0].ma_tem,
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
  // Báo ERP hủy phiếu nhận hàng gia công (JQ6) của tem theo IDMES — chạy ngầm (14/10/2026, `utils/erpHuy.js`).
  erpHuy.baoHuyNgam('TEM_GIA_CONG', temId, { lyDo: ly, actorId, maHien: t.ma_tem });
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

// Giờ trong ngày ('HH:MM') của một timestamp đã lưu — server chạy GMT+7 nên giờ local = giờ VN
// (cùng quy ước với `toDateStr` bên dưới).
function gioCua(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// `thoIn` (07/10/2026, mig 111): THỢ IN KẾ HOẠCH — không gửi (`undefined`) = GIỮ NGUYÊN; gửi chuỗi = ghi đè
//   (chuỗi rỗng = xóa). Thiếu cột (chưa chạy mig) ⇒ vẫn lập lại kế hoạch, trả `tho_in_chua_luu` để FE báo.
// `opts.choDaChay` (26/10/2026 — CHỈ *Quản trị phần in* truyền, người dùng: "cho sửa thông tin của kế hoạch"): nhận cả
//   lệnh in trong xưởng ĐÃ xác nhận chạy (có phiếu) — chỉ sửa THÔNG TIN kế hoạch: chuyền KH (trong xưởng, không qua gia
//   công) · ngày · giờ · SL release từng đợt (vẫn trần theo vải + không dưới SL đã in — `updateReleaseTx`) · thợ in KH.
//   KHÔNG đổi chặng (`changMoi` = null khi có phiếu), chuyền chạy thật của phiếu không đụng (đổi máy dùng "Đổi chuyền").
// `btp` (29/10/2026, người dùng: "thêm nút BTP ở Lập lại kế hoạch và Sửa kế hoạch — tích thì hiện lại ở Release 1, bỏ thì
//   mất"): `true` = THÊM 1 ĐẦU BTP cho mọi đợt của lệnh (đợt hiện lại ở Release 1 với còn = SL vải) · `false` = BỎ đầu đang
//   chờ (đợt rời Release 1) · không gửi = giữ nguyên. Luật `utils/btpKhacKh.datSoDauTx`; chưa mig 120 ⇒ trả `btp_chua_luu`.
async function replan(lenhId, { chuyenId, ngayKeHoach, lyDo, tgBdKh, tgKtKh, slRelease, thoIn, btp }, actorId, opts = {}) {
  if (!ngayKeHoach) throw new AppError('Chọn ngày sản xuất theo kế hoạch', { status: 422, errorCode: 'NO_NGAY' });
  // Lý do KHÔNG bắt buộc (chốt 2026-08-14) — dời ngày/chuyền là việc điều độ hằng ngày, bắt nhập lý do
  // mỗi lần chỉ khiến người dùng gõ cho có. Vẫn ghi vào audit khi có nhập.
  const lyDoSach = (lyDo || '').trim() || null;

  const lenh = await repo.getLenhForReplan(lenhId);
  if (!lenh) throw new AppError('Lệnh sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  // Cho lập lại kế hoạch khi lệnh đang Test Run (RELEASE_1) · đã Release 2 · hoặc ĐANG GIA CÔNG.
  // ⚠⚠ LỆNH GIA CÔNG ĐÃ NHẬN HÀNG VỀ MỘT PHẦN VẪN LẬP LẠI KẾ HOẠCH ĐƯỢC (chốt 10/09/2026): mỗi lượt
  //   nhận sinh 1 phiếu + 1 tem, mà phần CHƯA nhận vẫn còn ở nhà gia công và vẫn cần dời ngày. Lệnh
  //   IN THƯỜNG có phiếu = đang chạy máy ⇒ giữ nguyên chặn (dùng *Hủy lệnh sản xuất* nếu muốn gỡ).
  const laGiaCong = lenh.trang_thai === 'GIA_CONG';
  const daChayOk = !!opts.choDaChay && lenh.co_phieu && !laGiaCong && lenh.trang_thai !== 'HUY';
  if (!daChayOk && (!['RELEASE_1', 'RELEASE_2', 'GIA_CONG'].includes(lenh.trang_thai) || (lenh.co_phieu && !laGiaCong))) {
    throw new AppError('Chỉ lập lại kế hoạch cho lệnh đang Test Run / Release 2 / Gia công và chưa bắt đầu sản xuất',
      { status: 409, errorCode: 'NOT_REPLANNABLE' });
  }

  const newChuyen = chuyenId || lenh.chuyen_id; // không gửi thì giữ chuyền cũ

  // ⚠⚠ ĐÃ NHẬN HÀNG VỀ RỒI THÌ KHÔNG ĐƯỢC RỜI KHỎI GIA CÔNG. Tem đã nhận đang đi tiếp sang OQC; đổi
  //   sang chuyền in trong xưởng sẽ kéo lệnh về `RELEASE_1`/`RELEASE_2` (xem `chuyenChangTheoChuyen`)
  //   ⇒ hàng vừa nằm ở OQC vừa nằm ở hàng đợi test, sổ cái sai mà không ai báo lỗi.
  //   Vẫn cho đổi sang **chuyền gia công KHÁC** (đổi nhà gia công) và dời ngày/giờ như thường.
  //   Chiều ngược lại (lệnh in trong xưởng ĐÃ CHẠY — chỉ lối `choDaChay`): không đổi sang chuyền gia công.
  // ⚠ Guard chạy TRƯỚC MỌI thao tác ghi.
  if (lenh.co_phieu) {
    const loaiMoi = await repo.getChuyenLoai(newChuyen);
    if (laGiaCong && loaiMoi !== 'GIA_CONG') {
      throw new AppError(`Lệnh đã nhận về ${lenh.da_nhan}/${lenh.so_luong_release} — chỉ đổi được sang chuyền gia công khác. `
        + 'Muốn đưa về chuyền in trong xưởng thì hủy tem gia công đã nhận trước (Hệ thống > Hủy lệnh xác nhận > Hủy tem gia công).',
      { status: 409, errorCode: 'DA_NHAN_HANG' });
    }
    if (!laGiaCong && loaiMoi === 'GIA_CONG') {
      throw new AppError('Lệnh đã xác nhận chạy trong xưởng — không đổi kế hoạch sang chuyền gia công',
        { status: 409, errorCode: 'DA_CHAY' });
    }
  }
  // GIỜ BẮT ĐẦU / KẾT THÚC kế hoạch:
  //  - FE gửi lên → dùng luôn (đã ghép sẵn ngày mới + giờ, y như Release 1).
  //  - KHÔNG gửi → DỜI giờ cũ sang NGÀY MỚI, giữ nguyên giờ-trong-ngày.
  // ⚠ Không được để nguyên `tg_bd_kh` cũ: nó mang NGÀY CŨ, lập lại kế hoạch mà giữ y nguyên thì
  //   `ngay_ke_hoach` và `tg_bd_kh` chỏi nhau (mọi màn đọc giờ SX sẽ hiện ngày đã bị dời đi).
  //   Cũng KHÔNG xóa trắng — người dùng chỉ dời ngày thì không có lý do gì mất giờ đã đặt.
  const ngayMoi = toDateStr(ngayKeHoach);
  const doiGio = (moi, cu) => {
    if (moi) return moi;
    const g = gioCua(cu);
    return g && ngayMoi ? `${ngayMoi}T${g}:00` : null;
  };
  const bdMoi = doiGio(tgBdKh, lenh.tg_bd_kh);
  const ktMoi = doiGio(tgKtKh, lenh.tg_kt_kh);

  // SỐ LƯỢNG RELEASE (20/08/2026) — sửa ngay tại màn Lập kế hoạch lại thay vì phải chạy vòng sang
  // *Hệ thống > Cập nhật SL nhận vải / release*. Không gửi `slRelease` ⇒ giữ nguyên như cũ.
  // ⚠⚠ TRẦN TRÊN theo TỪNG ĐỢT VẢI: `so_luong_vai_ve` − SL các lệnh KHÁC đang giữ. 1 đợt vải release
  //   được thành nhiều lệnh nên không kiểm cái này là **release vượt số vải thực có**.
  // ⚠ Chặn ≤ 0: lệnh release 0 mét là dữ liệu vô nghĩa (muốn bỏ hẳn thì dùng *Hủy lệnh sản xuất*).
  const dsDot = await repo.getReplanDotVai(lenhId);
  const items = [];
  if (slRelease && typeof slRelease === 'object') {
    for (const d of dsDot) {
      const v = slRelease[d.dot_vai_id];
      if (v === undefined || v === null || v === '') continue;
      const n = Number(v);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        throw new AppError(`SL release của đợt ${d.ma_dot_vai} phải là số nguyên lớn hơn 0`,
          { status: 422, errorCode: 'SL_KHONG_HOP_LE' });
      }
      if (n > d.toi_da) {
        throw new AppError(`SL release của đợt ${d.ma_dot_vai} tối đa ${d.toi_da} `
          + `(SL vải về ${d.so_luong_vai_ve}, các lệnh khác đang giữ ${d.da_release_khac})`,
          { status: 422, errorCode: 'VUOT_SL_VAI' });
      }
      if (n !== d.so_luong) items.push({ dotVaiId: d.dot_vai_id, soLuong: n });
    }
  }
  const slCu = dsDot.reduce((a, d) => a + d.so_luong, 0);

  // CHẶNG PHẢI KHỚP LOẠI CHUYỀN VỪA GÁN (chốt 04/09/2026) — xem `chuyenChangTheoChuyen`.
  // ⚠ Lệnh gia công ĐÃ có tem thì KHÔNG bao giờ đổi chặng: guard `DA_NHAN_HANG` ở trên đã ép chuyền
  //   mới cũng phải là gia công, nên bỏ hẳn lời gọi cho tường minh (và đỡ 1 lượt truy vấn).
  const changMoi = lenh.co_phieu ? null : await chuyenChangTheoChuyen(lenh, newChuyen, dsDot, slCu);

  // Thợ in kế hoạch — chỉ đụng khi bên gọi GỬI ô này và DB đã có cột (dò TRƯỚC transaction).
  const guiTho = thoIn !== undefined;
  const coTho = guiTho && (await coCotThoInKh());
  const thoMoi = coTho ? chuanHoaThoIn(thoIn) : undefined;
  const doiTho = coTho && (thoMoi || null) !== (lenh.tho_in_kh || null);
  // BTP — chỉ khi bên gọi GỬI `btp` boolean và DB đã có cột (dò TRƯỚC transaction).
  const guiBtp = typeof btp === 'boolean';
  const coBtp = guiBtp && (await coCotBtp());

  let slMoi = slCu;
  let btpDoi = [];
  await withTransaction(async (client) => {
    await repo.updateLenhPlan(client, lenhId,
      { chuyenId: newChuyen, ngayKeHoach, tgBdKh: bdMoi, tgKtKh: ktMoi, thoInKh: doiTho ? thoMoi : undefined }, actorId);
    if (changMoi) await repo.setLenhTrangThaiTx(client, lenhId, changMoi, actorId);
    if (items.length) slMoi = await repo.updateReleaseTx(client, lenhId, items, actorId);
    // Sau khi ghi SL release mới ⇒ "phần đã lập" tính đúng số mới.
    if (coBtp) {
      btpDoi = await datSoDauTx(client, dsDot.map((d) => d.dot_vai_id), actorId,
        { them: btp, nguon: opts.nguon || 'REPLAN', lyDo: lyDoSach });
    }
    await repo.logPlanChange(client, lenhId, 'REPLAN',
      { chuyen_id: lenh.chuyen_id || null, ngay_ke_hoach: toDateStr(lenh.ngay_ke_hoach),
        gio_bd: gioCua(lenh.tg_bd_kh), gio_kt: gioCua(lenh.tg_kt_kh),
        ...(items.length ? { so_luong_release: slCu } : {}),
        ...(doiTho ? { tho_in_kh: lenh.tho_in_kh || null } : {}) },
      { chuyen_id: newChuyen || null, ngay_ke_hoach: ngayMoi, ly_do: lyDoSach,
        gio_bd: gioCua(bdMoi), gio_kt: gioCua(ktMoi),
        ...(items.length ? { so_luong_release: slMoi } : {}),
        ...(doiTho ? { tho_in_kh: thoMoi } : {}),
        ...(btpDoi.length ? { btp: btp ? 'THEM_DAU' : 'BO_DAU', btp_dot: btpDoi } : {}),
        ...(opts.nguon ? { nguon: opts.nguon } : {}) },
      actorId);
  });
  sockets.emit('workflow:updated', { lenhId, stage: changMoi || 'RELEASE_2', replan: true, giaCong: changMoi === 'GIA_CONG' || undefined });
  sockets.emit('dashboard:refresh', {});
  // Đổi SL release là đổi con số mà màn Sản xuất / dashboard đang đọc ⇒ báo luôn cho chúng tải lại.
  if (items.length || lenh.co_phieu) sockets.emit('production:updated', { lenhId });
  // Báo ERP kế hoạch MỚI của lệnh — `replanBatch` gọi hàm này từng lệnh, hàng chờ của `release1Erp` gom
  //   lại nên phần in inset vẫn đi chung 1 lượt.
  release1Erp.xepHang([lenhId], actorId, 'REPLAN');
  if (btpDoi.length) sockets.emit('ready:confirmed', { dotVaiIds: btpDoi.map((d) => d.id), btp: true });
  return {
    id: lenhId, so_luong_release: slMoi, trang_thai: changMoi || lenh.trang_thai,
    ...(guiTho && !coTho ? { tho_in_chua_luu: true } : {}),
    ...(guiBtp ? { btp_doi: btpDoi, ...(coBtp ? {} : { btp_chua_luu: true }) } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ĐỔI CHUYỀN Ở MÀN "LẬP KẾ HOẠCH LẠI" CÓ THỂ ĐỔI LUÔN CHẶNG CỦA LỆNH (chốt 04/09/2026).
//
// ⚠⚠ LỖI ĐÃ GẶP: `updateLenhPlan` chỉ ghi `chuyen_id`, KHÔNG đụng `trang_thai` ⇒ chuyển một lệnh sang
//   **chuyền loại GIA_CONG** thì nó vẫn mang `RELEASE_1` ⇒ **hàng gia công nằm chình ình ở màn
//   Test Run - QA** chờ QA test, trong khi hàng đã gửi ra ngoài xưởng và lẽ ra phải đậu ở màn
//   Kế hoạch > Gia công. Chiều ngược lại cũng hỏng: lệnh `GIA_CONG` đổi về chuyền in trong xưởng vẫn
//   giữ `GIA_CONG` ⇒ mãi không vào được dòng chảy in.
//
// Trả về mã chặng MỚI, hoặc `null` khi không phải đổi gì.
// ⚠ Chỉ gọi cho lệnh **CHƯA CÓ PHIẾU** (guard `co_phieu` ở `replan` đã chặn) — có tem rồi mà đổi chặng
//   là làm sai sổ cái.
async function chuyenChangTheoChuyen(lenh, chuyenIdMoi, dsDot, tongSL) {
  const laGiaCong = (await repo.getChuyenLoai(chuyenIdMoi)) === 'GIA_CONG';
  if (laGiaCong) return lenh.trang_thai === 'GIA_CONG' ? null : 'GIA_CONG';
  if (lenh.trang_thai !== 'GIA_CONG') return null; // chuyền thường → thường: giữ nguyên chặng

  // GIA_CONG → chuyền in trong xưởng: quay lại dòng chảy ở TEST RUN (27/10/2026 — mọi lệnh qua Test Run, xem đầu file).
  void dsDot; void tongSL;
  return 'RELEASE_1';
}

// Chi tiết 1 lệnh cho màn Lập kế hoạch lại: kế hoạch hiện tại + DANH SÁCH ĐỢT VẢI kèm SL release.
// ⚠ FE đổ sẵn mọi ô từ đây ⇒ người dùng sửa 1 thứ thì không phải nhập lại những thứ còn nguyên.
async function getReplanDetail(lenhId) {
  const lenh = await repo.getLenhForReplan(lenhId);
  if (!lenh) throw new AppError('Lệnh sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  return { ...lenh, dot_vai: await repo.getReplanDotVai(lenhId) };
}

// SỬA KẾ HOẠCH TỪ SIDEBAR "DANH SÁCH RELEASE" (28/10/2026, người dùng: "cho sửa thông tin kế hoạch luôn, có gửi tới ERP —
//   kế hoạch là phải hủy cái cũ rồi gửi theo cái mới"). Gọi CHÍNH `replan` với `choDaChay` (cùng lối Quản trị phần in):
//   lệnh chưa chạy đi y như Lập lại kế hoạch; lệnh đã xác nhận chạy chỉ sửa THÔNG TIN kế hoạch (không đổi chặng, không
//   sang gia công, SL release không dưới đã in). ERP: `release1Erp.xepHang(…, 'REPLAN')` hủy MỌI lượt kế hoạch cũ còn
//   hiệu lực của lệnh rồi gửi lượt mới. Lý do BẮT BUỘC (khác màn Lập lại kế hoạch — đây là sửa cả lệnh đã chạy).
async function suaKeHoachTuDsRelease(lenhId, body = {}, actorId) {
  const ly = String(body.lyDo || '').trim();
  if (!ly) throw new AppError('Nhập lý do sửa kế hoạch', { status: 422, errorCode: 'NO_LY_DO' });
  return replan(lenhId, {
    chuyenId: body.chuyenId || null, ngayKeHoach: body.ngayKeHoach, tgBdKh: body.tgBdKh || null, tgKtKh: body.tgKtKh || null,
    slRelease: body.slRelease || null, thoIn: body.thoIn, lyDo: ly,
    btp: typeof body.btp === 'boolean' ? body.btp : undefined,
  }, actorId, { choDaChay: true, nguon: 'DS_RELEASE' });
}

// Lập lại kế hoạch hàng loạt — áp cùng chuyền/ngày/lý do cho nhiều lệnh.
async function replanBatch(lenhIds, body, actorId) {
  if (!Array.isArray(lenhIds) || lenhIds.length === 0) {
    throw new AppError('Chọn ít nhất một lệnh', { status: 422, errorCode: 'NO_LENH' });
  }
  let okCount = 0;
  let thoInChuaLuu = false;
  const errors = [];
  for (const id of lenhIds) {
    try {
      const kq = await replan(id, body, actorId);
      okCount += 1;
      if (kq && kq.tho_in_chua_luu) thoInChuaLuu = true;
    } catch (e) { errors.push({ lenhId: id, message: e.message }); }
  }
  sockets.emit('dashboard:refresh', {});
  return { okCount, failedCount: errors.length, errors, ...(thoInChuaLuu ? { tho_in_chua_luu: true } : {}) };
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
    // Giờ BD/KT chỉ ghi vào phần chi tiết khi CÓ đặt giờ (dòng lịch sử cũ không có 2 khóa này).
    const khoangGio = (bd, kt) => (bd || kt ? `${bd || '—'}→${kt || '—'}` : '');
    const gioCu = khoangGio(r.gio_bd_cu, r.gio_kt_cu);
    const gioMoi = khoangGio(r.gio_bd_moi, r.gio_kt_moi);
    const phanGio = gioCu || gioMoi
      ? ` · Giờ ${gioCu || '—'}→${gioMoi || '—'}`
      : '';
    const chiTiet = isReplan
      ? `Chuyền ${r.ten_chuyen_cu || '—'}→${r.ten_chuyen_moi || '—'} · Ngày ${ng(r.ngay_cu)}→${ng(r.ngay_moi)}${phanGio} · Lý do: ${r.ly_do || '—'}`
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

// `loaiChuyen` (mig 112): mảng mã nhóm ('MAY'/'BAN'/'ROBOT'/'KHAC') để cài RIÊNG; rỗng/thiếu = CHUNG (cả xưởng
//   — kéo luôn các dòng riêng Máy/Bàn/Robot của tuần về cùng loại ca, KHÔNG kéo 'KHAC' — xem `repo.upsertCaTuan`).
//   Chuỗi đơn cũng nhận.
async function upsertCaTuan({ nam, tuan, loaiCa, ghiChu, loaiChuyen }, actorId) {
  const y = Number(nam); const w = Number(tuan);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new AppError('Năm không hợp lệ', { status: 422, errorCode: 'INVALID' });
  if (!Number.isInteger(w) || w < 1 || w > 53) throw new AppError('Tuần không hợp lệ (1–53)', { status: 422, errorCode: 'INVALID' });
  if (!['NGAN', 'DAI', 'HANH_CHINH'].includes(loaiCa)) throw new AppError('Loại ca phải là NGAN, DAI hoặc HANH_CHINH', { status: 422, errorCode: 'INVALID' });
  const ds = [...new Set((Array.isArray(loaiChuyen) ? loaiChuyen : [loaiChuyen])
    .map((x) => String(x || '').trim().toUpperCase()).filter(Boolean))];
  const sai = ds.filter((x) => !NHOM_CA_RIENG.includes(x));
  if (sai.length) {
    throw new AppError(`Chỉ cài ca riêng cho ${NHOM_CA_RIENG.join(' / ')} (nhận được: ${sai.join(', ')})`, { status: 422, errorCode: 'INVALID' });
  }
  if (ds.length && !(await repo.caTuanCoLoaiChuyen())) {
    throw new AppError('Cơ sở dữ liệu chưa chạy migration 112 — chưa cài ca riêng theo loại chuyền được (chỉ cài chung)',
      { status: 409, errorCode: 'CHUA_MIGRATION_112' });
  }
  if (!ds.length) return [await repo.upsertCaTuan({ nam: y, tuan: w, loaiCa, ghiChu }, actorId)];
  const out = [];
  for (const lc of ds) out.push(await repo.upsertCaTuan({ nam: y, tuan: w, loaiCa, ghiChu, loaiChuyen: lc }, actorId));
  return out;
}

// Nhãn cột "Test" (Danh sách release, mẫu checklist): QA đạt ⇒ OK · đạt nhờ "In không đạt" ⇒ "KĐ cho IN" ·
// lệnh đã qua khỏi Test Run mà không có QA đạt (bổ sung / mẫu SL / SL < 100 / "Không test run" / gia công) ⇒
// "Không test" · còn ở Test Run có lần test lỗi ⇒ "Lỗi" · chưa test ⇒ rỗng.
function nhanTestRelease(r) {
  if (r.test_qa_dat) return r.test_kd_cho_in ? 'KĐ cho IN' : 'OK';
  if (r.lenh_trang_thai && r.lenh_trang_thai !== 'RELEASE_1') return 'Không test';
  return r.test_loi ? 'Lỗi' : '';
}

// ----- DANH SÁCH RELEASE (modal/report + Excel/In) -----
// `mode`: 'KE_HOACH' (mặc định) lọc theo ngày kế hoạch · 'RELEASE' lọc theo ngày TẠO LỆNH.
//
// ⚠ Mỗi (lệnh × phần in) = 1 dòng ⇒ lệnh gom set ra nhiều dòng. Vì vậy:
//   · `sl_release` cộng theo `sl_release_phan` (đã tách theo phần in) — cộng `so_luong_release`
//     của từng dòng sẽ ĐẾM TRÙNG số của lệnh gom set.
//   · `sl_da_in`/`sl_da_giao` chỉ có ở mức LỆNH nên chỉ giữ ở DÒNG ĐẦU của mỗi lệnh (`la_dong_dau`),
//     dòng sau để `null` ⇒ nhìn vào bảng/Excel không ai cộng dồn thành số sai.
//   · `so_lenh` để biết số ĐỢT SẢN XUẤT (khác số dòng khi có gom set).
async function releaseList(date, mode = 'KE_HOACH', denNgay = null) {
  if (!date) throw new AppError('Thiếu ngày', { status: 422, errorCode: 'NO_DATE' });
  const [raw, modeMap] = await Promise.all([
    repo.releaseListByDate(date, mode, denNgay),
    repo.caModeMap().catch(() => new Map()),
  ]);
  // SL đã in / SL giao THEO CODE PHẦN (mọi lệnh sống của phần in, cả đợt vải trước — 29/10/2026) ⇒ `sl_da_in_pin` /
  //   `sl_da_giao_pin` ở MỌI dòng. `sl_da_in` (của chính lệnh) giữ cho cột "SL IN" + các cột sau sản xuất.
  const theoPin = mode === 'IN_TEM' ? new Map()
    : await repo.daInGiaoTheoPhanIn([...new Set(raw.map((r) => r.phan_in_id))]);
  // CA KẾ HOẠCH của lệnh (26/10/2026 — ô lọc Ca ở Danh sách release): ca chứa GIỜ BẮT ĐẦU KH theo loại ca của tuần ×
  //   loại chuyền — CHÍNH luật `Ngayca` gửi ERP (`utils/ca.js ngayCaKeHoach`). Lệnh chưa có giờ BĐ KH ⇒ '' (không ca).
  const HAU = { HC: 'HC', C1: 'CA1', C2: 'CA2', C3: 'CA3', D1: 'D1', D2: 'D2' };
  const caKh = (r) => {
    if (!r.tg_bd_kh) return '';
    const vn = new Date(new Date(r.tg_bd_kh).getTime() + 7 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
    return HAU[String(ngayCaKeHoach(vn, null, modeMap, r.ma_loai_chuyen || null)).slice(-2)] || '';
  };
  const daThay = new Set();
  const items = raw.map((r) => {
    const dongDau = !daThay.has(r.lenh_id);
    daThay.add(r.lenh_id);
    const mucLenh = (v) => (dongDau ? v : null); // số sổ cái tem chỉ có ở mức LỆNH (tem không lưu phần in)
    return {
      ...r,
      la_dong_dau: dongDau,
      ca_kh: caKh(r),
      sl_da_in: mucLenh(r.sl_da_in),
      sl_da_giao: mucLenh(r.sl_da_giao),
      sl_da_in_pin: theoPin.get(r.phan_in_id)?.da_in ?? 0,
      sl_da_giao_pin: theoPin.get(r.phan_in_id)?.da_giao ?? 0,
      sl_dat: mucLenh(r.sl_dat),
      sl_sua_dat: mucLenh(r.sl_sua_dat),
      sl_huy: mucLenh(r.sl_huy),
      sl_oqc: mucLenh(r.sl_oqc),
      // Cột "Test" của bảng checklist — nhãn suy từ kết quả test CỦA LỆNH (§5.4).
      test_nhan: nhanTestRelease(r),
      // DANH MỤC KIỂM TRA Khuôn / Mực — theo ĐỢT của phần in trong lệnh; khách II/AD miễn Khuôn.
      khuon_nhan: r.khuon_ok ? 'OK' : (isKhuonOptional(r.ten_khach_hang) ? 'Miễn' : ''),
      muc_nhan: r.muc_ok ? 'OK' : '',
      // Nhãn tiếng Việt của giai đoạn HIỆN TẠI — dùng chung `STAGE_LABEL` với dashboard/Đơn hàng.
      // Trả lời trực tiếp câu "release 51 phần hôm 15/08, giờ chúng đang ở đâu".
      giai_doan_ten: STAGE_LABEL[r.giai_doan_hien_tai] || r.giai_doan_hien_tai || '—',
    };
  });
  const uniq = (key) => new Set(items.map((r) => r[key]).filter(Boolean)).size;
  return {
    items,
    meta: {
      ngay: date,
      mode,
      so_lenh: daThay.size,
      tong_don: uniq('ma_don_hang'),
      tong_ma: uniq('ma_hang'),
      tong_phan: uniq('ma_phan'),
      sl_release: items.reduce((s, r) => s + (Number(r.sl_release_phan) || 0), 0),
      ...tongDoanhThuRelease(items),
    },
  };
}

// Tổng DOANH THU của danh sách release — gương FE `cotChecklistRelease.tongDoanhThuRelease` (FE tính lại trên tập
// đang lọc). Doanh thu 1 DÒNG (đợt SX × phần in) = đơn giá (mig 113) × SL RELEASE của dòng đó (`sl_release_phan`)
// — 13/10/2026, người dùng chốt "nhân với số lượng release chứ không phải số lượng đơn hàng" (bản 11/10 nhân SLĐH
// rồi phải tính mỗi phần in 1 lần). SL release của từng dòng là số riêng ⇒ CỘNG THẲNG mọi dòng. Giá và từng dòng
// làm tròn 2 số lẻ như FE (`soGia` · `doanhThu`) để tổng 2 bên khớp tới đồng lẻ. `so_thieu_gia` = số PHẦN IN chưa
// có giá (ERP chưa gửi) để người xem biết tổng còn thiếu.
function tongDoanhThuRelease(items) {
  let tong = 0; const thieu = new Set();
  for (const r of items) {
    const gia = r.don_gia == null || r.don_gia === '' ? NaN : Number(r.don_gia);
    if (!Number.isFinite(gia)) { thieu.add(r.phan_in_id || r.ma_phan || r); continue; }
    tong += Math.round(gia * (Number(r.sl_release_phan ?? r.so_luong_release) || 0) * 100) / 100;
  }
  return { tong_doanh_thu: Math.round(tong * 100) / 100, so_thieu_gia: thieu.size };
}

// ----- Danh sách "đã hoàn thành" theo ngày (cho DonePanel bên trái) -----
// ⚠⚠ `attachPhanInList` là BẮT BUỘC ở các sidebar mức LỆNH (fix 20/08/2026): `PHAN_INFO_LATERAL` chỉ
//   `LIMIT 1` nên lệnh GOM SET chỉ hiện phần in ĐẠI DIỆN ⇒ sidebar "Đã hoàn thành" đếm THIẾU phần in
//   so với dải "Theo dõi". Đo prod 20/08 (Test Run - QA): 81 lệnh QA xong chứa **104 phần in thật**,
//   nhưng sidebar chỉ hiện **77** — đúng 18 lệnh gom set bị giấu bớt thành viên.
async function release1Done(date) { return attachPhanInList(await repo.release1DoneByDate(date), 'lenh_id'); }
async function release2Done(date) { return attachPhanInList(await repo.planDoneByDate(date, 'RELEASE_2'), 'lenh_id'); }
async function replanDone(date) { return attachPhanInList(await repo.planDoneByDate(date, 'REPLAN'), 'lenh_id'); }
// Gắn các LẦN TEST (kết quả + nguyên nhân nếu lỗi) vào từng dòng → cột "Lần test 1..N" ở sidebar/Excel.
async function attachTestRuns(rows) {
  const ids = [...new Set(rows.map((r) => r.lenh_id).filter(Boolean))];
  if (!ids.length) return rows.map((r) => ({ ...r, tests: [] }));
  const trs = await repo.testRunsByLenh(ids);
  const byLenh = {};
  // ⚠ Chép CẢ `owner_cho_in` (lần "In không đạt"): thiếu là cột "Lần test" hiện "… · — cho IN" dù audit
  //   `IN_KHONG_DAT` có tên (lỗi tới 07/10/2026 — `testRunsByLenh` đọc tên mà bước này bỏ rơi).
  trs.forEach((t) => {
    (byLenh[t.lenh_san_xuat_id] || (byLenh[t.lenh_san_xuat_id] = []))
      .push({ lan: t.lan_test, ket_qua: t.ket_qua, ghi_chu: t.ghi_chu, owner_cho_in: t.owner_cho_in || null });
  });
  return rows.map((r) => ({ ...r, tests: byLenh[r.lenh_id] || [] }));
}

// ⚠ `attachPhanInList` chạy SAU `attachTestRuns`: nó tạo object MỚI (`{...r, phan_in_list}`) nên mọi
//   thứ sửa tại chỗ trên `rows` phải xong trước — đúng bẫy đã ghi ở `listTestRunCandidates`.
async function testCnspDone(date) { return attachPhanInList(await attachTestRuns(await repo.testDoneByDate(date, CNSP_CP)), 'lenh_id'); }
async function testQaDone(date) { return attachPhanInList(await attachTestRuns(await repo.testDoneByDate(date, QA_CP)), 'lenh_id'); }

// ─── BTP KHÁC KẾ HOẠCH (mig 120, 28/10/2026) — trang *Hệ thống › BTP khác kế hoạch* ───────────────────────────────
// Người lập kế hoạch QUÊN tích "BTP khác KH" lúc Release 1 ⇒ đợt đã release đủ SL rời màn ⇒ ở đây tìm phần in, THÊM 1
// ĐẦU cho đợt ⇒ đợt quay về Release 1 với "Còn release" = SL vải cho đầu kế. BỎ = bỏ đầu đang chờ (không bao giờ hạ dưới
// phần đã lập — lệnh đã tạo giữ nguyên). Luật: `utils/btpKhacKh.js` (29/10/2026: nhiều đầu, không còn cờ 2 đầu).
const UUID_BTP = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function timBtpKhacKh(q) {
  const [coCot, rows] = await Promise.all([coCotBtp(), repo.timBtpKhacKh(q)]);
  return {
    co_cot: coCot,
    rows: rows.map((r) => ({ ...r, btp_cho: coDauCho(r.so_luong_vai_ve, r.da_release + r.sl_ke_hoach_tam, r.so_dau_btp) })),
  };
}

async function datBtpKhacKh(dotVaiId, { bat, lyDo } = {}, actorId) {
  if (!UUID_BTP.test(String(dotVaiId || ''))) throw new AppError('Đợt vải không hợp lệ', { status: 422, errorCode: 'INVALID_ID' });
  if (!(await coCotBtp())) {
    throw new AppError('Chưa chạy migration 120 (BTP khác kế hoạch) — báo IT chạy rồi thử lại', { status: 409, errorCode: 'CHUA_MIGRATION_120' });
  }
  const ly = String(lyDo || '').trim();
  if (!ly) throw new AppError('Nhập lý do', { status: 422, errorCode: 'NO_LY_DO' });
  if (ly.length > 300) throw new AppError('Lý do tối đa 300 ký tự', { status: 422, errorCode: 'LY_DO_QUA_DAI' });
  const muonBat = !!bat;
  const kq = await withTransaction(async (client) => {
    const d = await repo.docDotBtpTx(client, dotVaiId);
    if (!d) throw new AppError('Không tìm thấy đợt vải', { status: 404, errorCode: 'NOT_FOUND' });
    if (['DA_HUY', 'DA_GOP'].includes(d.trang_thai)) throw new AppError(`Đợt ${d.ma_dot_vai} đã hủy / gộp`, { status: 409, errorCode: 'WRONG_STAGE' });
    const doi = await datSoDauTx(client, [d.id], actorId, { them: muonBat, nguon: 'HE_THONG', lyDo: ly });
    return { ...d, doi: doi.length > 0, so_dau_moi: doi.length ? doi[0].moi : d.so_dau_btp };
  });
  if (kq.doi) {
    sockets.emit('workflow:updated', { dotVaiId: kq.id, btpKhacKh: muonBat });
    sockets.emit('dashboard:refresh', {});
  }
  return {
    dot_vai_id: kq.id, ma_dot_vai: kq.ma_dot_vai, ma_phan: kq.ma_phan, btp_khac_kh: kq.so_dau_moi > 1,
    so_dau_btp: kq.so_dau_moi, da_doi: kq.doi,
  };
}

module.exports = {
  assertKhongOGn,
  listRelease1Candidates, autoPlanCandidates, createRelease1, traVeKyThuat, createDotSanXuat, release1History, listReleaseSets, releaseSet,
  listGopCandidates, gopDotVai, gopHistory,
  getReplanDetail, suaKeHoachTuDsRelease,
  listTestRunCandidates, getLenhDetail, recordTestRun, confirmTest, confirmTestBatch, cancelTest, listOwnerChoIn,
  returnTestRunToReady, traVeKeHoachTuTestRun, listTestRunTraVeKh, xacNhanLaiTestRunTraVe,
  listRelease2Candidates, approveRelease2, approveRelease2Batch, skipTestRun, testRunHistory,
  listReplanCandidates, replan, replanBatch, planHistory,
  listReplanIds: (o) => repo.listReplanIds(o),
  listReplanMaQuet: (o) => repo.listReplanMaQuet(o),  listGiaCong, confirmGiaCongToOqc, giaCongHistory, listGiaCongTemCancelable, cancelGiaCongTem, traLaiNhaGiaCong,
  listKeHoachTam, keHoachTamSet, confirmKeHoachTam, updateKeHoachTam, deleteKeHoachTam, keHoachTamHistory, keHoachTamDone, keHoachTamTheoDoi,
  listKeHoachTamHuy, huyKeHoachTam,
  listCancelableLenh, rollbackLenh, testRunsChoHuy, listLanTestChoHuy, huyLanTest,
  release1Done, release2Done, replanDone, testCnspDone, testQaDone,
  releaseList,
  listCaTuan, upsertCaTuan,
  timBtpKhacKh, datBtpKhacKh,
};
