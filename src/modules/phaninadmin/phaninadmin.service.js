const repo = require('./phaninadmin.repository');
const planningService = require('../planning/planning.service');
const ordersService = require('../orders/orders.service');
const technicalService = require('../technical/technical.service');
const erpsyncRepo = require('../erpsync/erpsync.repository');
const sockets = require('../../sockets');
const AppError = require('../../utils/AppError');

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
  const [ready, dotVai, loaiDotVai] = await Promise.all([
    repo.getReady(phanInId), repo.getDotVaiList(phanInId), repo.danhMucLoaiDotVai(),
  ]);
  return { phan_in: pin, ready, dot_vai: dotVai, loai_dot_vai: loaiDotVai };
}

// ─── SỬA TRƯỜNG ──────────────────────────────────────────────────────────────
async function suaPhanIn(phanInId, patch, actorId) {
  const truoc = await repo.getPhanIn(phanInId);
  if (!truoc) throw new AppError('Phần in không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const kq = await repo.updatePhanIn(phanInId, patch || {}, actorId);
  if (!kq) throw new AppError('Không có trường nào hợp lệ để sửa', { status: 422, errorCode: 'NO_FIELD' });
  const cu = {}; const moi = {};
  kq.cols.forEach((c) => { cu[c] = truoc[c]; moi[c] = kq.row[c]; });
  await repo.ghiAudit('phan_in', phanInId, 'QUAN_TRI_SUA_PHAN_IN', cu, moi, actorId);
  sockets.emit('dashboard:refresh', {});
  return { id: phanInId, cols: kq.cols };
}

async function suaDotVai(dotVaiId, patch, actorId) {
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
  sockets.emit('dashboard:refresh', {});
  sockets.emit('workflow:updated', { dotVaiId });
  return { id: dotVaiId, cols: kq.cols };
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

module.exports = {
  traCuu, chiTiet, suaPhanIn, suaDotVai, datGiaiDoan, huyDotVai, moDotVai, huyMucReady, DICH,
};
