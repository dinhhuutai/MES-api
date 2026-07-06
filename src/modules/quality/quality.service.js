'use strict';

const { withTransaction } = require('../../config/db');
const repo = require('./quality.repository');
const AppError = require('../../utils/AppError');
const sockets = require('../../sockets');
const tracking = require('../workflow/tracking.service');

const num = (x) => Math.max(0, Number(x) || 0);

async function requireTem(temId, expectStatus) {
  const tem = await repo.getTemBasic(temId);
  if (!tem) throw new AppError('Tem không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (tem.trang_thai !== expectStatus) {
    throw new AppError(`Tem không ở trạng thái ${expectStatus}`, { status: 409, errorCode: 'WRONG_STAGE' });
  }
  return tem;
}

// ----- KCS (đầu vào: tem DA_KHO) -----
const prodRepo = require('../production/production.repository');
async function listKcsCandidates(search) {
  // Tem hết giờ phơi → tự động sang DA_KHO (chờ KCS) trước khi liệt kê.
  try { await prodRepo.promoteFinishedDrying(); } catch (e) { /* bỏ qua */ }
  const rows = await repo.listKcsCand({ search }); // còn phần chưa kiểm (con_kcs > 0)
  // Đánh dấu tem bị OQC trả về (badge + lọc).
  const rm = await repo.activeReturnsMap('OQC', rows.map((r) => r.tem_id));
  rows.forEach((r) => { r.tra_ve_ly_do = rm[r.tem_id] || null; });
  return rows;
}

// OQC trả tem về KCS (kèm lý do bắt buộc). Đưa phần đang CHỜ OQC (con_oqc) quay lại chưa kiểm (con_kcs).
async function returnOqcToKcs(temId, body, actorId) {
  const lyDo = (body.lyDo || '').trim();
  if (!lyDo) throw new AppError('Nhập lý do trả về KCS', { status: 422, errorCode: 'NO_LY_DO' });
  const tem = await repo.getTemLedger(temId);
  if (!tem) throw new AppError('Tem không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const con = Number(tem.con_oqc) || 0;
  if (con <= 0) throw new AppError('Tem không còn phần chờ OQC để trả về', { status: 409, errorCode: 'NO_OQC' });
  await withTransaction(async (client) => {
    await repo.reduceKcsDat(client, temId, con, actorId); // phần chờ OQC → về chưa kiểm (KCS)
    await repo.recomputeTemStage(client, temId, actorId);
  });
  await repo.insertQcTraVe({ loai: 'OQC', temId, lyDo }, actorId);
  await tracking.moveByTem(temId, 'KIEM', actorId);
  sockets.emit('quality:updated', { temId, stage: 'OQC', next: 'TRA_VE_KCS' });
  sockets.emit('dashboard:refresh', {});
  return { tem_id: temId, next: 'TRA_VE_KCS' };
}

// Lịch sử QC trả về theo loại + ngày (cho trang toggle 3 loại).
async function qcTraVeHistory(loai, date) {
  const L = ['READY', 'TEST_RUN', 'OQC'].includes(loai) ? loai : 'READY';
  return repo.listQcTraVe(L, date);
}

async function recordKcs(temId, body, actorId) {
  const tem = await repo.getTemLedger(temId);
  if (!tem) throw new AppError('Tem không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (['IN', 'DANG_PHOI'].includes(tem.trang_thai)) throw new AppError('Tem chưa khô', { status: 409, errorCode: 'WRONG_STAGE' });
  const conKcs = Number(tem.con_kcs) || 0;
  if (conKcs <= 0) throw new AppError('Tem không còn phần chờ KCS', { status: 409, errorCode: 'DONE' });

  const dat = num(body.soLuongDat);                          // đạt → chờ OQC
  const hu = num(body.soLuongHu);                            // hư (khuyết tật)
  const quyetDinhSua = Math.min(num(body.soLuongSua), hu);   // ≤ hư (mặc định = hư) → chờ sửa
  const huyTrucTiep = num(body.soLuongHuy);                  // hủy nhập trực tiếp → loại
  const mau = num(body.soLuongMau);                          // mẫu: ghi nhận tham khảo, KHÔNG tính vào SL kiểm
  const thieu = num(body.soLuongThieu);
  const du = num(body.soLuongDu);
  const chenh = du - thieu;                                  // dư(+)/thiếu(−) → đổi TỔNG CẦN KIỂM = so_luong + Σchênh

  const huyTaiKcs = (hu - quyetDinhSua) + huyTrucTiep;       // phần hư không sửa + hủy trực tiếp → loại
  // SL kiểm được lần này = đạt + hư + hủy (= đạt + sửa + hủyTạiKcs). Mẫu không tính; ≤ SL còn lại (± chênh lệch).
  const kiem = dat + hu + huyTrucTiep;
  if (kiem <= 0) throw new AppError('Nhập số lượng kiểm (đạt/hư/hủy)', { status: 422, errorCode: 'EMPTY' });
  const conSauChenh = conKcs + chenh; // dư làm tăng, thiếu làm giảm phần còn được kiểm
  if (kiem > conSauChenh) {
    throw new AppError(`SL kiểm lần này (${kiem}) vượt SL còn lại (${conSauChenh}${chenh ? ` = còn ${conKcs} ${chenh > 0 ? '+ dư ' + chenh : '− thiếu ' + -chenh}` : ''})`,
      { status: 422, errorCode: 'OVER' });
  }

  const data = {
    soLuongKiem: kiem, soLuongMau: mau, soLuongDat: dat, soLuongLoi: hu,
    soLuongHuy: huyTaiKcs, soLuongChenhLech: chenh,
    ketQua: (hu > 0 || huyTrucTiep > 0) ? 'CO_LOI' : 'DAT', ghiChu: body.ghiChu,
  };

  await withTransaction(async (client) => {
    await repo.insertKcs(client, temId, data, actorId);
    // Cộng dồn sổ cái: đạt → chờ OQC; quyết định sửa → chờ sửa; (hư không sửa + hủy) → loại; chênh lệch → tổng cần kiểm.
    await repo.addKcsLedger(client, temId, { dat, sua: quyetDinhSua, huy: huyTaiKcs, chenh }, actorId);
    await repo.recomputeTemStage(client, temId, actorId);
  });
  await tracking.moveByTem(temId, 'KIEM', actorId);
  await repo.resolveReturns('OQC', temId); // KCS làm lại xong → tắt cờ "bị OQC trả về"
  sockets.emit('quality:updated', { temId, stage: 'KCS' });
  sockets.emit('dashboard:refresh', {});
  const conLai = conSauChenh - kiem; // SL chưa kiểm còn lại (đã tính chênh lệch)
  return { tem_id: temId, next: 'KCS', so_luong_dat: dat, so_luong_sua: quyetDinhSua, so_luong_huy: huyTaiKcs, con_kcs: conLai };
}

// ----- SỬA (còn phần chờ sửa: con_sua > 0) -----
async function listSuaCandidates(search) { return repo.listSuaCand({ search }); }

async function recordSua(temId, body, actorId) {
  const tem = await repo.getTemLedger(temId);
  if (!tem) throw new AppError('Tem không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const conSua = Number(tem.con_sua) || 0;
  if (conSua <= 0) throw new AppError('Tem không còn phần chờ sửa', { status: 409, errorCode: 'DONE' });

  const huyThang = num(body.soLuongHuyThang);
  const suaDat = num(body.soLuongSuaDat);
  const suaHuy = num(body.soLuongSuaHuy) + huyThang;
  const total = suaDat + suaHuy; // SL xử lý lần này
  if (total <= 0) throw new AppError('Nhập số lượng sửa', { status: 422, errorCode: 'EMPTY' });
  if (total > conSua) throw new AppError(`SL sửa lần này (${total}) vượt SL cần sửa còn lại (${conSua})`, { status: 422, errorCode: 'OVER' });

  const ghiChu = [body.ghiChu, huyThang > 0 ? `Hủy thẳng: ${huyThang}` : null].filter(Boolean).join(' · ') || null;

  await withTransaction(async (client) => {
    await repo.insertSua(client, temId, { soLuongSua: total, soLuongSuaDat: suaDat, soLuongSuaHuy: suaHuy, ghiChu }, actorId);
    // Sửa đạt → quay lại pool OQC; sửa hủy → hủy.
    await repo.addSuaLedger(client, temId, { dat: suaDat, huy: suaHuy }, actorId);
    await repo.recomputeTemStage(client, temId, actorId);
  });
  await tracking.moveByTem(temId, 'SUA', actorId);
  sockets.emit('quality:updated', { temId, stage: 'SUA' });
  return { tem_id: temId, next: 'SUA', so_luong_sua_dat: suaDat, con_sua: conSua - total };
}

// ----- OQC (còn phần chờ kiểm cuối: con_oqc > 0) -----
async function listOqcCandidates(search) { return repo.listOqcCand({ search }); }

async function recordOqc(temId, body, actorId) {
  const tem = await repo.getTemLedger(temId);
  if (!tem) throw new AppError('Tem không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const conOqc = Number(tem.con_oqc) || 0;
  if (conOqc <= 0) throw new AppError('Tem không còn phần chờ OQC', { status: 409, errorCode: 'DONE' });
  const dat = num(body.soLuongDat);
  const loi = num(body.soLuongLoi);
  const kiem = dat + loi;
  if (kiem <= 0) throw new AppError('Nhập số lượng kiểm', { status: 422, errorCode: 'EMPTY' });
  if (kiem > conOqc) throw new AppError(`SL kiểm lần này (${kiem}) vượt SL chờ OQC (${conOqc})`, { status: 422, errorCode: 'OVER' });
  const ketQua = body.ketQua === 'KHONG_DAT' ? 'KHONG_DAT' : 'DAT';
  const lanKiem = await repo.nextOqcRound(temId);

  const ownerChoGiaoId = body.ownerChoGiaoId || null;
  const lyDoChoGiao = (body.lyDoChoGiao || '').trim() || null;
  const truongHopGiaoId = body.truongHopGiaoId || null;
  let choGiao = false;
  let next;

  if (ketQua === 'DAT') {
    next = 'OQC_DAT'; // đạt → sẵn sàng giao
  } else if (ownerChoGiaoId) {
    // Không đạt nhưng CHO GIAO NGOẠI LỆ — bắt buộc có TRƯỜNG HỢP giao đặc biệt + lý do + owner.
    if (!truongHopGiaoId) throw new AppError('Cho giao ngoại lệ cần chọn trường hợp giao đặc biệt', { status: 422, errorCode: 'NO_TRUONG_HOP' });
    if (!lyDoChoGiao) throw new AppError('Cho giao ngoại lệ cần nhập lý do', { status: 422, errorCode: 'NO_LY_DO' });
    choGiao = true;
    next = 'CHO_GIAO_NGOAI_LE'; // tem → OQC_DAT (đánh dấu cho giao ngoại lệ)
  } else {
    next = 'GIU_OQC'; // không đạt & chưa có owner cho giao → NẰM LẠI OQC
  }

  // SL cộng vào "chờ giao": phần đạt; nếu cho giao ngoại lệ thì cả phần lỗi cũng cho giao.
  const oqcDatInc = dat + (choGiao ? loi : 0);
  await withTransaction(async (client) => {
    await repo.insertOqc(client, temId, {
      lanKiem, soLuongKiem: kiem, soLuongDat: dat, soLuongLoi: loi,
      ketQua, choGiao, lyDoChoGiao, ownerChoGiaoId, truongHopGiaoId, ghiChu: body.ghiChu,
    }, actorId);
    if (oqcDatInc > 0) await repo.addOqcLedger(client, temId, oqcDatInc, actorId); // → chờ giao
    // GIU_OQC (lỗi không cho giao): không cộng → phần lỗi vẫn nằm ở con_oqc (nằm lại OQC)
    await repo.recomputeTemStage(client, temId, actorId);
  });
  await tracking.moveByTem(temId, 'OQC', actorId); // theo dõi dòng chảy: OQC kiểm cuối
  if (oqcDatInc > 0) await tracking.moveByTem(temId, 'FINISH', actorId); // có phần cho giao → FINISH
  sockets.emit('quality:updated', { temId, stage: 'OQC', next });
  sockets.emit('dashboard:refresh', {});
  return { tem_id: temId, next };
}

const q0 = (v) => (v === null || v === undefined ? 0 : v);

async function kcsHistory(date) {
  const rows = await repo.kcsHistoryByDate(date);
  return rows.map((r) => ({
    tg: r.tg, nguoi: r.nguoi || '—',
    hanh_dong: `KCS${r.ket_qua ? ' · ' + r.ket_qua : ''}`,
    doi_tuong: r.ma_tem || '',
    chi_tiet: `Đạt ${q0(r.so_luong_dat)} · Lỗi ${q0(r.so_luong_loi)}`,
  }));
}

async function suaHistory(date) {
  const rows = await repo.suaHistoryByDate(date);
  return rows.map((r) => ({
    tg: r.tg, nguoi: r.nguoi || '—', hanh_dong: 'Sửa',
    doi_tuong: r.ma_tem || '',
    chi_tiet: `Sửa ${q0(r.so_luong_sua)} · Đạt ${q0(r.so_luong_sua_dat)}`,
  }));
}

async function oqcHistory(date) {
  const rows = await repo.oqcHistoryByDate(date);
  return rows.map((r) => ({
    tg: r.tg, nguoi: r.nguoi || '—',
    hanh_dong: `OQC${r.ket_qua ? ' · ' + r.ket_qua : ''}`,
    doi_tuong: r.ma_tem || '',
    chi_tiet: `Đạt ${q0(r.so_luong_dat)} · Lỗi ${q0(r.so_luong_loi)}`,
  }));
}

// ----- Danh sách "đã hoàn thành" theo ngày (cho DonePanel bên trái) -----
async function kcsDone(date) { return repo.temDoneByDate('kcs', date); }
async function suaDone(date) { return repo.temDoneByDate('sua', date); }
async function oqcDone(date) { return repo.temDoneByDate('oqc', date); }
async function inlineDone(date) { return repo.inlineDoneByDate(date); }

// ----- QC IN-LINE (kiểm tại chuyền — phiếu đang chạy) -----
async function listInlineCandidates(search) { return repo.listInlineCandidates({ search }); }
async function listLoaiLoi() { return repo.listLoaiLoiActive(); }

async function recordQcInline(phieuId, body, actorId) {
  const phieu = await repo.getPhieuRun(phieuId);
  if (!phieu) throw new AppError('Phiếu sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (phieu.trang_thai !== 'DANG_CHAY') {
    throw new AppError('Chỉ QC in-line phiếu đang chạy', { status: 409, errorCode: 'WRONG_STAGE' });
  }
  const soLuongMau = num(body.soLuongMau);
  const soLuongLoi = num(body.soLuongLoi);
  if (soLuongMau <= 0) throw new AppError('Nhập số lượng mẫu kiểm', { status: 422, errorCode: 'INVALID_QTY' });
  if (soLuongLoi > soLuongMau) throw new AppError('SL mẫu lỗi không vượt SL mẫu kiểm', { status: 422, errorCode: 'INVALID_QTY' });
  const ketQua = body.ketQua === 'KHONG_DAT' ? 'KHONG_DAT' : 'DAT';
  const loiList = Array.isArray(body.loi) ? body.loi.filter((x) => x && x.loaiLoiId) : [];

  const lanKiem = await repo.nextInlineRound(phieuId);
  await withTransaction(async (client) => {
    const qcId = await repo.insertQcInline(client, {
      phieuId, lenhId: phieu.lenh_san_xuat_id, lanKiem, soLuongMau, soLuongLoi, ketQua,
      nguyenNhan: body.nguyenNhan, khacPhuc: body.khacPhuc, ghiChu: body.ghiChu,
    }, actorId);
    for (const l of loiList) {
      await repo.insertQcInlineLoi(client, qcId, { loaiLoiId: l.loaiLoiId, soLuong: l.soLuong, ghiChu: l.ghiChu }, actorId);
    }
  });
  sockets.emit('quality:updated', { phieuId, stage: 'QC_INLINE', ketQua });
  return { phieu_id: phieuId, lan_kiem: lanKiem, ket_qua: ketQua };
}

async function inlineHistory(date) {
  const rows = await repo.inlineHistoryByDate(date);
  return rows.map((r) => ({
    tg: r.tg, nguoi: r.nguoi || '—',
    hanh_dong: `QC in-line${r.ket_qua ? ' · ' + (r.ket_qua === 'DAT' ? 'Đạt' : 'Không đạt') : ''}`,
    doi_tuong: `${r.ma_phan || r.ma_phieu_san_xuat || ''}`,
    chi_tiet: [
      `Mẫu ${q0(r.so_luong_mau)} · Lỗi ${q0(r.so_luong_loi)}`,
      r.loi_list ? `Loại: ${r.loi_list}` : null,
      r.nguyen_nhan ? `NN: ${r.nguyen_nhan}` : null,
      r.khac_phuc ? `KP: ${r.khac_phuc}` : null,
    ].filter(Boolean).join(' · '),
  }));
}

// ----- DANH MỤC LỖI -----
async function listLoaiLoiAll(search) { return repo.listLoaiLoiAll(search || ''); }

async function createLoaiLoi(body, actorId) {
  if (!body.maLoi || !body.tenLoi) throw new AppError('Nhập mã lỗi và tên lỗi', { status: 422, errorCode: 'MISSING' });
  const id = await repo.insertLoaiLoi({ maLoi: body.maLoi.trim(), tenLoi: body.tenLoi.trim(), nhomLoi: body.nhomLoi }, actorId);
  return { id };
}

async function updateLoaiLoi(id, body, actorId) {
  if (!body.tenLoi) throw new AppError('Nhập tên lỗi', { status: 422, errorCode: 'MISSING' });
  await repo.updateLoaiLoi(id, { tenLoi: body.tenLoi.trim(), nhomLoi: body.nhomLoi }, actorId);
  return { id };
}

async function toggleLoaiLoi(id, active, actorId) {
  await repo.setLoaiLoiActive(id, !!active, actorId);
  return { id };
}

// ----- DANH MỤC TRƯỜNG HỢP GIAO ĐẶC BIỆT -----
async function listGiaoDacBiet() { return repo.listGiaoDacBietActive(); }
async function listGiaoDacBietAll(search) { return repo.listGiaoDacBietAll(search || ''); }

async function createGiaoDacBiet(body, actorId) {
  if (!body.ma || !body.ten) throw new AppError('Nhập mã và tên trường hợp', { status: 422, errorCode: 'MISSING' });
  const id = await repo.insertGiaoDacBiet({ ma: body.ma.trim().toUpperCase(), ten: body.ten.trim() }, actorId);
  return { id };
}

async function updateGiaoDacBiet(id, body, actorId) {
  if (!body.ten) throw new AppError('Nhập tên trường hợp', { status: 422, errorCode: 'MISSING' });
  await repo.updateGiaoDacBiet(id, { ten: body.ten.trim() }, actorId);
  return { id };
}

async function toggleGiaoDacBiet(id, active, actorId) {
  await repo.setGiaoDacBietActive(id, !!active, actorId);
  return { id };
}

module.exports = {
  listKcsCandidates, recordKcs, listSuaCandidates, recordSua, listOqcCandidates, recordOqc,
  kcsHistory, suaHistory, oqcHistory,
  kcsDone, suaDone, oqcDone, inlineDone,
  listInlineCandidates, listLoaiLoi, recordQcInline, inlineHistory,
  listLoaiLoiAll, createLoaiLoi, updateLoaiLoi, toggleLoaiLoi,
  listGiaoDacBiet, listGiaoDacBietAll, createGiaoDacBiet, updateGiaoDacBiet, toggleGiaoDacBiet,
  returnOqcToKcs, qcTraVeHistory,
};
