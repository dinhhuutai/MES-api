'use strict';

const { withTransaction } = require('../../config/db');
const repo = require('./delivery.repository');
const AppError = require('../../utils/AppError');
const sockets = require('../../sockets');
const tracking = require('../workflow/tracking.service');

async function listTemSanSang(search) {
  return repo.listTemSanSang({ search });
}

async function getDetail(giaoHangId) {
  const gh = await repo.getGiaoHang(giaoHangId);
  if (!gh) throw new AppError('Phiếu giao không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const tems = await repo.getGiaoHangTems(giaoHangId);
  return { ...gh, tems };
}

// items: [{ temId, soLuong }] — soLuong = SL giao lần này (không nhập → giao hết phần còn lại).
// Vẫn nhận temIds (mảng id) để tương thích: giao hết phần còn lại của mỗi tem.
async function createGiaoHang({ items, temIds, ngayGiao, ghiChu }, actorId) {
  const list = Array.isArray(items) && items.length
    ? items.map((it) => ({ temId: it.temId, soLuong: it.soLuong != null ? Number(it.soLuong) : null }))
    : (Array.isArray(temIds) ? temIds.map((t) => ({ temId: t, soLuong: null })) : []);
  if (list.length === 0) throw new AppError('Chọn ít nhất một tem để giao', { status: 422, errorCode: 'NO_TEM' });
  const temIdList = list.map((x) => x.temId);
  const donIds = await repo.donHangIdsForTems(temIdList);
  const donHangId = donIds.length === 1 ? donIds[0] : null;
  const maPhieu = await repo.nextMaPhieuGiao();

  const id = await withTransaction(async (client) => {
    const ghId = await repo.createGiaoHang(client, { maPhieu, donHangId, ngayGiao, ghiChu }, actorId);
    for (const it of list) await repo.addTem(client, ghId, it.temId, it.soLuong, actorId);
    return ghId;
  });
  sockets.emit('delivery:updated', { giaoHangId: id, stage: 'TAO' });
  return getDetail(id);
}

async function listGiaoHang(search) {
  return repo.listGiaoHang({ search });
}

async function confirmGiao(giaoHangId, actorId) {
  const gh = await repo.getGiaoHang(giaoHangId);
  if (!gh) throw new AppError('Phiếu giao không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (gh.trang_thai === 'DA_GIAO') throw new AppError('Phiếu đã giao', { status: 409, errorCode: 'ALREADY' });
  if (gh.so_tem === 0) throw new AppError('Phiếu chưa có tem', { status: 422, errorCode: 'EMPTY' });

  // Cộng dồn sổ cái đã giao + đóng phiếu; tem chỉ chuyển DA_GIAO khi đã giao đủ (recompute dominant).
  await withTransaction(async (client) => {
    await repo.applyGiaoLedger(client, giaoHangId, actorId);
    await repo.markGiaoDone(client, giaoHangId, actorId);
  });
  // Theo dõi dòng chảy: các tem trong phiếu giao → trạm DONE_DELIVERY.
  const tems = await repo.getGiaoHangTems(giaoHangId);
  for (const t of tems) await tracking.moveByTem(t.tem_id || t.id, 'DONE_DELIVERY', actorId);
  sockets.emit('delivery:updated', { giaoHangId, stage: 'DA_GIAO' });
  sockets.emit('dashboard:refresh', {});
  return getDetail(giaoHangId);
}

module.exports = { listTemSanSang, getDetail, createGiaoHang, listGiaoHang, confirmGiao };
