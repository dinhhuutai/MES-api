const repo = require('./phaninadmin.repository');
const planningService = require('../planning/planning.service');
const ordersService = require('../orders/orders.service');
const technicalService = require('../technical/technical.service');
const erpsyncRepo = require('../erpsync/erpsync.repository');
// HSKT active của phần in — để tính lại phương án in khi đổi LOẠI đợt vải / SL vải về (16/09/2026).
// ⚠ Chỉ require REPOSITORY (không phải service) nên không có vòng require.
const hsktRepo = require('../hskt/hskt.repository');
const sockets = require('../../sockets');
const AppError = require('../../utils/AppError');
const { query } = require('../../config/db');
const khoaErp = require('../../utils/khoaErp');

// ─────────────────────────────────────────────────────────────────────────────
// QUẢN TRỊ PHẦN IN — một chỗ gỡ rối mọi thứ của 1 phần in.
//
// ⚠⚠ NGUYÊN TẮC: **TÁI DÙNG service đang chạy ngoài giao diện**, KHÔNG viết đường ghi riêng.
//   Đổi giai đoạn = gọi `planning.rollbackLenh` (chính hàm của tab "Hủy lệnh sản xuất");
//   hủy/mở đợt vải = gọi `orders.softDeleteDotVai`/`reopenDotVai` (chính hàm của tab Hủy/Mở đợt vải).
//   Viết SQL riêng ở đây là sớm muộn lệch guard với phần còn lại của hệ.
// ─────────────────────────────────────────────────────────────────────────────

async function traCuu(search) {
  return repo.traCuu(search || '', 30);
}

async function chiTiet(phanInId) {
  const pin = await repo.getPhanIn(phanInId);
  if (!pin) throw new AppError('Phần in không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const [ready, dotVai, loaiDotVai, toanCanh, coKhoa] = await Promise.all([
    repo.getReady(phanInId), repo.getDotVaiList(phanInId), repo.danhMucLoaiDotVai(), repo.toanCanh(phanInId),
    khoaErp.coCotKhoaErp(),
  ]);
  // Khóa ERP (mig 116): người khóa đọc riêng — cột có thể chưa có (chưa chạy mig) nên không JOIN trong getPhanIn.
  let khoa = { co_cot: coKhoa, dang_khoa: !!pin.khoa_erp, tg: pin.khoa_erp_tg || null, nguoi: null };
  if (coKhoa && pin.khoa_erp_boi) {
    const { rows } = await query('SELECT ho_ten FROM nguoi_dung WHERE id = $1', [pin.khoa_erp_boi]);
    khoa = { ...khoa, nguoi: rows[0] ? rows[0].ho_ten : null };
  }
  return { phan_in: pin, ready, dot_vai: dotVai, loai_dot_vai: loaiDotVai, toan_canh: toanCanh, khoa_erp: khoa, dich_lui: DICH_LUI };
}

// ─── SỬA TRƯỜNG ──────────────────────────────────────────────────────────────
// `opts.khoa` = sửa từ TRANG Quản trị phần in ⇒ tự KHÓA đồng bộ ERP của phần in (mig 116, `utils/khoaErp.js`).
// Hàm còn được trang GN (sửa tay, không khóa) và luồng ERP (`suathongtin/erpCapNhat` — đã tự bỏ qua phần in khóa) dùng chung.
async function suaPhanIn(phanInId, patch, actorId, opts = {}) {
  const truoc = await repo.getPhanIn(phanInId);
  if (!truoc) throw new AppError('Phần in không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const kq = await repo.updatePhanIn(phanInId, patch || {}, actorId);
  if (!kq) throw new AppError('Không có trường nào hợp lệ để sửa', { status: 422, errorCode: 'NO_FIELD' });
  const cu = {}; const moi = {};
  kq.cols.forEach((c) => { cu[c] = truoc[c]; moi[c] = kq.row[c]; });
  await repo.ghiAudit('phan_in', phanInId, 'QUAN_TRI_SUA_PHAN_IN', cu, moi, actorId);
  const daKhoa = opts.khoa ? await khoaSauKhiSua(phanInId, actorId) : false;
  sockets.emit('dashboard:refresh', {});
  return { id: phanInId, cols: kq.cols, khoa_erp: daKhoa };
}

// Khóa ERP sau khi sửa tay — best-effort: chưa chạy mig 116 thì sửa vẫn xong, chỉ không khóa.
async function khoaSauKhiSua(phanInId, actorId) {
  try { await khoaErp.datKhoa(phanInId, true, actorId, { lyDo: 'Sửa tay ở Quản trị phần in' }); return true; } catch (e) {
    if (e.errorCode !== 'CHUA_MIGRATION_116') console.error(`[quan-tri-phan-in] ✗ Khóa ERP lỗi: ${e.message}`);
    return false;
  }
}

async function datKhoaErp(phanInId, khoa, actorId) {
  const pin = await repo.getPhanIn(phanInId);
  if (!pin) throw new AppError('Phần in không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const doi = await khoaErp.datKhoa(phanInId, !!khoa, actorId,
    { lyDo: khoa ? 'Khóa tay ở Quản trị phần in' : 'Mở khóa ở Quản trị phần in' });
  return { phan_in_id: phanInId, khoa_erp: !!khoa, doi };
}

async function suaDotVai(dotVaiId, patch, actorId, opts = {}) {
  const truoc = await repo.getDotVaiRaw(dotVaiId);
  if (!truoc) throw new AppError('Đợt vải không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });

  // ⚠ Guard SL vải về: không hạ xuống dưới SL ĐÃ IN TEM của chính đợt đó — hạ nữa là sổ cái số lượng
  //   sai (in nhiều hơn nhận), đúng luật đang áp ở trang "Cập nhật SL nhận vải / release".
  if ('so_luong_vai_ve' in (patch || {})) {
    const moiSl = Number(patch.so_luong_vai_ve);
    if (!Number.isFinite(moiSl) || moiSl < 0) {
      throw new AppError('SL vải về phải là số ≥ 0', { status: 422, errorCode: 'INVALID_QTY' });
    }
    const daIn = await repo.slDaInCuaDotVai(dotVaiId);
    if (moiSl < daIn) {
      throw new AppError(`SL vải về (${moiSl}) nhỏ hơn SL đã in tem (${daIn}) của đợt này`,
        { status: 409, errorCode: 'DUOI_SL_DA_IN' });
    }
  }

  const kq = await repo.updateDotVai(dotVaiId, patch || {}, actorId);
  if (!kq) throw new AppError('Không có trường nào hợp lệ để sửa', { status: 422, errorCode: 'NO_FIELD' });
  const cu = {}; const moi = {};
  kq.cols.forEach((c) => { cu[c] = truoc[c]; moi[c] = kq.row[c]; });
  await repo.ghiAudit('dot_vai_ve', dotVaiId, 'QUAN_TRI_SUA_DOT_VAI', cu, moi, actorId);

  // ⚠⚠ ĐỔI LOẠI ĐỢT VẢI / SL VẢI VỀ ⇒ TÍNH LẠI PHƯƠNG ÁN IN (người dùng chốt 16/09/2026).
  //   · loại → BỔ SUNG  ⇒ hồ sơ phải về in BÀN ngay, không chờ job ERP 5 phút.
  //   · đổi SL vải về  ⇒ tổng của hồ sơ đổi ⇒ ngưỡng 2000 có thể lật (vốn là gap sẵn có của màn này:
  //     trước đây sửa SL ở đây thì PA in chỉ được tính lại khi job ERP chạm tới hồ sơ đó).
  // ⚠ Tái dùng ĐÚNG `erpsync.applyPainTheoSanLuong` — hàm mà job ERP và Nhập tay đang gọi; tuyệt đối
  //   đừng chép luật ra chỗ mới (nó còn lo tạo phiên bản HSKT + đổi số cuối barcode + ghi lịch sử).
  // ⚠ BEST-EFFORT: hỏng bước này KHÔNG được làm hỏng việc sửa đợt vải vừa ghi xong.
  let painMoi = null;
  if (kq.cols.includes('loai_dot_vai_id') || kq.cols.includes('so_luong_vai_ve')) {
    try {
      const hs = await hsktRepo.activeHsktOfPhanIn(truoc.phan_in_id);
      if (hs) {
        const r = await erpsyncRepo.applyPainTheoSanLuong(hs.id, actorId);
        if (r && r.doi) painMoi = r;
      }
    } catch (e) {
      console.error(`[quan-tri-phan-in] ✗ Tính lại phương án in sau khi sửa đợt vải ${dotVaiId}: ${e.message}`);
    }
  }
  const daKhoa = opts.khoa ? await khoaSauKhiSua(truoc.phan_in_id, actorId) : false;
  sockets.emit('dashboard:refresh', {});
  sockets.emit('workflow:updated', { dotVaiId });
  if (painMoi) sockets.emit('ready:confirmed', { phanInId: truoc.phan_in_id, doi_phuong_an_in: true });
  return { id: dotVaiId, cols: kq.cols, phuong_an_in_moi: painMoi, khoa_erp: daKhoa };
}

// ─── ĐẶT LẠI GIAI ĐOẠN CHO 1 ĐỢT VẢI ────────────────────────────────────────
// ⚠⚠ Giai đoạn KHÔNG phải cột — muốn đưa đợt về chặng nào thì phải dựng lại trạng thái runtime của
//   chặng đó. Bảng ánh xạ dưới đây bám đúng `utils/stage.js`:
//     READY_KT  : hủy lệnh + hủy QC + hủy CẢ Khuôn/Film/Mực   → kỹ thuật làm lại từ đầu
//     READY_QA  : hủy lệnh + hủy QC (giữ 3 mục KT)            → chỉ QC xác nhận lại
//     RELEASE_1 : hủy lệnh, GIỮ xác nhận READY                → đợt về pool Release 1
//     TEST_RUN  : hạ lệnh RELEASE_2 → RELEASE_1               → quay lại chờ test
//   Xa hơn (Release 2 / Sản xuất trở đi) CỐ Ý KHÔNG cho đặt bằng tay: chặng đó đòi phiếu/tem/sổ cái
//   số lượng, dựng tay sẽ tạo dữ liệu không có thật. Muốn tiến tới thì thao tác ở đúng màn của nó.
const DICH = {
  READY_KT: { target: 'READY', huyMucKt: true, nhan: 'READY (Kỹ thuật)' },
  READY_QA: { target: 'READY', huyMucKt: false, nhan: 'READY (QA)' },
  RELEASE_1: { target: 'RELEASE_1', huyMucKt: false, nhan: 'Release 1' },
  TEST_RUN: { target: 'TEST_RUN', huyMucKt: false, nhan: 'Test Run' },
};

async function datGiaiDoan(dotVaiId, { dich, lyDo }, actorId) {
  const cfg = DICH[dich];
  if (!cfg) {
    throw new AppError(`Đích không hợp lệ. Chỉ nhận: ${Object.keys(DICH).join(' · ')}`,
      { status: 422, errorCode: 'DICH_KHONG_HOP_LE' });
  }
  if (!String(lyDo || '').trim()) {
    throw new AppError('Phải nhập lý do', { status: 422, errorCode: 'NO_LY_DO' });
  }
  const dv = await repo.getDotVaiRaw(dotVaiId);
  if (!dv) throw new AppError('Đợt vải không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (dv.trang_thai === 'DA_HUY') {
    throw new AppError('Đợt vải đang bị hủy — mở lại đợt trước rồi mới đặt giai đoạn', { status: 409, errorCode: 'DA_HUY' });
  }

  const ds = await repo.getDotVaiList(dv.phan_in_id);
  const hang = ds.find((r) => r.id === dotVaiId);
  const lenhId = hang?.lenh_id || null;
  const truoc = hang?.giai_doan || null;

  if (cfg.target === 'TEST_RUN' && (!lenhId || hang.lenh_trang_thai !== 'RELEASE_2')) {
    throw new AppError('Chỉ hạ về Test Run được khi lệnh đang ở Release 2', { status: 409, errorCode: 'NOT_RELEASE_2' });
  }

  // 1) Đổi trạng thái lệnh (nếu đợt đang thuộc lệnh nào) — dùng CHÍNH hàm của tab Hủy lệnh sản xuất,
  //    nên mọi guard sẵn có (đã in tem / tem đã qua KCS…) vẫn được tôn trọng.
  let ketQuaLenh = null;
  if (lenhId) {
    ketQuaLenh = await planningService.rollbackLenh(
      lenhId, { target: cfg.target, lyDo: `[Quản trị phần in] ${lyDo}` }, actorId
    );
  } else if (cfg.target === 'TEST_RUN') {
    throw new AppError('Đợt vải chưa thuộc lệnh nào', { status: 409, errorCode: 'NO_LENH' });
  }

  // 2) READY (Kỹ thuật): hủy thêm 3 mục Khuôn/Film/Mực + gắn cờ làm lại.
  //    ⚠ Tái dùng `erpsync.reopenReadyForPhanIn` — đúng hàm mà luồng ERP/`traVeKyThuat` đang dùng.
  if (cfg.huyMucKt) {
    await erpsyncRepo.reopenReadyForPhanIn(dv.phan_in_id);
  }
  // 2b) READY (QA) cho đợt CHƯA có lệnh (19/10/2026 — trước đó không hủy gì): hủy QC của chính đợt; QC nằm ở dòng
  //     tổng của phần in thì hủy dòng tổng (`technical.cancelItem` — cùng guard / audit của tab Hủy xác nhận READY).
  if (!lenhId && dich === 'READY_QA') {
    try { await technicalService.cancelItem(dv.phan_in_id, 'QC_XAC_NHAN', actorId, dotVaiId); } catch (e) {
      if (e.errorCode === 'O_DONG_TONG') await technicalService.cancelItem(dv.phan_in_id, 'QC_XAC_NHAN', actorId);
      else if (e.errorCode !== 'NOT_CONFIRMED') throw e;
    }
  }

  await repo.ghiAudit('dot_vai_ve', dotVaiId, 'QUAN_TRI_DAT_GIAI_DOAN',
    { giai_doan: truoc, lenh: hang?.ma_lenh_san_xuat || null, lenh_trang_thai: hang?.lenh_trang_thai || null },
    { dich, nhan: cfg.nhan, huy_muc_kt: cfg.huyMucKt, ly_do: String(lyDo).trim() }, actorId);

  sockets.emit('ready:confirmed', { phanInId: dv.phan_in_id });
  sockets.emit('workflow:updated', { dotVaiId, stage: dich });
  sockets.emit('dashboard:refresh', {});
  return { dot_vai_id: dotVaiId, tu: truoc, den: dich, nhan: cfg.nhan, lenh: ketQuaLenh };
}

// ─── HỦY / MỞ ĐỢT VẢI (tái dùng nguyên service của tab Hủy/Mở đợt vải) ───────
async function huyDotVai(dotVaiIds, lyDo, actorId) {
  return ordersService.softDeleteDotVai(dotVaiIds, lyDo, actorId);
}
async function moDotVai(dotVaiIds, actorId) {
  return ordersService.reopenDotVai(dotVaiIds, actorId);
}

// Hủy xác nhận READY lẻ từng mục (Khuôn/Film/Mực/QC) — tiện khi chỉ cần làm lại 1 mục.
// ⚠ Gọi thẳng `technical.cancelItem`: nó đã mang sẵn guard `ALREADY_RELEASED` (mọi đợt đã release thì
//   phải hủy lệnh ở trạm sau trước), luật cascade "hủy mục KT ⇒ hủy luôn QC", audit và socket.
//   Đợt đã release mà vẫn muốn về READY thì dùng "Đặt lại giai đoạn → READY (Kỹ thuật)" — đường đó
//   hủy lệnh trước nên không vướng guard.
async function huyMucReady(phanInId, maList, actorId) {
  const ma = (Array.isArray(maList) ? maList : []).filter((m) => ['KHUON', 'FILM', 'MUC', 'QC_XAC_NHAN'].includes(m));
  if (!ma.length) throw new AppError('Chọn ít nhất một mục', { status: 422, errorCode: 'NO_ITEM' });
  const huy = []; const boQua = [];
  for (const m of ma) {
    try { await technicalService.cancelItem(phanInId, m, actorId); huy.push(m); } catch (e) {
      // Mục chưa xác nhận / đã bị cascade hủy theo mục trước → bỏ qua, không làm hỏng cả lượt.
      if (e.errorCode === 'NOT_CONFIRMED') boQua.push(m);
      else throw e;
    }
  }
  await repo.ghiAudit('phan_in', phanInId, 'QUAN_TRI_HUY_MUC_READY', {}, { muc_huy: huy, bo_qua: boQua }, actorId);
  return { phan_in_id: phanInId, muc_huy: huy, bo_qua: boQua };
}

// ═════════════════════════════════════════════════════════════════════════════
// LÙI VỀ TRẠM BẤT KỲ — THEO LỆNH (19/10/2026, người dùng chốt "lùi về bất kỳ trạm", KHÔNG tiến).
//
// Trang dựng DANH SÁCH BƯỚC HỦY từ hiện trạng của lệnh (xem trước) rồi chạy LẦN LƯỢT từ bước SAU CÙNG ngược về —
// mỗi bước gọi ĐÚNG service hủy đang chạy ngoài giao diện (cùng guard, cùng audit, cùng báo ERP hủy như các nút Hủy):
//   CHO_GIAO     ← hủy phiếu giao                           (`delivery.huyPhieuGiao`)
//   OQC          ← + bỏ tích tem giao · hủy lượt OQC          (`delivery.boTichTem` · `quality.cancelOqc`)
//   SUA          ← + hủy lượt Sửa (tự đảo tem 17)             (`quality.cancelSua`)
//   KCS          ← + hủy phân loại lỗi · hủy lượt KCS         (`phanloailoi.huy` · `quality.cancelKcs`)
//   SAN_XUAT     ← + mở lại phiếu đã hoàn tất (không có phiếu đang chạy)   (`production.reopenProduction` bỏ hạn 2 ngày)
//   CHO_SAN_XUAT ← + hủy MỌI tem in · hủy xác nhận chạy MỌI phiếu (phiếu hoàn tất: mở lại rồi hủy)
//                  (`production.cancelPrintTem` / `planning.cancelGiaCongTem` · `production.undoStartProduction`)
//   TEST_RUN · RELEASE_1 · READY_QA · READY_KT ← + `planning.rollbackLenh` (force — đã dọn sạch tem/phiếu ở trên;
//                  guard "tem đã qua KCS/OQC/giao" của nó vẫn giữ) · READY_KT thêm `erpsync.reopenReadyForPhanIn`.
// Chạy dừng ở bước lỗi đầu tiên (bước trước đó đã ghi thật — mỗi service một transaction); bấm lại là dựng kế hoạch
// MỚI từ hiện trạng nên chạy tiếp được (idempotent). Lệnh gom set cũ (nhiều phần in) ⇒ cảnh báo, ảnh hưởng cả lệnh.
// ═════════════════════════════════════════════════════════════════════════════
const DICH_LUI = [
  { v: 'CHO_GIAO', ten: 'Chờ giao (đã qua OQC)', mo_ta: 'Hủy phiếu giao' },
  { v: 'OQC', ten: 'OQC (chờ OQC)', mo_ta: 'Hủy phiếu giao · bỏ tích tem · hủy lượt OQC' },
  { v: 'SUA', ten: 'Sửa (chờ sửa)', mo_ta: '… + hủy lượt Sửa (tem 17)' },
  { v: 'KCS', ten: 'KCS (chờ kiểm)', mo_ta: '… + hủy phân loại lỗi · hủy lượt KCS' },
  { v: 'SAN_XUAT', ten: 'Đang sản xuất (giữ tem)', mo_ta: '… + mở lại phiếu đã chạy hoàn tất' },
  { v: 'CHO_SAN_XUAT', ten: 'Chờ chạy / Release 2 (chưa in tem)', mo_ta: '… + hủy MỌI tem · hủy xác nhận chạy' },
  { v: 'TEST_RUN', ten: 'Test Run', mo_ta: '… + gỡ duyệt Release 2 + gỡ kết quả test (giữ lệnh)' },
  { v: 'RELEASE_1', ten: 'Release 1', mo_ta: '… + hủy lệnh, giữ xác nhận READY' },
  { v: 'READY_QA', ten: 'READY (QA)', mo_ta: '… + hủy lệnh + hủy QC READY' },
  { v: 'READY_KT', ten: 'READY (Kỹ thuật)', mo_ta: '… + hủy lệnh + hủy QC + hủy Khuôn/Film/Mực' },
];
const THU_TU_LUI = DICH_LUI.map((d) => d.v);
const LY = (lyDo) => `[Quản trị phần in] ${lyDo}`;
const moiTruoc = (a, b) => new Date(b.created_date || b.tg) - new Date(a.created_date || a.tg); // mới nhất trước

// Hàm THUẦN: kế hoạch các bước hủy để đưa lệnh `lenhId` về `dich`, từ ảnh chụp `tc` (= `repo.toanCanh`).
function dungBuocLui(tc, lenhId, dich) {
  const i = THU_TU_LUI.indexOf(dich);
  if (i < 0) throw new AppError(`Đích không hợp lệ. Chỉ nhận: ${THU_TU_LUI.join(' · ')}`, { status: 422, errorCode: 'DICH_KHONG_HOP_LE' });
  const tu = (d) => i >= THU_TU_LUI.indexOf(d);
  const lenh = tc.lenh.find((l) => l.id === lenhId);
  if (!lenh) throw new AppError('Lệnh không thuộc phần in này (hoặc đã hủy)', { status: 404, errorCode: 'NOT_FOUND' });
  const giaCong = lenh.trang_thai === 'GIA_CONG' || lenh.ma_loai_chuyen === 'GIA_CONG';
  if (giaCong && ['SAN_XUAT', 'TEST_RUN'].includes(dich)) {
    throw new AppError('Lệnh gia công không có trạm Sản xuất / Test Run', { status: 422, errorCode: 'GIA_CONG' });
  }
  const tems = tc.tem.filter((t) => t.lenh_san_xuat_id === lenhId && t.trang_thai !== 'HUY');
  const temSet = new Set(tems.map((t) => t.id));
  const maTem = new Map(tems.map((t) => [t.id, t.ma_tem]));
  const phieu = tc.phieu.filter((p) => p.lenh_san_xuat_id === lenhId);
  const b = [];
  if (tu('CHO_GIAO')) {
    tc.giao.filter((g) => (g.tem_ids || []).some((id) => temSet.has(id))).sort(moiTruoc)
      .forEach((g) => b.push({ loai: 'PHIEU_GIAO', id: g.id, nhan: `Hủy phiếu giao ${g.ma_phieu_giao} (${g.so_luong} pcs)` }));
  }
  if (tu('OQC')) {
    tems.filter((t) => t.da_tich_giao).forEach((t) => b.push({ loai: 'TICH_GIAO', id: t.id, nhan: `Bỏ tích giao tem ${t.ma_tem}` }));
    tc.oqc.filter((o) => temSet.has(o.tem_id)).sort(moiTruoc)
      .forEach((o) => b.push({ loai: 'OQC', id: o.id, nhan: `Hủy OQC tem ${maTem.get(o.tem_id)} (qua giao ${o.sl_qua_giao ?? o.so_luong_dat ?? 0})` }));
  }
  if (tu('SUA')) {
    tc.sua.filter((s) => temSet.has(s.tem_id)).sort(moiTruoc)
      .forEach((s) => b.push({ loai: 'SUA', id: s.id, nhan: `Hủy lượt Sửa tem ${maTem.get(s.tem_id)} (đạt ${s.so_luong_sua_dat || 0}, hủy ${s.so_luong_sua_huy || 0})` }));
  }
  if (tu('KCS')) {
    tc.pll.filter((p) => temSet.has(p.tem_id))
      .forEach((p) => b.push({ loai: 'PLL', id: p.tem_id, nhan: `Hủy phân loại lỗi tem ${maTem.get(p.tem_id)}` }));
    tc.kcs.filter((k) => temSet.has(k.tem_id)).sort(moiTruoc)
      .forEach((k) => b.push({ loai: 'KCS', id: k.id, nhan: `Hủy lượt KCS tem ${maTem.get(k.tem_id)} (kiểm ${k.so_luong_kiem || 0})` }));
  }
  if (dich === 'SAN_XUAT' && !phieu.some((p) => p.trang_thai === 'DANG_CHAY')) {
    const xong = phieu.filter((p) => p.trang_thai === 'HOAN_TAT').sort(moiTruoc)[0];
    if (xong) b.push({ loai: 'MO_LAI_PHIEU', id: xong.id, nhan: `Mở lại phiếu ${xong.ma_phieu_san_xuat || ''} (về đang chạy)` });
  }
  if (tu('CHO_SAN_XUAT')) {
    tems.filter((t) => !t.tem_goc_id).sort(moiTruoc)
      .forEach((t) => b.push({ loai: giaCong ? 'TEM_GIA_CONG' : 'TEM', id: t.id, nhan: `Hủy tem ${t.ma_tem} (${t.so_luong} pcs)` }));
    if (!giaCong) {
      phieu.filter((p) => p.trang_thai === 'DANG_CHAY')
        .forEach((p) => b.push({ loai: 'HUY_CHAY', id: p.id, nhan: `Hủy xác nhận chạy phiếu ${p.ma_phieu_san_xuat || ''}` }));
      phieu.filter((p) => p.trang_thai === 'HOAN_TAT').sort(moiTruoc).forEach((p) => {
        b.push({ loai: 'MO_LAI_PHIEU', id: p.id, nhan: `Mở lại phiếu ${p.ma_phieu_san_xuat || ''}` });
        b.push({ loai: 'HUY_CHAY', id: p.id, nhan: `Hủy xác nhận chạy phiếu ${p.ma_phieu_san_xuat || ''}` });
      });
    }
  }
  if (tu('TEST_RUN')) {
    const target = dich === 'TEST_RUN' ? 'TEST_RUN' : dich === 'RELEASE_1' ? 'RELEASE_1' : 'READY';
    // Về Test Run: chỉ khi còn gì để gỡ (đã duyệt R2 / đã có kết quả test) — không thì lệnh vốn đang ở Test Run.
    const canGo = target !== 'TEST_RUN' || lenh.trang_thai !== 'RELEASE_1' || lenh.test_dat || tems.length || phieu.length;
    if (canGo) b.push({ loai: 'LENH', id: lenhId, target, nhan: `Lệnh ${lenh.ma_lenh_san_xuat} → ${DICH_LUI.find((d) => d.v === dich).ten}` });
    if (dich === 'READY_KT') b.push({ loai: 'MO_READY_KT', id: lenhId, nhan: 'Hủy Khuôn/Film/Mực — kỹ thuật làm lại' });
  }
  const canhBao = [];
  if (lenh.so_phan_in > 1) canhBao.push(`Lệnh ${lenh.ma_lenh_san_xuat} gom ${lenh.so_phan_in} phần in (${lenh.phan_in_khac}) — lùi lệnh là lùi CẢ các phần in đó`);
  return { lenh, buoc: b, canh_bao: canhBao };
}

// Chạy 1 bước — map loại → service hủy đang có.
async function chayBuoc(bu, lyDo, actorId, phanInId) {
  const ly = LY(lyDo);
  const quality = require('../quality/quality.service');
  const production = require('../production/production.service');
  switch (bu.loai) {
    case 'PHIEU_GIAO': return require('../delivery/delivery.service').huyPhieuGiao(bu.id, ly, actorId);
    case 'TICH_GIAO': return require('../delivery/delivery.service').boTichTem([bu.id], actorId);
    case 'OQC': return quality.cancelOqc(bu.id, ly, actorId);
    case 'SUA': return quality.cancelSua(bu.id, ly, actorId);
    case 'PLL': return require('../quality/phanloailoi.service').huy(bu.id, ly, actorId);
    case 'KCS': return quality.cancelKcs(bu.id, ly, actorId);
    case 'MO_LAI_PHIEU': return production.reopenProduction(bu.id, actorId, { boQuaHan: true });
    case 'TEM': return production.cancelPrintTem(bu.id, ly, actorId);
    case 'TEM_GIA_CONG': return planningService.cancelGiaCongTem(bu.id, { lyDo: ly }, actorId);
    case 'HUY_CHAY': return production.undoStartProduction(bu.id, actorId);
    case 'LENH': return planningService.rollbackLenh(bu.id, { target: bu.target, lyDo: ly, force: true }, actorId);
    case 'MO_READY_KT': {
      // Mọi phần in của lệnh (lệnh gom set cũ có thể nhiều) — gọi SAU khi lệnh đã hủy (thứ tự bắt buộc, xem traVeKyThuat).
      const { rows } = await query('SELECT DISTINCT dv.phan_in_id FROM lenh_sx_dot_vai l JOIN dot_vai_ve dv ON dv.id = l.dot_vai_ve_id WHERE l.lenh_san_xuat_id = $1', [bu.id]);
      for (const r of (rows.length ? rows : [{ phan_in_id: phanInId }])) await erpsyncRepo.reopenReadyForPhanIn(r.phan_in_id);
      return { phan_in: rows.length };
    }
    default: throw new AppError(`Bước không hỗ trợ: ${bu.loai}`, { status: 422, errorCode: 'BUOC_LA' });
  }
}

async function luiVe(phanInId, lenhId, { dich, lyDo, xemTruoc = false } = {}, actorId) {
  const tc = await repo.toanCanh(phanInId);
  const ke = dungBuocLui(tc, lenhId, dich);
  if (xemTruoc) return { xem_truoc: true, dich, ...ke };
  if (!String(lyDo || '').trim()) throw new AppError('Phải nhập lý do', { status: 422, errorCode: 'NO_LY_DO' });
  if (!ke.buoc.length) throw new AppError('Lệnh đã ở đúng trạm này — không có gì để hủy', { status: 409, errorCode: 'NOOP' });
  const xong = [];
  let loi = null;
  for (const bu of ke.buoc) {
    try { await chayBuoc(bu, String(lyDo).trim(), actorId, phanInId); xong.push(bu); } catch (e) {
      loi = { buoc: bu, message: e.message, errorCode: e.errorCode || null };
      break;
    }
  }
  await repo.ghiAudit('lenh_san_xuat', lenhId, 'QUAN_TRI_LUI_VE',
    { lenh: ke.lenh.ma_lenh_san_xuat, trang_thai: ke.lenh.trang_thai },
    { phan_in_id: phanInId, dich, ly_do: String(lyDo).trim(), so_buoc: ke.buoc.length, da_xong: xong.map((x) => x.nhan), loi }, actorId);
  sockets.emit('workflow:updated', { lenhId, stage: dich });
  sockets.emit('production:updated', { lenhId, action: 'quan-tri-lui' });
  sockets.emit('quality:updated', { lenhId });
  sockets.emit('dashboard:refresh', {});
  return { dich, tong: ke.buoc.length, xong, loi };
}

// ─── HỦY LẺ 1 BẢN GHI (tem · lượt KCS/Sửa/OQC · phân loại lỗi · phiếu giao · tích tem · phiếu · lần test) ───────
// Kiểm bản ghi THUỘC phần in này (qua `toanCanh`) rồi gọi đúng service hủy / mở lại đang có.
const HUY_LE = {
  PHIEU_GIAO: (tc, id) => tc.giao.some((g) => g.id === id),
  TICH_GIAO: (tc, id) => tc.tem.some((t) => t.id === id && t.da_tich_giao),
  OQC: (tc, id) => tc.oqc.some((x) => x.id === id),
  SUA: (tc, id) => tc.sua.some((x) => x.id === id),
  PLL: (tc, id) => tc.pll.some((x) => x.tem_id === id),
  KCS: (tc, id) => tc.kcs.some((x) => x.id === id),
  TEM: (tc, id) => tc.tem.some((t) => t.id === id && t.trang_thai !== 'HUY'),
  TEM_GIA_CONG: (tc, id) => tc.tem.some((t) => t.id === id && t.trang_thai !== 'HUY'),
  MO_LAI_TEM: (tc, id) => tc.tem.some((t) => t.id === id && t.mo_lai_duoc),
  HUY_CHAY: (tc, id) => tc.phieu.some((p) => p.id === id && p.trang_thai === 'DANG_CHAY'),
  CHAY_HOAN_TAT: (tc, id) => tc.phieu.some((p) => p.id === id && p.trang_thai === 'DANG_CHAY'),
  MO_LAI_PHIEU: (tc, id) => tc.phieu.some((p) => p.id === id && p.trang_thai === 'HOAN_TAT'),
  TEST_RUN: (tc, id) => tc.test.some((x) => x.id === id),
};
async function huyLe(phanInId, { loai, id, lyDo } = {}, actorId) {
  const kiem = HUY_LE[loai];
  if (!kiem) throw new AppError('Loại thao tác không hợp lệ', { status: 422, errorCode: 'LOAI_LA' });
  const ly = String(lyDo || '').trim();
  if (!ly) throw new AppError('Phải nhập lý do', { status: 422, errorCode: 'NO_LY_DO' });
  const tc = await repo.toanCanh(phanInId);
  if (!kiem(tc, id)) throw new AppError('Bản ghi không thuộc phần in này hoặc không còn ở trạng thái làm được thao tác này', { status: 404, errorCode: 'NOT_FOUND' });
  const production = require('../production/production.service');
  let kq;
  if (loai === 'MO_LAI_TEM') kq = await production.reopenPrintTem(id, LY(ly), actorId);
  else if (loai === 'CHAY_HOAN_TAT') kq = await production.closeProduction(id, LY(ly), actorId);
  else if (loai === 'TEST_RUN') kq = await planningService.huyLanTest(id, { lyDo: LY(ly) }, actorId);
  else kq = await chayBuoc({ loai, id }, ly, actorId, phanInId);
  await repo.ghiAudit('phan_in', phanInId, 'QUAN_TRI_HUY_LE', {}, { loai, id, ly_do: ly }, actorId);
  sockets.emit('dashboard:refresh', {});
  return { loai, id, ket_qua: kq || null };
}

// ─── PHÂN CÔNG của 1 phiếu (sửa / xóa) ───────────────────────────────────────
// Phiếu ĐANG CHẠY ⇒ `production.savePhanCong` (luật phân công đầu ca theo chuyền: áp cả lệnh khác cùng chuyền trong ca);
// phiếu đã xong ⇒ chỉ ghi phiếu đó (`suaPhanCongPhieuXong`). Xóa = gửi các ô rỗng.
async function luuPhanCong(phanInId, phieuId, body, actorId) {
  const tc = await repo.toanCanh(phanInId);
  const p = tc.phieu.find((x) => x.id === phieuId);
  if (!p) throw new AppError('Phiếu không thuộc phần in này', { status: 404, errorCode: 'NOT_FOUND' });
  const b = {
    caTruongId: body.caTruongId || null, chuyenTruong: String(body.chuyenTruong || '').trim(),
    thoIn: String(body.thoIn || '').trim(), toInId: body.toInId || null,
  };
  const production = require('../production/production.service');
  if (p.trang_thai === 'DANG_CHAY') await production.savePhanCong(phieuId, b, actorId);
  else await production.suaPhanCongPhieuXong(phieuId, b, actorId);
  await repo.ghiAudit('phieu_san_xuat', phieuId, 'QUAN_TRI_PHAN_CONG',
    { ca_truong_id: p.ca_truong_id, chuyen_truong: p.chuyen_truong, tho_in: p.tho_in, to_in_id: p.to_in_id },
    { ...b, phan_in_id: phanInId }, actorId);
  return { phieu_id: phieuId, dang_chay: p.trang_thai === 'DANG_CHAY' };
}

// ─── SỬA KẾ HOẠCH (26/10/2026, người dùng: "Quản trị phần in cho sửa thông tin của kế hoạch") ───────────────────
// Lệnh: gọi CHÍNH `planning.replan` (Lập lại kế hoạch — dời giờ, trần SL theo vải, không dưới SL đã in, audit REPLAN,
//   báo ERP kế hoạch) với `choDaChay` ⇒ nhận cả lệnh in đã xác nhận chạy (chỉ sửa thông tin, không đổi chặng, không qua
//   gia công). Kế hoạch tạm (đợt chưa Ready): gọi CHÍNH `planning.updateKeHoachTam`. Lý do bắt buộc (như mọi thao tác
//   ở trang này), ghi kèm audit `QUAN_TRI_SUA_KE_HOACH`.
async function xemKeHoachLenh(phanInId, lenhId) {
  const tc = await repo.toanCanh(phanInId);
  if (!tc.lenh.some((l) => l.id === lenhId)) throw new AppError('Lệnh không thuộc phần in này (hoặc đã hủy)', { status: 404, errorCode: 'NOT_FOUND' });
  return planningService.getReplanDetail(lenhId);
}

async function suaKeHoachLenh(phanInId, lenhId, body = {}, actorId) {
  const ly = String(body.lyDo || '').trim();
  if (!ly) throw new AppError('Phải nhập lý do', { status: 422, errorCode: 'NO_LY_DO' });
  const tc = await repo.toanCanh(phanInId);
  const l = tc.lenh.find((x) => x.id === lenhId);
  if (!l) throw new AppError('Lệnh không thuộc phần in này (hoặc đã hủy)', { status: 404, errorCode: 'NOT_FOUND' });
  const kq = await planningService.replan(lenhId, {
    chuyenId: body.chuyenId || null, ngayKeHoach: body.ngayKeHoach, tgBdKh: body.tgBdKh || null, tgKtKh: body.tgKtKh || null,
    slRelease: body.slRelease || null, thoIn: body.thoIn, lyDo: LY(ly),
    btp: typeof body.btp === 'boolean' ? body.btp : undefined,
  }, actorId, { choDaChay: true, nguon: 'QUAN_TRI_PHAN_IN' });
  await repo.ghiAudit('lenh_san_xuat', lenhId, 'QUAN_TRI_SUA_KE_HOACH',
    { chuyen_id: l.chuyen_id, ngay_ke_hoach: l.ngay_ke_hoach, tg_bd_kh: l.tg_bd_kh, tg_kt_kh: l.tg_kt_kh, tho_in_kh: l.tho_in_kh, so_luong_release: l.so_luong_release },
    { phan_in_id: phanInId, chuyen_id: body.chuyenId || l.chuyen_id, ngay_ke_hoach: body.ngayKeHoach, tg_bd_kh: body.tgBdKh || null,
      tg_kt_kh: body.tgKtKh || null, tho_in_kh: body.thoIn, so_luong_release: kq.so_luong_release, ly_do: ly }, actorId);
  return kq;
}

async function suaKeHoachTam(phanInId, ktId, body = {}, actorId) {
  const ly = String(body.lyDo || '').trim();
  if (!ly) throw new AppError('Phải nhập lý do', { status: 422, errorCode: 'NO_LY_DO' });
  const tc = await repo.toanCanh(phanInId);
  const kt = (tc.ke_hoach_tam || []).find((x) => x.id === ktId);
  if (!kt) throw new AppError('Kế hoạch tạm không thuộc phần in này (hoặc đã xác nhận / xóa)', { status: 404, errorCode: 'NOT_FOUND' });
  if (!body.chuyenId) throw new AppError('Chọn chuyền', { status: 422, errorCode: 'NO_CHUYEN' });
  if (!body.ngayKeHoach) throw new AppError('Chọn ngày sản xuất theo kế hoạch', { status: 422, errorCode: 'NO_NGAY' });
  const kq = await planningService.updateKeHoachTam(ktId, {
    chuyenId: body.chuyenId, ngayKeHoach: body.ngayKeHoach, soLuong: body.soLuong,
    tgBdKh: body.tgBdKh || null, tgKtKh: body.tgKtKh || null, thoIn: body.thoIn,
  }, actorId);
  await repo.ghiAudit('ke_hoach_tam', ktId, 'QUAN_TRI_SUA_KE_HOACH',
    { chuyen_id: kt.chuyen_id, ngay_ke_hoach: kt.ngay_ke_hoach, tg_bd_kh: kt.tg_bd_kh, tg_kt_kh: kt.tg_kt_kh, so_luong: kt.so_luong, tho_in_kh: kt.tho_in_kh },
    { phan_in_id: phanInId, dot_vai_ve_id: kt.dot_vai_ve_id, chuyen_id: body.chuyenId, ngay_ke_hoach: body.ngayKeHoach,
      tg_bd_kh: body.tgBdKh || null, tg_kt_kh: body.tgKtKh || null, so_luong: body.soLuong ?? null, tho_in_kh: body.thoIn, ly_do: ly }, actorId);
  return kq;
}

// ─── HỦY / MỞ CẢ PHẦN IN (tái dùng tab Hủy / Mở phần in) ────────────────────────
async function huyPhanIn(phanInId, lyDo, actorId) {
  if (!String(lyDo || '').trim()) throw new AppError('Phải nhập lý do', { status: 422, errorCode: 'NO_LY_DO' });
  return ordersService.softDeletePhanIn([phanInId], LY(String(lyDo).trim()), actorId);
}
async function moPhanIn(phanInId, actorId) {
  return ordersService.reopenPhanIn([phanInId], actorId);
}

module.exports = {
  traCuu, chiTiet, suaPhanIn, suaDotVai, datGiaiDoan, huyDotVai, moDotVai, huyMucReady, DICH,
  datKhoaErp, luiVe, dungBuocLui, huyLe, luuPhanCong, huyPhanIn, moPhanIn, DICH_LUI,
  xemKeHoachLenh, suaKeHoachLenh, suaKeHoachTam,
};
