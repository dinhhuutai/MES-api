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

module.exports = {
  listKcsCandidates, recordKcs, listSuaCandidates, recordSua, listOqcCandidates, recordOqc,
};
