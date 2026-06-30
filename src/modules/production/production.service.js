'use strict';

const { withTransaction } = require('../../config/db');
const repo = require('./production.repository');
const AppError = require('../../utils/AppError');
const { buildMeta } = require('../../utils/pagination');
const sockets = require('../../sockets');

async function listCandidates({ search, page, limit, offset }) {
  const { rows, total } = await repo.listProductionCandidates({ search, offset, limit });
  return { items: rows, meta: buildMeta(page, limit, total) };
}

async function getRun(lenhId) {
  const lenh = await repo.getLenhBasic(lenhId);
  if (!lenh) throw new AppError('Lệnh sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const phieu = await repo.getActivePhieu(lenhId);
  const tems = phieu ? await repo.getTemsByPhieu(phieu.id) : [];
  const printed = tems.reduce((s, t) => s + (Number(t.so_luong) || 0), 0);
  const [ngungList, ngungActive] = phieu
    ? await Promise.all([repo.listNgungByPhieu(phieu.id), repo.getActiveNgung(phieu.id)])
    : [[], null];
  return { lenh, phieu, tems, printed, ngung_list: ngungList, ngung_active: ngungActive };
}

// Ngừng chuyền (đang sản xuất) — kèm lý do; cho ngừng nhiều lần/phiếu.
async function stopLine(phieuId, lyDo, actorId) {
  const phieu = await repo.getPhieuById(phieuId);
  if (!phieu) throw new AppError('Phiếu sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (phieu.trang_thai !== 'DANG_CHAY') throw new AppError('Phiếu không ở trạng thái đang chạy', { status: 409, errorCode: 'WRONG_STAGE' });
  if (!lyDo || !lyDo.trim()) throw new AppError('Nhập lý do ngừng chuyền', { status: 422, errorCode: 'NO_LY_DO' });
  const active = await repo.getActiveNgung(phieuId);
  if (active) throw new AppError('Chuyền đang ngừng — hãy cho hoạt động lại trước', { status: 409, errorCode: 'ALREADY_STOPPED' });
  const lenh = await repo.getLenhBasic(phieu.lenh_san_xuat_id);
  await repo.startNgung({ phieuId, lenhId: phieu.lenh_san_xuat_id, chuyenId: lenh?.chuyen_id, lyDo: lyDo.trim() }, actorId);
  sockets.emit('production:updated', { lenhId: phieu.lenh_san_xuat_id, action: 'ngung' });
  sockets.emit('dashboard:refresh', {});
  return getRun(phieu.lenh_san_xuat_id);
}

// Chuyền hoạt động lại — lưu thời gian ngừng.
async function resumeLine(phieuId, actorId) {
  const phieu = await repo.getPhieuById(phieuId);
  if (!phieu) throw new AppError('Phiếu sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const active = await repo.getActiveNgung(phieuId);
  if (!active) throw new AppError('Chuyền không trong trạng thái ngừng', { status: 409, errorCode: 'NOT_STOPPED' });
  await repo.resumeNgung(active.id, actorId);
  sockets.emit('production:updated', { lenhId: phieu.lenh_san_xuat_id, action: 'hoat-dong-lai' });
  sockets.emit('dashboard:refresh', {});
  return getRun(phieu.lenh_san_xuat_id);
}

async function startProduction(lenhId, actorId) {
  const lenh = await repo.getLenhBasic(lenhId);
  if (!lenh) throw new AppError('Lệnh sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (lenh.trang_thai !== 'RELEASE_2') {
    throw new AppError('Lệnh chưa ở trạng thái Release 2', { status: 409, errorCode: 'WRONG_STAGE' });
  }
  const maPhieu = await repo.nextMaPhieu();
  await withTransaction(async (client) => {
    await repo.createPhieu(client, { lenhId, chuyenId: lenh.chuyen_id, maPhieu }, actorId);
    await repo.setLenhTrangThai(client, lenhId, 'SAN_XUAT', actorId);
  });
  sockets.emit('production:updated', { lenhId, stage: 'SAN_XUAT' });
  sockets.emit('dashboard:refresh', {});
  return getRun(lenhId);
}

const DEFAULT_DRY_MIN = 60; // thời gian phơi mặc định (phút) — chỉnh được ở màn Xe phơi

async function printTem(phieuId, soLuong, actorId) {
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

  const maTem = await repo.nextMaTem();
  await withTransaction(async (client) => {
    const temId = await repo.createTem(client, { phieuId, maTem, soLuong: qty }, actorId);
    await repo.logTemPrint(client, { temId, maTem, actorId });
    await repo.addTemToXe(client, { temId, xeId: xe.id, soLuongPhoi: qty, phut: DEFAULT_DRY_MIN }, actorId);
  });
  sockets.emit('production:updated', { lenhId: phieu.lenh_san_xuat_id, action: 'tem' });
  sockets.emit('drying:updated', { lenhId: phieu.lenh_san_xuat_id, action: 'auto-phoi' });
  return getRun(phieu.lenh_san_xuat_id);
}

async function finishRun(phieuId, actorId) {
  const phieu = await repo.getPhieuById(phieuId);
  if (!phieu) throw new AppError('Phiếu sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  await repo.finishPhieu(phieuId, actorId);
  sockets.emit('production:updated', { lenhId: phieu.lenh_san_xuat_id, action: 'finish' });
  return getRun(phieu.lenh_san_xuat_id);
}

async function monitor() {
  const [running, queue] = await Promise.all([repo.monitorRunning(), repo.monitorQueue()]);
  return { running, queue };
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
  return repo.listDryingTems({ search });
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

module.exports = {
  listCandidates, getRun, startProduction, printTem, finishRun, monitor,
  getXePhoi, listTemChoPhoi, addToXe, adjustPhoi, listDrying, confirmDry,
  stopLine, resumeLine,
};
