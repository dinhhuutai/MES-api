'use strict';

const { withTransaction } = require('../../config/db');
const repo = require('./quality.repository');
const AppError = require('../../utils/AppError');
const sockets = require('../../sockets');

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
async function listKcsCandidates(search) { return repo.listByTemStatus('DA_KHO', { search }); }

async function recordKcs(temId, body, actorId) {
  await requireTem(temId, 'DA_KHO');
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
  let next;
  if (quyetDinhSua > 0) next = 'CHO_SUA';
  else if (dat > 0) next = 'CHO_OQC';
  else next = 'LOAI';

  await withTransaction(async (client) => {
    await repo.insertKcs(client, temId, data, actorId);
    await repo.setTemTrangThai(client, temId, next, actorId);
  });
  sockets.emit('quality:updated', { temId, stage: 'KCS', next });
  sockets.emit('dashboard:refresh', {});
  return { tem_id: temId, next };
}

// ----- SỬA (đầu vào: tem CHO_SUA) -----
async function listSuaCandidates(search) { return repo.listByTemStatus('CHO_SUA', { search }); }

async function recordSua(temId, body, actorId) {
  await requireTem(temId, 'CHO_SUA');
  const huyThang = num(body.soLuongHuyThang);
  const sua = num(body.soLuongSua);
  const suaDat = Math.min(num(body.soLuongSuaDat), sua);
  const suaHuy = Math.min(num(body.soLuongSuaHuy), sua);

  const ghiChu = [body.ghiChu, huyThang > 0 ? `Hủy thẳng: ${huyThang}` : null].filter(Boolean).join(' · ') || null;
  const next = suaDat > 0 ? 'CHO_OQC' : 'LOAI';

  await withTransaction(async (client) => {
    await repo.insertSua(client, temId, {
      soLuongSua: sua, soLuongSuaDat: suaDat, soLuongSuaHuy: suaHuy, ghiChu,
    }, actorId);
    await repo.setTemTrangThai(client, temId, next, actorId);
  });
  sockets.emit('quality:updated', { temId, stage: 'SUA', next });
  return { tem_id: temId, next };
}

// ----- OQC (đầu vào: tem CHO_OQC) -----
async function listOqcCandidates(search) { return repo.listByTemStatus('CHO_OQC', { search }); }

async function recordOqc(temId, body, actorId) {
  await requireTem(temId, 'CHO_OQC');
  const dat = num(body.soLuongDat);
  const loi = num(body.soLuongLoi);
  const ketQua = body.ketQua === 'KHONG_DAT' ? 'KHONG_DAT' : 'DAT';
  const lanKiem = await repo.nextOqcRound(temId);
  const next = ketQua === 'DAT' ? 'OQC_DAT' : 'CHO_SUA';

  await withTransaction(async (client) => {
    await repo.insertOqc(client, temId, {
      lanKiem, soLuongKiem: num(body.soLuongKiem) || dat + loi, soLuongDat: dat, soLuongLoi: loi, ketQua, ghiChu: body.ghiChu,
    }, actorId);
    await repo.setTemTrangThai(client, temId, next, actorId);
  });
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
  listInlineCandidates, listLoaiLoi, recordQcInline, inlineHistory,
  listLoaiLoiAll, createLoaiLoi, updateLoaiLoi, toggleLoaiLoi,
};
