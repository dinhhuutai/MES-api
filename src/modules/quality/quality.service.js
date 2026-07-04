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
  return repo.listByTemStatus('DA_KHO', { search });
}

async function recordKcs(temId, body, actorId) {
  const tem = await repo.getTemForSplit(temId);
  if (!tem) throw new AppError('Tem không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (tem.trang_thai !== 'DA_KHO') throw new AppError('Tem không ở trạng thái DA_KHO', { status: 409, errorCode: 'WRONG_STAGE' });

  const dat = num(body.soLuongDat);
  const thieu = num(body.soLuongThieu);
  const du = num(body.soLuongDu);
  const mau = num(body.soLuongMau);
  const hu = num(body.soLuongHu);
  const quyetDinhSua = Math.min(num(body.soLuongSua), hu); // ≤ hư
  const huyTaiKcs = hu - quyetDinhSua;

  const data = {
    soLuongKiem: dat + hu + mau,
    soLuongMau: mau,
    soLuongDat: dat,
    soLuongLoi: hu,
    soLuongHuy: huyTaiKcs,
    soLuongChenhLech: du - thieu,
    ketQua: hu > 0 ? 'CO_LOI' : 'DAT',
    ghiChu: body.ghiChu,
  };

  // TÁCH 2 HƯỚNG: phần ĐẠT → OQC (giữ trên tem gốc), phần SỬA → tem con CHO_SUA.
  // Nhờ tách, phần đạt LUÔN đi tiếp OQC dù có phần phải sửa (sửa bug cũ: 1 phần sửa làm kẹt cả tem).
  const needChild = dat > 0 && quyetDinhSua > 0;
  const maTemChild = needChild ? await repo.nextMaTem() : null;
  let next; let childTemId = null;

  await withTransaction(async (client) => {
    await repo.insertKcs(client, temId, data, actorId);
    if (needChild) {
      await repo.setTemStatusQty(client, temId, 'CHO_OQC', dat, actorId); // tem gốc = phần đạt
      childTemId = await repo.createChildTem(client, {
        phieuId: tem.phieu_san_xuat_id, maTem: maTemChild, soLuong: quyetDinhSua, trangThai: 'CHO_SUA',
      }, actorId);
      await repo.insertTemSplit(client, { chaId: temId, conId: childTemId, soLuong: quyetDinhSua, lyDo: 'KCS: tách phần sửa' }, actorId);
      next = 'SPLIT';
    } else if (quyetDinhSua > 0) {
      await repo.setTemStatusQty(client, temId, 'CHO_SUA', quyetDinhSua, actorId);
      next = 'CHO_SUA';
    } else if (dat > 0) {
      await repo.setTemStatusQty(client, temId, 'CHO_OQC', dat, actorId);
      next = 'CHO_OQC';
    } else {
      await repo.setTemTrangThai(client, temId, 'LOAI', actorId);
      next = 'LOAI';
    }
  });
  await tracking.moveByTem(temId, 'KIEM', actorId); // theo dõi dòng chảy: KCS kiểm
  sockets.emit('quality:updated', { temId, stage: 'KCS', next });
  sockets.emit('dashboard:refresh', {});
  return { tem_id: temId, next, so_luong_dat: dat, so_luong_sua: quyetDinhSua, child_tem_id: childTemId };
}

// ----- SỬA (đầu vào: tem CHO_SUA) -----
async function listSuaCandidates(search) { return repo.listByTemStatus('CHO_SUA', { search }); }

async function recordSua(temId, body, actorId) {
  const tem = await repo.getTemForSplit(temId);
  if (!tem) throw new AppError('Tem không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (tem.trang_thai !== 'CHO_SUA') throw new AppError('Tem không ở trạng thái CHO_SUA', { status: 409, errorCode: 'WRONG_STAGE' });

  const huyThang = num(body.soLuongHuyThang);
  const sua = num(body.soLuongSua) || num(tem.so_luong); // mặc định = SL cần sửa (kế thừa từ KCS)
  const suaDat = Math.min(num(body.soLuongSuaDat), sua);
  const suaHuy = Math.min(num(body.soLuongSuaHuy), sua);

  const ghiChu = [body.ghiChu, huyThang > 0 ? `Hủy thẳng: ${huyThang}` : null].filter(Boolean).join(' · ') || null;

  // Sửa đạt → SINH TEM MỚI cho phần sửa đạt → OQC; tem sửa gốc kết thúc (LOAI).
  const maTemChild = suaDat > 0 ? await repo.nextMaTem() : null;
  let next; let childTemId = null;

  await withTransaction(async (client) => {
    await repo.insertSua(client, temId, { soLuongSua: sua, soLuongSuaDat: suaDat, soLuongSuaHuy: suaHuy, ghiChu }, actorId);
    if (suaDat > 0) {
      childTemId = await repo.createChildTem(client, {
        phieuId: tem.phieu_san_xuat_id, maTem: maTemChild, soLuong: suaDat, trangThai: 'CHO_OQC',
      }, actorId);
      await repo.insertTemSplit(client, { chaId: temId, conId: childTemId, soLuong: suaDat, lyDo: 'Sửa đạt → OQC' }, actorId);
      await repo.setTemTrangThai(client, temId, 'LOAI', actorId);
      next = 'CHO_OQC';
    } else {
      await repo.setTemTrangThai(client, temId, 'LOAI', actorId);
      next = 'LOAI';
    }
  });
  await tracking.moveByTem(temId, 'SUA', actorId); // theo dõi dòng chảy: hàng lỗi chuyển sửa
  sockets.emit('quality:updated', { temId, stage: 'SUA', next, child_tem_id: childTemId });
  return { tem_id: temId, next, child_tem_id: childTemId };
}

// ----- OQC (đầu vào: tem CHO_OQC) -----
async function listOqcCandidates(search) { return repo.listByTemStatus('CHO_OQC', { search }); }

async function recordOqc(temId, body, actorId) {
  await requireTem(temId, 'CHO_OQC');
  const dat = num(body.soLuongDat);
  const loi = num(body.soLuongLoi);
  const ketQua = body.ketQua === 'KHONG_DAT' ? 'KHONG_DAT' : 'DAT';
  const lanKiem = await repo.nextOqcRound(temId);

  const ownerChoGiaoId = body.ownerChoGiaoId || null;
  const lyDoChoGiao = (body.lyDoChoGiao || '').trim() || null;
  let choGiao = false;
  let next;

  if (ketQua === 'DAT') {
    next = 'OQC_DAT'; // đạt → sẵn sàng giao
  } else if (ownerChoGiaoId) {
    // Không đạt nhưng CHO GIAO NGOẠI LỆ — bắt buộc có lý do + owner.
    if (!lyDoChoGiao) throw new AppError('Cho giao ngoại lệ cần nhập lý do', { status: 422, errorCode: 'NO_LY_DO' });
    choGiao = true;
    next = 'CHO_GIAO_NGOAI_LE'; // tem → OQC_DAT (đánh dấu cho giao ngoại lệ)
  } else {
    next = 'GIU_OQC'; // không đạt & chưa có owner cho giao → NẰM LẠI OQC
  }

  await withTransaction(async (client) => {
    await repo.insertOqc(client, temId, {
      lanKiem, soLuongKiem: num(body.soLuongKiem) || dat + loi, soLuongDat: dat, soLuongLoi: loi,
      ketQua, choGiao, lyDoChoGiao, ownerChoGiaoId, ghiChu: body.ghiChu,
    }, actorId);
    if (next === 'OQC_DAT' || next === 'CHO_GIAO_NGOAI_LE') {
      await repo.setTemTrangThai(client, temId, 'OQC_DAT', actorId); // sang giao hàng
    }
    // GIU_OQC: giữ nguyên CHO_OQC (nằm lại OQC)
  });
  await tracking.moveByTem(temId, 'OQC', actorId); // theo dõi dòng chảy: OQC kiểm cuối
  if (next !== 'GIU_OQC') await tracking.moveByTem(temId, 'FINISH', actorId); // cho giao → FINISH
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

module.exports = {
  listKcsCandidates, recordKcs, listSuaCandidates, recordSua, listOqcCandidates, recordOqc,
  kcsHistory, suaHistory, oqcHistory,
  kcsDone, suaDone, oqcDone, inlineDone,
  listInlineCandidates, listLoaiLoi, recordQcInline, inlineHistory,
  listLoaiLoiAll, createLoaiLoi, updateLoaiLoi, toggleLoaiLoi,
};
