'use strict';

const { withTransaction } = require('../../config/db');
const repo = require('./production.repository');
const AppError = require('../../utils/AppError');
const { buildMeta } = require('../../utils/pagination');
const sockets = require('../../sockets');
const tracking = require('../workflow/tracking.service');
const planningRepo = require('../planning/planning.repository');
const { caFromParts, maNgayCa, ngayTuMaNgayCa } = require('../../utils/ca');
const { layBarcodeTem, layNhieuBarcodeTem } = require('../../utils/erpTemBarcode');

// Gắn `phan_in_list` (1 dòng / phần in) cho các lệnh GOM SET — màn Xác nhận chạy tách dòng theo phần in,
// hợp nhất ô ở STT + nút thao tác. Lệnh 1 phần in KHÔNG gắn (FE render như cũ, khỏi phình payload).
// 1 query gộp cho cả danh sách (`phanInRowsByLenh`) thay vì gọi từng lệnh.
async function attachPhanInList(rows, idKey = 'id') {
  const setIds = rows.filter((r) => Number(r.so_phan_in) > 1).map((r) => r[idKey]).filter(Boolean);
  if (!setIds.length) return rows;
  const all = await repo.phanInRowsByLenh(setIds);
  const byLenh = {};
  all.forEach((p) => { (byLenh[p.lenh_san_xuat_id] = byLenh[p.lenh_san_xuat_id] || []).push(p); });
  return rows.map((r) => (byLenh[r[idKey]] ? { ...r, phan_in_list: byLenh[r[idKey]] } : r));
}

async function listCandidates({ search, page, limit, offset }) {
  const { rows, total } = await repo.listProductionCandidates({ search, offset, limit });
  return { items: await attachPhanInList(rows), meta: buildMeta(page, limit, total) };
}

async function getRun(lenhId) {
  const lenh = await repo.getLenhBasic(lenhId);
  if (!lenh) throw new AppError('Lệnh sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const phieu = await repo.getActivePhieu(lenhId);
  const tems = phieu ? await repo.getTemsByPhieu(phieu.id) : [];
  const printed = tems.reduce((s, t) => s + (t.trang_thai === 'HUY' ? 0 : (Number(t.so_luong) || 0)), 0);
  const [ngungList, ngungActive, dotVai, vaiHuy, phanCong] = phieu
    ? await Promise.all([repo.listNgungByPhieu(phieu.id), repo.getActiveNgung(phieu.id),
                         repo.getLenhDotVaiList(lenhId), repo.listVaiHuyByLenh(lenhId),
                         repo.getPhanCongByPhieu(phieu.id)])
    : [[], null, await repo.getLenhDotVaiList(lenhId), await repo.listVaiHuyByLenh(lenhId), { items: [] }];
  // Lệnh GOM SET = nhiều PHẦN IN khác nhau trong cùng 1 đợt SX (in chung 1 chuyền).
  const soPhanIn = new Set(dotVai.map((d) => d.phan_in_id)).size;
  // Lý do BỔ SUNG đã ghi của từng đợt vải (mig 077) — gắn thẳng vào dòng đợt vải cho FE khỏi ghép.
  // ⚠ Chưa chạy mig 077 thì trả [] ⇒ các trường dưới là undefined, sidebar tự ẩn khối.
  const bsMap = new Map((await repo.lyDoBoSungByLenh(lenhId).catch(() => []))
    .map((r) => [r.dot_vai_ve_id, r]));
  dotVai.forEach((d) => {
    const b = bsMap.get(d.dot_vai_ve_id);
    if (b) Object.assign(d, {
      ly_do_bo_sung_id: b.ly_do_bo_sung_id, ghi_chu_bo_sung: b.ghi_chu_bo_sung,
      ten_ly_do_bo_sung: b.ten_ly_do,
    });
  });
  return { lenh, phieu, tems, printed, ngung_list: ngungList, ngung_active: ngungActive,
           dot_vai: dotVai, vai_huy: vaiHuy, phan_cong: phanCong,
           goi_y_tem: await goiYTemMeta(lenhId, phieu?.id),
           so_phan_in: soPhanIn, co_gom_set: soPhanIn > 1 };
}

// Gợi ý sẵn "ngày ca · từ giờ · đến giờ" cho lượt in kế tiếp (FE điền vào ô, người dùng sửa được).
// Ngày ca = YYMMDD của HÔM NAY + mã ca suy từ GIỜ HIỆN TẠI (lúc mở sidebar Sản xuất) & loại ca của
// TUẦN ISO đó (`cai_dat_ca_tuan`; tuần chưa cài → ca Ngắn). Lỗi gì cũng trả null — không chặn màn Sản xuất.
async function goiYTemMeta(lenhId, phieuId) {
  try {
    const [g, modeMap] = await Promise.all([repo.goiYTemMeta(lenhId, phieuId), planningRepo.caModeMap()]);
    if (!g) return null;
    const mode = modeMap.get(`${g.nam}-${g.tuan}`) || 'NGAN';
    return { ngay_ca: maNgayCa(g.ymd, g.gio, g.phut, mode), gio_bd: g.gio_bd || '', gio_kt: g.gio_kt || '' };
  } catch (e) {
    return null;
  }
}

// Ghi 1 lần vải hủy (= vải hư) hoặc vải THIẾU trong lúc sản xuất, theo đợt vải / phần in của lệnh.
async function addVaiHuy(phieuId, { dotVaiId, soLuong, lyDo, loai }, actorId) {
  const qty = Number(soLuong);
  const isThieu = loai === 'THIEU';
  const nhan = isThieu ? 'vải thiếu' : 'vải hủy';
  if (!qty || qty <= 0) throw new AppError(`Số lượng ${nhan} phải > 0`, { status: 422, errorCode: 'INVALID_QTY' });
  const phieu = await repo.getPhieuById(phieuId);
  if (!phieu) throw new AppError('Phiếu sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const dotVaiList = await repo.getLenhDotVaiList(phieu.lenh_san_xuat_id);
  if (dotVaiList.length === 0) throw new AppError('Lệnh chưa có phần in', { status: 409, errorCode: 'NO_DOT_VAI' });
  // Nếu không chọn (lệnh chỉ 1 phần in) → mặc định phần in duy nhất.
  const chosen = dotVaiId
    ? dotVaiList.find((d) => d.dot_vai_ve_id === dotVaiId)
    : (dotVaiList.length === 1 ? dotVaiList[0] : null);
  if (!chosen) throw new AppError(`Chọn phần in cần ghi ${nhan}`, { status: 422, errorCode: 'NO_PHAN_IN' });
  try {
    await repo.insertVaiHuy({
      phieuId, lenhId: phieu.lenh_san_xuat_id, dotVaiId: chosen.dot_vai_ve_id,
      phanInId: chosen.phan_in_id, soLuong: qty, lyDo, loai: isThieu ? 'THIEU' : 'HUY',
    }, actorId);
  } catch (e) {
    throw new AppError(`Chưa ghi được ${nhan} (kiểm tra migration 039_vai_huy + 063_vai_thieu_phan_cong)`,
      { status: 500, errorCode: 'VAI_HUY_FAILED' });
  }
  sockets.emit('production:updated', { lenhId: phieu.lenh_san_xuat_id, action: isThieu ? 'vai-thieu' : 'vai-huy' });
  return getRun(phieu.lenh_san_xuat_id);
}

// ----- PHÂN CÔNG SẢN XUẤT (mig 063) -----
// 1 lần lưu: ca trưởng (tài khoản) + chuyền trưởng (chữ) ở mức phiếu + THỢ IN.
// ⚠ SL vải hủy / vải thiếu ĐÃ CHUYỂN sang modal IN TEM (2026-08-04) — ghi cùng lúc với lúc in tem
// (`printTemBatch`), không còn nhập ở đây nữa.
// ⚠ THỢ IN nay là 1 Ô TEXT "danh sách thợ in trên chuyền" ở mức PHIẾU (2026-08-05, KHÔNG migration):
// body gửi `thoIn` (chuỗi) → ghi CÙNG chuỗi đó cho MỌI đợt vải của phiếu, vì `phan_cong_san_xuat`
// khóa theo (phiếu, đợt vải). Giữ nguyên bảng để sau này muốn tách lại theo từng phần in vẫn được;
// `items` (mỗi đợt vải 1 thợ) vẫn nhận được nếu có — dùng khi cần phân công lẻ.
async function savePhanCong(phieuId, { caTruongId, chuyenTruong, thoIn, items }, actorId) {
  const phieu = await repo.getPhieuById(phieuId);
  if (!phieu) throw new AppError('Phiếu sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const dotVaiList = await repo.getLenhDotVaiList(phieu.lenh_san_xuat_id);
  const byId = new Map(dotVaiList.map((d) => [d.dot_vai_ve_id, d]));
  const rows = Array.isArray(items) && items.length
    ? items
    : (thoIn !== undefined ? dotVaiList.map((d) => ({ dotVaiId: d.dot_vai_ve_id, thoIn })) : []);
  for (const it of rows) {
    if (it && it.dotVaiId && !byId.has(it.dotVaiId)) {
      throw new AppError('Đợt vải không thuộc đợt sản xuất này', { status: 422, errorCode: 'BAD_DOT_VAI' });
    }
  }
  try {
    await withTransaction(async (client) => {
      await repo.setPhieuTruong(client, phieuId, { caTruongId, chuyenTruong: (chuyenTruong || '').trim() }, actorId);
      for (const it of rows) {
        const d = byId.get(it.dotVaiId);
        if (!d) continue;
        await repo.upsertPhanCong(client, {
          phieuId, dotVaiId: d.dot_vai_ve_id, phanInId: d.phan_in_id, thoIn: it.thoIn,
        }, actorId);
      }
    });
  } catch (e) {
    throw new AppError('Chưa lưu được phân công (kiểm tra migration 063_vai_thieu_phan_cong)',
      { status: 500, errorCode: 'PHAN_CONG_FAILED' });
  }
  sockets.emit('production:updated', { lenhId: phieu.lenh_san_xuat_id, action: 'phan-cong' });
  return getRun(phieu.lenh_san_xuat_id);
}

// Ngừng chuyền (đang sản xuất) — kèm lý do; cho ngừng nhiều lần/phiếu.
// `gioBd` (tùy chọn, 'HH:MM') = giờ bắt đầu ngừng nhập tay; bỏ trống → giờ hệ thống.
// `lyDoId` = lý do chọn từ DANH MỤC (mig 076); `lyDo` = ghi chú thêm (hoặc lý do gõ tay khi chưa có
// danh mục / chọn "Khác"). Ít nhất một trong hai phải có.
// ⚠ Cột `ngung_chuyen.ly_do` (TEXT) VẪN LÀ NGUỒN HIỂN THỊ — service tự ghép "Tên lý do — ghi chú" vào
//   đó, nên mọi màn đang đọc `ly_do` (sidebar, Theo dõi chuyền, lịch sử) không phải sửa gì.
async function stopLine(phieuId, lyDo, actorId, gioBd = null, lyDoId = null) {
  const phieu = await repo.getPhieuById(phieuId);
  if (!phieu) throw new AppError('Phiếu sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (phieu.trang_thai !== 'DANG_CHAY') throw new AppError('Phiếu không ở trạng thái đang chạy', { status: 409, errorCode: 'WRONG_STAGE' });

  let dm = null;
  if (lyDoId) {
    // Tra bọc try/catch: chưa chạy mig 076 thì bảng chưa có — vẫn cho ngừng chuyền bằng lý do gõ tay.
    try { dm = await repo.getLyDoNgung(lyDoId); } catch { dm = null; }
    if (!dm) throw new AppError('Lý do ngừng chuyền không tồn tại', { status: 404, errorCode: 'LY_DO_NOT_FOUND' });
  }
  const ghiChu = (lyDo || '').trim();
  const noiDung = dm ? [dm.ten_ly_do, ghiChu].filter(Boolean).join(' — ') : ghiChu;
  if (!noiDung) throw new AppError('Chọn lý do ngừng chuyền', { status: 422, errorCode: 'NO_LY_DO' });

  const active = await repo.getActiveNgung(phieuId);
  if (active) throw new AppError('Chuyền đang ngừng — hãy cho hoạt động lại trước', { status: 409, errorCode: 'ALREADY_STOPPED' });
  const lenh = await repo.getLenhBasic(phieu.lenh_san_xuat_id);
  await repo.startNgung({
    phieuId, lenhId: phieu.lenh_san_xuat_id, chuyenId: lenh?.chuyen_id,
    lyDo: noiDung, lyDoId: dm ? lyDoId : null, gioBd,
  }, actorId);
  sockets.emit('production:updated', { lenhId: phieu.lenh_san_xuat_id, action: 'ngung' });
  sockets.emit('dashboard:refresh', {});
  return getRun(phieu.lenh_san_xuat_id);
}

// ─── DANH MỤC LÝ DO NGỪNG CHUYỀN (mig 076) ───────────────────────────────────
// Cùng khuôn với danh mục biện pháp xử lý (`phanloailoi.service`) để 2 trang thao tác giống nhau.
// ⚠ `dsLyDoNgung` NUỐT LỖI trả mảng rỗng: chưa chạy mig 076 thì dropdown ở màn Sản xuất chỉ trống,
//   người đứng máy vẫn ngừng chuyền được bằng ô ghi chú — không để thiếu migration chặn việc xưởng.
async function dsLyDoNgung(opts) {
  try { return await repo.listLyDoNgung(opts); } catch { return []; }
}

async function taoLyDoNgung(d, actorId) {
  const ma = String(d.maLyDo || '').trim().toUpperCase();
  const ten = String(d.tenLyDo || '').trim();
  if (!ma || !ten) throw new AppError('Nhập mã và tên lý do', { status: 422, errorCode: 'VALIDATION_ERROR' });
  if (await repo.existsMaLyDoNgung(ma)) throw new AppError(`Mã "${ma}" đã tồn tại`, { status: 409, errorCode: 'DUPLICATE' });
  return { id: await repo.createLyDoNgung({ ...d, maLyDo: ma, tenLyDo: ten }, actorId) };
}

async function suaLyDoNgung(id, d, actorId) {
  if (!await repo.getLyDoNgung(id)) throw new AppError('Lý do không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  await repo.updateLyDoNgung(id, d, actorId);
}

async function doiTrangThaiLyDoNgung(id, active, actorId) {
  if (!await repo.getLyDoNgung(id)) throw new AppError('Lý do không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  await repo.setLyDoNgungActive(id, active, actorId);
}

// ─── DANH MỤC LÝ DO BỔ SUNG + ghi cho ĐỢT VẢI (mig 077) ──────────────────────
// ⚠ `dsLyDoBoSung` NUỐT LỖI trả mảng rỗng (chưa chạy mig 077) — sidebar chỉ hiện ô ghi chú, người
//   đứng máy vẫn ghi tay được; không để thiếu migration chặn việc xưởng (giống lý do ngừng chuyền).
async function dsLyDoBoSung(opts) {
  try { return await repo.listLyDoBoSung(opts); } catch { return []; }
}

async function taoLyDoBoSung(d, actorId) {
  const ma = String(d.maLyDo || '').trim().toUpperCase();
  const ten = String(d.tenLyDo || '').trim();
  if (!ma || !ten) throw new AppError('Nhập mã và tên lý do', { status: 422, errorCode: 'VALIDATION_ERROR' });
  if (await repo.existsMaLyDoBoSung(ma)) throw new AppError(`Mã "${ma}" đã tồn tại`, { status: 409, errorCode: 'DUPLICATE' });
  return { id: await repo.createLyDoBoSung({ ...d, maLyDo: ma, tenLyDo: ten }, actorId) };
}

async function suaLyDoBoSung(id, d, actorId) {
  if (!await repo.getLyDoBoSung(id)) throw new AppError('Lý do không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  await repo.updateLyDoBoSung(id, d, actorId);
}

async function doiTrangThaiLyDoBoSung(id, active, actorId) {
  if (!await repo.getLyDoBoSung(id)) throw new AppError('Lý do không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  await repo.setLyDoBoSungActive(id, active, actorId);
}

// Ghi lý do bổ sung cho 1 ĐỢT VẢI (sidebar màn Sản xuất). Bỏ trống cả 2 = xóa lý do đã ghi.
async function luuLyDoBoSungDotVai(dotVaiId, { lyDoId, ghiChu }, actorId) {
  if (lyDoId) {
    let dm = null;
    try { dm = await repo.getLyDoBoSung(lyDoId); } catch { dm = null; }
    if (!dm) throw new AppError('Lý do bổ sung không tồn tại', { status: 404, errorCode: 'LY_DO_NOT_FOUND' });
  }
  const ok = await repo.setLyDoBoSungChoDotVai(dotVaiId, lyDoId || null, (ghiChu || '').trim() || null, actorId);
  if (!ok) throw new AppError('Chưa chạy migration 077 nên chưa ghi được lý do bổ sung', { status: 409, errorCode: 'THIEU_MIGRATION' });
  sockets.emit('production:updated', { action: 'ly-do-bo-sung' });
  return { ok: true };
}

// Chuyền hoạt động lại — lưu thời gian ngừng. `gioKt` (tùy chọn, 'HH:MM') = giờ kết thúc nhập tay.
async function resumeLine(phieuId, actorId, gioKt = null) {
  const phieu = await repo.getPhieuById(phieuId);
  if (!phieu) throw new AppError('Phiếu sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const active = await repo.getActiveNgung(phieuId);
  if (!active) throw new AppError('Chuyền không trong trạng thái ngừng', { status: 409, errorCode: 'NOT_STOPPED' });
  await repo.resumeNgung(active.id, actorId, gioKt);
  sockets.emit('production:updated', { lenhId: phieu.lenh_san_xuat_id, action: 'hoat-dong-lai' });
  sockets.emit('dashboard:refresh', {});
  return getRun(phieu.lenh_san_xuat_id);
}

async function startProduction(lenhId, actorId, chuyenId = null) {
  const lenh = await repo.getLenhBasic(lenhId);
  if (!lenh) throw new AppError('Lệnh sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (lenh.trang_thai !== 'RELEASE_2') {
    throw new AppError('Lệnh chưa ở trạng thái Release 2', { status: 409, errorCode: 'WRONG_STAGE' });
  }
  // Chuyền THỰC TẾ chạy (kế thừa chuyền kế hoạch, cho phép đổi khi xác nhận chạy).
  const chuyenThucTe = chuyenId || lenh.chuyen_id;
  const maPhieu = await repo.nextMaPhieu();
  await withTransaction(async (client) => {
    if (chuyenId && chuyenId !== lenh.chuyen_id) await repo.setLenhChuyen(client, lenhId, chuyenId, actorId);
    await repo.createPhieu(client, { lenhId, chuyenId: chuyenThucTe, maPhieu }, actorId);
    await repo.setLenhTrangThai(client, lenhId, 'SAN_XUAT', actorId);
  });
  await tracking.moveByLenh(lenhId, 'SAN_XUAT', actorId); // theo dõi dòng chảy
  sockets.emit('production:updated', { lenhId, stage: 'SAN_XUAT' });
  sockets.emit('dashboard:refresh', {});
  return getRun(lenhId);
}

// Chạy ĐẶC BIỆT (bỏ Test Run — chỉ thị đặc biệt): khởi chạy đợt SX còn ở RELEASE_1 (chưa Test Run).
// Giống startProduction nhưng nới gate cho RELEASE_1 + ghi audit CHAY_DAC_BIET_BO_TEST.
async function startProductionSpecial(lenhId, actorId, chuyenId = null, lyDo = null) {
  const lenh = await repo.getLenhBasic(lenhId);
  if (!lenh) throw new AppError('Đợt sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (lenh.trang_thai !== 'RELEASE_1') {
    throw new AppError('Chạy đặc biệt chỉ áp dụng cho đợt đã Release 1 & CHƯA Test Run', { status: 409, errorCode: 'WRONG_STAGE' });
  }
  const chuyenThucTe = chuyenId || lenh.chuyen_id;
  const maPhieu = await repo.nextMaPhieu();
  await withTransaction(async (client) => {
    if (chuyenId && chuyenId !== lenh.chuyen_id) await repo.setLenhChuyen(client, lenhId, chuyenId, actorId);
    await repo.createPhieu(client, { lenhId, chuyenId: chuyenThucTe, maPhieu }, actorId);
    await repo.setLenhTrangThai(client, lenhId, 'SAN_XUAT', actorId); // bỏ qua Test Run + Release 2
  });
  await repo.logChayDacBiet(lenhId, lenh.ma_lenh_san_xuat, lyDo, actorId);
  await tracking.moveByLenh(lenhId, 'SAN_XUAT', actorId);
  sockets.emit('production:updated', { lenhId, stage: 'SAN_XUAT', dacBiet: true });
  sockets.emit('dashboard:refresh', {});
  return getRun(lenhId);
}

const DEFAULT_DRY_MIN = 60; // thời gian phơi mặc định (phút) — chỉnh được ở màn Xe phơi

// Ngày ca / giờ SX (từ → đến) / cờ BTP của 1 LƯỢT IN — nhập ở màn Sản xuất, lưu vào từng tem (mig 066).
// Chuỗi rỗng → null để không đẩy '' xuống cột DATE/TIME.
// `ngayCa` từ FE nay là MÃ NGÀY CA (mig 068, vd `260805D2`) → lưu nguyên chuỗi vào `ma_ngay_ca`,
// đồng thời tách 6 số đầu ra cột `ngay_ca` DATE để lọc/thống kê theo ngày vẫn chạy. Gõ sai định dạng
// thì vẫn giữ chuỗi, `ngay_ca` để NULL (không bịa ngày).
const temMeta = (b = {}) => {
  const ma = (b.ngayCa || '').trim();
  return {
    maNgayCa: ma || null,
    ngayCa: ngayTuMaNgayCa(ma),
    gioBd: b.gioBd || null,
    gioKt: b.gioKt || null,
    btpTruoc: !!b.btpTruoc,
    btpCuoi: !!b.btpCuoi,
    // GC màu vải (mig 071) — lệnh THƯỜNG nhập 1 ô chung; lệnh GOM SET nhập RIÊNG từng dòng nên
    // `printTemBatch` sẽ ghi đè bằng `it.gcMauVai` của dòng đó.
    gcMauVai: (b.gcMauVai || '').trim() || null,
  };
};

async function printTem(phieuId, soLuong, actorId, body) {
  const meta = temMeta(body);
  const qty = Number(soLuong);
  if (!qty || qty <= 0) {
    throw new AppError('Số lượng in phải > 0', { status: 422, errorCode: 'INVALID_QTY' });
  }
  const phieu = await repo.getPhieuById(phieuId);
  if (!phieu) throw new AppError('Phiếu sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (phieu.trang_thai !== 'DANG_CHAY') {
    throw new AppError('Phiếu không ở trạng thái đang chạy', { status: 409, errorCode: 'WRONG_STAGE' });
  }

  // Luật: tổng đã in không vượt quá 110% SL release của lệnh.
  const lenh = await repo.getLenhBasic(phieu.lenh_san_xuat_id);
  const target = Number(lenh?.so_luong_release) || 0;
  if (target > 0) {
    const printed = await repo.getPrintedTotal(phieuId);
    const max = Math.floor(target * 1.1);
    if (printed + qty > max) {
      throw new AppError(
        `Vượt quá 110% SL release (tối đa ${max}, đã in ${printed}, còn được in ${Math.max(0, max - printed)})`,
        { status: 422, errorCode: 'OVER_LIMIT' }
      );
    }
  }

  // In tem xong tự đưa vào xe phơi mặc định + bắt đầu đếm ngược ngay.
  const xe = await repo.getDefaultXePhoi();
  if (!xe) throw new AppError('Chưa cấu hình xe phơi để bắt đầu phơi', { status: 409, errorCode: 'NO_XE' });
  // Thời gian chờ khô = cấu hình của phần in (nếu có) hoặc mặc định 60'.
  const dryMin = (await repo.getDryMinForPhieu(phieuId)) ?? DEFAULT_DRY_MIN;

  // Mã tem lấy TỪ ERP (barcode 12 số, đã sẵn tiền tố `15`). Lấy TRƯỚC transaction: gọi HTTP bên trong
  // sẽ giữ transaction hở suốt thời gian chờ, mà lỗi mạng còn abort cả transaction.
  // Đặt SAU mọi guard ở trên (110% SL release, xe phơi…) để không tiêu số của ERP một cách vô ích.
  const maTem = await layBarcodeTem();
  let newTemId;
  await withTransaction(async (client) => {
    newTemId = await repo.createTem(client, { phieuId, maTem, soLuong: qty, ...meta }, actorId);
    await repo.logTemPrint(client, { temId: newTemId, maTem, actorId });
    await repo.addTemToXe(client, { temId: newTemId, xeId: xe.id, soLuongPhoi: qty, phut: dryMin }, actorId);
  });
  await tracking.moveByLenh(phieu.lenh_san_xuat_id, 'CHO_KHO', actorId); // in tem → xe phơi → CHỜ KHÔ
  sockets.emit('production:updated', { lenhId: phieu.lenh_san_xuat_id, action: 'tem' });
  sockets.emit('drying:updated', { lenhId: phieu.lenh_san_xuat_id, action: 'auto-phoi' });
  const run = await getRun(phieu.lenh_san_xuat_id);
  return { ...run, new_tem_id: newTemId };
}

// IN TEM NHIỀU PHẦN IN 1 LƯỢT (lệnh GOM SET): mỗi đợt vải/phần in nhập 1 số lượng → tạo N tem trong
// CÙNG 1 transaction, FE in nhãn liên tiếp (xong phần in 1 → phần in 2 → …).
// Trần số lượng (theo chốt "như hiện tại, theo từng đợt của từng phần"):
//   · từng dòng : ≤ 110% SL đưa vào SX của đợt đó (lenh_sx_dot_vai.so_luong)
//   · tổng cộng : đã in + Σ nhập ≤ 110% SL release của lệnh (giữ nguyên luật cũ)
// ⚠ Trần TỪNG DÒNG chỉ tính trong LƯỢT NHẤN NÀY, không lũy kế qua các lượt in trước — vì bảng `tem`
//   không lưu đợt vải (giữ schema như cũ) nên không biết đã in bao nhiêu cho từng phần in.
//   Trần TỔNG của lệnh vẫn lũy kế đầy đủ nên không in vượt được toàn lệnh.
async function printTemBatch(phieuId, items, actorId, body) {
  const meta = temMeta(body);
  const raw = Array.isArray(items) ? items : [];
  const list = raw
    .map((it) => ({ dotVaiId: it.dotVaiId || null, soLuong: Number(it.soLuong), gcMauVai: it.gcMauVai || null }))
    .filter((it) => it.soLuong > 0);
  // Vải hủy / vải thiếu nhập NGAY TRONG modal In tem (chuyển từ modal Phân công): ghi kể cả khi dòng
  // đó KHÔNG in tem (SL in = 0 nhưng vẫn phát sinh vải hư/thiếu) ⇒ lọc riêng, không dùng `list`.
  const vaiList = raw
    .map((it) => ({
      dotVaiId: it.dotVaiId || null,
      huy: Number(it.soLuongHuy) || 0,
      thieu: Number(it.soLuongThieu) || 0,
    }))
    .filter((it) => it.dotVaiId && (it.huy > 0 || it.thieu > 0));
  if (!list.length) throw new AppError('Nhập số lượng in cho ít nhất 1 phần in', { status: 422, errorCode: 'EMPTY' });

  const phieu = await repo.getPhieuById(phieuId);
  if (!phieu) throw new AppError('Phiếu sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (phieu.trang_thai !== 'DANG_CHAY') {
    throw new AppError('Phiếu không ở trạng thái đang chạy', { status: 409, errorCode: 'WRONG_STAGE' });
  }

  const dotVaiList = await repo.getLenhDotVaiList(phieu.lenh_san_xuat_id);
  const byId = new Map(dotVaiList.map((d) => [d.dot_vai_ve_id, d]));
  for (const it of list) {
    if (!it.dotVaiId) continue;
    const d = byId.get(it.dotVaiId);
    if (!d) throw new AppError('Đợt vải không thuộc đợt sản xuất này', { status: 422, errorCode: 'BAD_DOT_VAI' });
    const capDot = Math.floor((Number(d.sl_vao_sx) || 0) * 1.1);
    if (capDot > 0 && it.soLuong > capDot) {
      throw new AppError(
        `Phần in ${d.ma_phan}: vượt 110% SL vào sản xuất của đợt (tối đa ${capDot}, nhập ${it.soLuong})`,
        { status: 422, errorCode: 'OVER_LIMIT_DOT' }
      );
    }
  }

  const lenh = await repo.getLenhBasic(phieu.lenh_san_xuat_id);
  const target = Number(lenh?.so_luong_release) || 0;
  const tong = list.reduce((s, x) => s + x.soLuong, 0);
  if (target > 0) {
    const printed = await repo.getPrintedTotal(phieuId);
    const max = Math.floor(target * 1.1);
    if (printed + tong > max) {
      throw new AppError(
        `Vượt quá 110% SL release của đợt SX (tối đa ${max}, đã in ${printed}, còn được in ${Math.max(0, max - printed)}, đang nhập ${tong})`,
        { status: 422, errorCode: 'OVER_LIMIT' }
      );
    }
  }

  const xe = await repo.getDefaultXePhoi();
  if (!xe) throw new AppError('Chưa cấu hình xe phơi để bắt đầu phơi', { status: 409, errorCode: 'NO_XE' });
  const dryMin = (await repo.getDryMinForPhieu(phieuId)) ?? DEFAULT_DRY_MIN;

  // Lấy ĐỦ N mã tem từ ERP TRƯỚC khi mở transaction (mỗi dòng 1 mã). Lỗi giữa chừng thì ném luôn —
  // chưa tem nào được tạo nên không phải dọn gì; số ERP đã lấy coi như bỏ.
  const maTemList = await layNhieuBarcodeTem(list.length);

  const out = [];
  await withTransaction(async (client) => {
    for (const [i, it] of list.entries()) {
      const maTem = maTemList[i];
      // GC màu vải nhập RIÊNG từng dòng ở modal gom set → ưu tiên `it.gcMauVai`; không có thì dùng ô chung.
      const temId = await repo.createTem(client, {
        phieuId, maTem, soLuong: it.soLuong, ...meta,
        gcMauVai: (it.gcMauVai || '').trim() || meta.gcMauVai,
      }, actorId);
      await repo.logTemPrint(client, { temId, maTem, actorId });
      await repo.addTemToXe(client, { temId, xeId: xe.id, soLuongPhoi: it.soLuong, phut: dryMin }, actorId);
      const d = it.dotVaiId ? byId.get(it.dotVaiId) : null;
      out.push({
        tem_id: temId, ma_tem: maTem, dot_vai_id: it.dotVaiId, so_luong: it.soLuong,
        ma_phan: d ? d.ma_phan : null,
      });
    }
  });
  // Vải hủy/thiếu ghi SAU transaction in tem (mỗi lượt 1 bản ghi sổ có người + giờ) — best-effort:
  // thiếu mig 063 thì tem vẫn in xong, chỉ không ghi được sổ vải.
  for (const v of vaiList) {
    const d = byId.get(v.dotVaiId);
    if (!d) continue;
    for (const [qty, loai] of [[v.huy, 'HUY'], [v.thieu, 'THIEU']]) {
      if (!(qty > 0)) continue;
      try {
        await repo.insertVaiHuy({
          phieuId, lenhId: phieu.lenh_san_xuat_id, dotVaiId: d.dot_vai_ve_id, phanInId: d.phan_in_id,
          soLuong: qty, lyDo: 'Ghi khi in tem', loai,
        }, actorId);
      } catch (e) { console.error(`[production] ✗ Ghi vải ${loai} lỗi (${d.ma_phan}): ${e.message}`); }
    }
  }
  await tracking.moveByLenh(phieu.lenh_san_xuat_id, 'CHO_KHO', actorId);
  sockets.emit('production:updated', { lenhId: phieu.lenh_san_xuat_id, action: 'tem', so_tem: out.length });
  sockets.emit('drying:updated', { lenhId: phieu.lenh_san_xuat_id, action: 'auto-phoi' });
  const run = await getRun(phieu.lenh_san_xuat_id);
  return { ...run, tems_in: out, new_tem_id: out[0]?.tem_id || null };
}

// In lại tem = in lại NHÃN của CHÍNH tem đó — GIỮ NGUYÊN mã tem + sổ cái + xe phơi (không tạo tem mới,
// không đụng đồng hồ phơi). Dùng khi tem GIẤY bị mất/rách. Chỉ ghi thêm 1 lần in vào log_tem
// (tăng so_lan_in) + lý do để lưu vết. Cho in lại ở mọi giai đoạn trừ tem đã HỦY.
async function reprintTem(temId, lyDo, actorId) {
  if (!lyDo || !lyDo.trim()) throw new AppError('Nhập lý do in lại tem', { status: 422, errorCode: 'NO_LY_DO' });
  const ctx = await repo.getTemContext(temId);
  if (!ctx) throw new AppError('Tem không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (ctx.trang_thai === 'HUY') throw new AppError('Tem đã hủy, không thể in lại', { status: 409, errorCode: 'WRONG_STAGE' });
  const soLan = await repo.nextReprint(temId);
  await repo.logReprint(temId, ctx.ma_tem, lyDo.trim(), soLan, actorId);
  sockets.emit('production:updated', { lenhId: ctx.lenh_san_xuat_id, action: 'reprint', temId });
  const run = await getRun(ctx.lenh_san_xuat_id);
  return { ...run, new_tem_id: temId, reprinted: ctx.ma_tem, so_lan_in: soLan };
}

// `dotVaiId` (tùy chọn): in nhãn cho ĐÚNG phần in của đợt vải đó — dùng khi in tem lệnh GOM SET.
async function temLabel(temId, dotVaiId = null) {
  const data = await repo.getTemLabelData(temId, dotVaiId);
  if (!data) throw new AppError('Tem không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  // Ca sản xuất = suy từ giờ VN lúc sản xuất + loại ca của tuần (Ngắn/Dài). Query nhẹ riêng (IPS-safe).
  const [parts, map] = await Promise.all([repo.caPartsForTem(temId), planningRepo.caModeMap()]);
  data.ca = caFromParts(parts.ca_gio, parts.ca_phut, parts.ca_nam, parts.ca_tuan, map);
  return data;
}

async function temLogs(phieuId) {
  return repo.listTemLogByPhieu(phieuId);
}

async function finishRun(phieuId, actorId) {
  const phieu = await repo.getPhieuById(phieuId);
  if (!phieu) throw new AppError('Phiếu sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  await repo.finishPhieu(phieuId, actorId);
  // IN KIẾNG (điểm 16): nếu đợt vừa hoàn tất là giai đoạn IN → kích hoạt đợt ÉP ỦI liên kết sang "chờ chạy".
  let epUi = null;
  const gd = await planningRepo.getLenhGiaiDoan(phieu.lenh_san_xuat_id);
  if (gd && gd.giai_doan === 'IN') {
    epUi = await planningRepo.activateEpUi(phieu.lenh_san_xuat_id, actorId);
    if (epUi) sockets.emit('workflow:updated', { lenhId: epUi.id, stage: 'RELEASE_2', epUi: true });
  }
  sockets.emit('production:updated', { lenhId: phieu.lenh_san_xuat_id, action: 'finish', epUiActivated: !!epUi });
  return { ...(await getRun(phieu.lenh_san_xuat_id)), ep_ui_activated: epUi ? epUi.ma_lenh_san_xuat : null };
}

async function monitor() {
  const [running, queue, slaSauSxPhut] = await Promise.all([
    repo.monitorRunning(), repo.monitorQueue(), repo.downstreamSlaAfterProduction(),
  ]);
  // Bảng "Đang chạy" ở màn Xác nhận chạy khóa theo LỆNH (`lenh_id`), không phải phiếu.
  return { running: await attachPhanInList(running, 'lenh_id'), queue, sla_sau_sx_phut: slaSauSxPhut };
}

async function getXePhoi() {
  const [xe, current] = await Promise.all([repo.listXePhoi(), repo.listCurrentPhoi()]);
  const byXe = {};
  current.forEach((c) => { (byXe[c.xe_phoi_id] = byXe[c.xe_phoi_id] || []).push(c); });
  return xe.map((x) => ({ ...x, tems: byXe[x.id] || [] }));
}

async function listTemChoPhoi(search) {
  return repo.listTemChoPhoi({ search });
}

async function addToXe({ temId, xeId, soLuongPhoi, phut }, actorId) {
  if (!temId || !xeId) throw new AppError('Thiếu tem hoặc xe phơi', { status: 422, errorCode: 'MISSING' });
  await withTransaction((client) => repo.addTemToXe(client, { temId, xeId, soLuongPhoi, phut }, actorId));
  sockets.emit('drying:updated', { temId, xeId });
  return getXePhoi();
}

async function adjustPhoi(temXeId, phut, actorId) {
  const ok = await repo.adjustPhoi(temXeId, phut, actorId);
  if (!ok) throw new AppError('Không tìm thấy lần phơi đang chạy', { status: 404, errorCode: 'NOT_FOUND' });
  sockets.emit('drying:updated', { temXeId });
  return getXePhoi();
}

async function listDrying(search) {
  // Tem hết giờ phơi → tự động chuyển DA_KHO (chờ KCS) trước khi liệt kê.
  try { await repo.promoteFinishedDrying(); } catch (e) { /* bỏ qua */ }
  return repo.listDryingTems({ search });
}

// Phơi lại 1 tem đã khô (từ màn KCS) — đưa tem về đang phơi với thời gian nhập vào.
async function redry(temId, phut, actorId) {
  const tem = await repo.getTemBasic(temId);
  if (!tem) throw new AppError('Tem không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (tem.trang_thai !== 'DA_KHO') {
    throw new AppError('Chỉ phơi lại tem đã khô (chờ KCS)', { status: 409, errorCode: 'WRONG_STAGE' });
  }
  const p = Number(phut);
  if (!p || p <= 0) throw new AppError('Nhập thời gian phơi lại (phút)', { status: 422, errorCode: 'INVALID_MIN' });
  const xe = await repo.getDefaultXePhoi();
  if (!xe) throw new AppError('Chưa cấu hình xe phơi', { status: 409, errorCode: 'NO_XE' });
  await withTransaction((client) => repo.redryTem(client, { temId, xeId: xe.id, phut: p }, actorId));
  sockets.emit('drying:updated', { temId, redry: true });
  sockets.emit('quality:updated', { temId, redry: true });
  sockets.emit('dashboard:refresh', {});
  return { ma_tem: tem.ma_tem, phut: p };
}

async function confirmDry(temId, actorId) {
  const tem = await repo.getTemBasic(temId);
  if (!tem) throw new AppError('Tem không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (tem.trang_thai !== 'DANG_PHOI') {
    throw new AppError('Tem không ở trạng thái đang phơi', { status: 409, errorCode: 'WRONG_STAGE' });
  }
  await withTransaction((client) => repo.confirmDry(client, temId, actorId));
  sockets.emit('drying:updated', { temId, dried: true });
  sockets.emit('dashboard:refresh', {});
  return { ma_tem: tem.ma_tem };
}

// ----- HỦY LỆNH IN TEM: HỦY tem chưa kiểm + gỡ khỏi xe phơi, trả SL in về -----
async function listCancelableTem({ search, page, limit, offset }) {
  const { rows, total } = await repo.listCancelableTem({ search, offset, limit });
  return { items: rows, meta: buildMeta(page, limit, total) };
}

// Hủy 1 lệnh in tem: đánh dấu tem HỦY (loại khỏi tổng đã in ⇒ trả SL release về) + gỡ xe phơi.
// Chỉ khi tem CHƯA kiểm (IN/phơi/khô, sổ cái KCS/OQC/giao = 0) để không hỏng sổ cái.
async function cancelPrintTem(temId, lyDo, actorId) {
  const tem = await repo.getTemForCancel(temId);
  if (!tem) throw new AppError('Tem không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (tem.trang_thai === 'HUY') throw new AppError('Tem đã hủy', { status: 409, errorCode: 'ALREADY' });
  if (!['IN', 'DANG_PHOI', 'DA_KHO'].includes(tem.trang_thai)) {
    throw new AppError('Tem đã qua kiểm/giao — không thể hủy lệnh in tem', { status: 409, errorCode: 'WRONG_STAGE' });
  }
  const daKiem = tem.sl_kcs_dat + tem.sl_kcs_sua + tem.sl_kcs_huy + tem.sl_oqc_dat + tem.sl_da_giao;
  if (daKiem > 0) {
    throw new AppError('Tem đã được kiểm/giao một phần — không thể hủy lệnh in tem', { status: 409, errorCode: 'HAS_LEDGER' });
  }
  await withTransaction((client) => repo.cancelTem(client, temId, actorId)); // HỦY tem + gỡ khỏi xe phơi
  await repo.logTemCancel(temId, tem.ma_tem, (lyDo || '').trim() || null, actorId);
  sockets.emit('production:updated', { lenhId: tem.lenh_san_xuat_id, action: 'huy-tem', temId });
  sockets.emit('drying:updated', { lenhId: tem.lenh_san_xuat_id, action: 'huy-tem' });
  sockets.emit('dashboard:refresh', {});
  return { id: temId, ma_tem: tem.ma_tem, ma_lenh_san_xuat: tem.ma_lenh_san_xuat, so_luong: tem.so_luong };
}

// ----- ĐÓNG LỆNH SẢN XUẤT (= Chạy hoàn tất, cưỡng bức khi lệch SL không bấm được ở màn SX) -----
async function listCloseCandidates() {
  return repo.monitorRunning(); // các phiếu đang chạy (DANG_CHAY) + printed/target để thấy lệch
}

async function closeProduction(phieuId, lyDo, actorId) {
  const phieu = await repo.getPhieuById(phieuId);
  if (!phieu) throw new AppError('Phiếu sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (phieu.trang_thai !== 'DANG_CHAY') {
    throw new AppError('Phiếu không ở trạng thái đang chạy (có thể đã hoàn tất)', { status: 409, errorCode: 'WRONG_STAGE' });
  }
  const [printed, lenh] = await Promise.all([
    repo.getPrintedTotal(phieuId),
    repo.getLenhBasic(phieu.lenh_san_xuat_id),
  ]);
  await repo.finishPhieu(phieuId, actorId); // giống "Chạy hoàn tất": phiếu → HOAN_TAT (giai đoạn suy sang CHỜ KHÔ)
  await repo.logCloseProduction(phieuId, lenh?.ma_lenh_san_xuat || null, (lyDo || '').trim() || null,
    printed, lenh?.so_luong_release ?? null, actorId);
  sockets.emit('production:updated', { lenhId: phieu.lenh_san_xuat_id, action: 'finish' });
  sockets.emit('dashboard:refresh', {});
  return { phieu_id: phieuId, lenh_id: phieu.lenh_san_xuat_id, ma_lenh_san_xuat: lenh?.ma_lenh_san_xuat, printed };
}

// ----- MỞ LẠI LỆNH SẢN XUẤT (đã đóng/hoàn tất, cần in tiếp) — trong 2 ngày gần nhất -----
async function listReopenCandidates() {
  return repo.listReopenCandidates();
}

async function reopenProduction(phieuId, actorId) {
  const phieu = await repo.getPhieuFull(phieuId);
  if (!phieu) throw new AppError('Phiếu sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (phieu.trang_thai !== 'HOAN_TAT') {
    throw new AppError('Chỉ mở lại phiếu đã hoàn tất (đang chạy thì không cần mở lại)', { status: 409, errorCode: 'WRONG_STAGE' });
  }
  if (!phieu.tg_kt || (Date.now() - new Date(phieu.tg_kt).getTime()) > 2 * 24 * 60 * 60 * 1000) {
    throw new AppError('Chỉ mở lại được lệnh đã đóng trong 2 ngày gần nhất', { status: 409, errorCode: 'TOO_OLD' });
  }
  await withTransaction((client) => repo.reopenPhieuTx(client, phieuId, phieu.lenh_san_xuat_id, actorId));
  await repo.logReopenProduction(phieuId, phieu.ma_lenh_san_xuat, actorId);
  await tracking.moveByLenh(phieu.lenh_san_xuat_id, 'SAN_XUAT', actorId);
  sockets.emit('production:updated', { lenhId: phieu.lenh_san_xuat_id, action: 'reopen' });
  sockets.emit('dashboard:refresh', {});
  return { phieu_id: phieuId, lenh_id: phieu.lenh_san_xuat_id, ma_lenh_san_xuat: phieu.ma_lenh_san_xuat };
}

// ----- NGỪNG LỆNH CHẠY (ngừng phần in đang chạy để in hàng gấp hơn) -----
// Kết thúc lượt chạy hiện tại (tem đã in đi tiếp Chờ khô/kiểm — giữ nguyên số lượng) và đưa lệnh về
// "chờ chạy" (RELEASE_2, KHÔNG cần test lại) để lập lại kế hoạch / hoán đổi phần in gấp hơn.
async function pauseLenhChay(phieuId, actorId) {
  const phieu = await repo.getPhieuFull(phieuId);
  if (!phieu) throw new AppError('Phiếu sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (phieu.trang_thai !== 'DANG_CHAY') {
    throw new AppError('Phiếu không ở trạng thái đang chạy', { status: 409, errorCode: 'WRONG_STAGE' });
  }
  const printed = await repo.getPrintedTotal(phieuId);
  await repo.finishPhieu(phieuId, actorId);                                        // lượt chạy này kết thúc (tem đi tiếp)
  await withTransaction((client) =>
    repo.setLenhTrangThai(client, phieu.lenh_san_xuat_id, 'RELEASE_2', actorId));  // lệnh về chờ chạy (không test lại)
  await repo.logPauseLenhChay(phieu.lenh_san_xuat_id, phieu.ma_lenh_san_xuat, printed, actorId);
  await tracking.moveByLenh(phieu.lenh_san_xuat_id, 'RELEASE_2', actorId);
  sockets.emit('production:updated', { lenhId: phieu.lenh_san_xuat_id, action: 'ngung-lenh' });
  sockets.emit('workflow:updated', { lenhId: phieu.lenh_san_xuat_id, stage: 'RELEASE_2' });
  sockets.emit('dashboard:refresh', {});
  return { lenh_id: phieu.lenh_san_xuat_id, ma_lenh_san_xuat: phieu.ma_lenh_san_xuat, printed };
}

// ----- ĐỔI CHUYỀN của lượt chạy (máy hỏng / dồn tải sang chuyền khác) -----
// Đổi CẢ phiếu lẫn lệnh trong 1 transaction: `phieu_san_xuat.chuyen_id` là chuyền THỰC TẾ đang in,
// còn `lenh_san_xuat.chuyen_id` là thứ mọi màn theo lệnh đọc (Theo dõi chuyền, Excel, dashboard,
// chip lọc loại chuyền) — đổi lệch nhau sẽ ra 2 con số đá nhau.
// ⚠ KHÔNG đụng tem/xe phơi: tem đã in xong thuộc về lượt in đó, đổi chuyền không làm chúng in lại.
async function doiChuyen(phieuId, { chuyenId, ghiChu }, actorId) {
  const phieu = await repo.getPhieuFull(phieuId);
  if (!phieu) throw new AppError('Phiếu sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (phieu.trang_thai !== 'DANG_CHAY') {
    throw new AppError('Chỉ đổi chuyền được khi lệnh đang chạy', { status: 409, errorCode: 'WRONG_STAGE' });
  }
  if (!chuyenId) throw new AppError('Chọn chuyền mới', { status: 422, errorCode: 'NO_CHUYEN' });
  const moi = await repo.getChuyenById(chuyenId);
  if (!moi) throw new AppError('Chuyền không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (moi.dang_hoat_dong === false) {
    throw new AppError('Chuyền đã ngừng hoạt động — chọn chuyền khác', { status: 409, errorCode: 'CHUYEN_NGUNG' });
  }
  const lenh = await repo.getLenhBasic(phieu.lenh_san_xuat_id);
  if (lenh && lenh.chuyen_id === chuyenId) {
    throw new AppError('Lệnh đang ở đúng chuyền này rồi', { status: 409, errorCode: 'KHONG_DOI' });
  }

  await withTransaction(async (client) => {
    await repo.setPhieuChuyen(client, phieuId, chuyenId, actorId);
    await repo.setLenhChuyen(client, phieu.lenh_san_xuat_id, chuyenId, actorId);
  });
  await repo.logDoiChuyen(phieuId, {
    ma_lenh: phieu.ma_lenh_san_xuat || null,
    chuyen_cu: lenh ? { id: lenh.chuyen_id, ma: lenh.ma_chuyen, ten: lenh.ten_chuyen } : null,
    chuyen_moi: { id: moi.id, ma: moi.ma_chuyen, ten: moi.ten_chuyen },
    ghi_chu: (ghiChu || '').trim() || null,
  }, actorId);

  sockets.emit('production:updated', { lenhId: phieu.lenh_san_xuat_id, action: 'doi-chuyen' });
  sockets.emit('dashboard:refresh', {});
  return {
    phieu_id: phieuId,
    lenh_id: phieu.lenh_san_xuat_id,
    chuyen_cu: lenh ? (lenh.ten_chuyen || lenh.ma_chuyen) : null,
    chuyen_moi: moi.ten_chuyen || moi.ma_chuyen,
  };
}

// ----- HỦY LỆNH ĐANG CHẠY (bấm nhầm Xác nhận chạy) → đưa về danh sách chờ chạy -----
async function listUndoStartCandidates() {
  const running = await repo.monitorRunning();
  return running.filter((r) => Number(r.so_tem) === 0); // chỉ lệnh CHƯA in tem nào
}

async function undoStartProduction(phieuId, actorId) {
  const phieu = await repo.getPhieuById(phieuId);
  if (!phieu) throw new AppError('Phiếu sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (phieu.trang_thai !== 'DANG_CHAY') {
    throw new AppError('Phiếu không ở trạng thái đang chạy', { status: 409, errorCode: 'WRONG_STAGE' });
  }
  const printed = await repo.getPrintedTotal(phieuId);
  if (printed > 0) {
    throw new AppError('Lệnh đã in tem — không thể hủy xác nhận chạy (dùng Hủy lệnh in tem / Đóng lệnh)', { status: 409, errorCode: 'HAS_TEM' });
  }
  const lenh = await repo.getLenhBasic(phieu.lenh_san_xuat_id);
  await withTransaction(async (client) => {
    await repo.cancelPhieuStart(client, phieuId, actorId);                       // phiếu → HUY
    await repo.setLenhTrangThai(client, phieu.lenh_san_xuat_id, 'RELEASE_2', actorId); // lệnh về "chờ chạy"
  });
  await repo.logUndoStart(phieuId, lenh?.ma_lenh_san_xuat || null, actorId);
  sockets.emit('production:updated', { lenhId: phieu.lenh_san_xuat_id, action: 'undo-start' });
  sockets.emit('dashboard:refresh', {});
  return { lenh_id: phieu.lenh_san_xuat_id, ma_lenh_san_xuat: lenh?.ma_lenh_san_xuat };
}

// ===== VƯỢT SẢN XUẤT =====
// Cộng SL vượt vào so_luong_release của lệnh + TRỪ SL đó khỏi các đợt vải CHƯA release của
// cùng phần in (đợt về 0 → ẩn). Ghi lịch sử. SL trừ là best-effort (thiếu đợt chưa release thì trừ được bao nhiêu hay bấy nhiêu).
async function vuotSanXuat(phieuId, soLuong, actorId) {
  const qty = Number(soLuong);
  if (!(qty > 0)) throw new AppError('Số lượng vượt phải > 0', { status: 422, errorCode: 'INVALID_QTY' });
  const ctx = await repo.getVuotContext(phieuId);
  if (!ctx) throw new AppError('Phiếu sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const phanInIds = (ctx.phan_in_ids || []).filter(Boolean);

  const result = await withTransaction(async (client) => {
    const releaseSau = await repo.incLenhRelease(client, ctx.lenh_id, qty, actorId);
    // Trừ SL vượt khỏi các đợt vải chưa release (cùng phần in), theo thứ tự ngày vải về.
    // adjustDotVaiQty/markDotVaiGop dùng chung từ planningRepo.
    const dots = phanInIds.length ? await repo.listUnreleasedDotVaiForPhanIn(phanInIds) : [];
    let remain = qty;
    const chiTiet = [];
    for (const d of dots) {
      if (remain <= 0) break;
      const take = Math.min(remain, d.so_luong_vai_ve);
      if (take <= 0) continue;
      const conLai = await planningRepo.adjustDotVaiQty(client, d.id, -take, actorId);
      if (conLai <= 0) await planningRepo.markDotVaiGop(client, d.id, actorId);
      remain -= take;
      chiTiet.push({ dot_vai_ve_id: d.id, ma_dot_vai: d.ma_dot_vai, tru: take, con_lai: conLai });
    }
    const daTru = qty - remain;
    await repo.insertVuotHistory(client, {
      phieuId, lenhId: ctx.lenh_id, phanInId: phanInIds[0] || null,
      soLuongVuot: qty, releaseTruoc: ctx.so_luong_release, releaseSau,
      soLuongDaTru: daTru, chiTietTru: chiTiet,
    }, actorId);
    return { release_truoc: ctx.so_luong_release, release_sau: releaseSau, so_luong_da_tru: daTru, chi_tiet: chiTiet };
  });

  sockets.emit('production:updated', { lenhId: ctx.lenh_id, action: 'vuot-san-xuat' });
  sockets.emit('order:updated', { source: 'vuot' });
  sockets.emit('dashboard:refresh', {});
  return result;
}

module.exports = {
  listCandidates, getRun, startProduction, startProductionSpecial, printTem, printTemBatch, reprintTem, temLabel, temLogs, finishRun, monitor, vuotSanXuat,
  getXePhoi, listTemChoPhoi, addToXe, adjustPhoi, listDrying, confirmDry, redry,
  stopLine, resumeLine, addVaiHuy, savePhanCong,
  dsLyDoNgung, taoLyDoNgung, suaLyDoNgung, doiTrangThaiLyDoNgung,
  dsLyDoBoSung, taoLyDoBoSung, suaLyDoBoSung, doiTrangThaiLyDoBoSung, luuLyDoBoSungDotVai,
  listCancelableTem, cancelPrintTem,
  listCloseCandidates, closeProduction,
  listReopenCandidates, reopenProduction, pauseLenhChay, doiChuyen,
  listUndoStartCandidates, undoStartProduction,
};
