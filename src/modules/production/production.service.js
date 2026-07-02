'use strict';

const { withTransaction } = require('../../config/db');
const repo = require('./production.repository');
const AppError = require('../../utils/AppError');
const { buildMeta } = require('../../utils/pagination');
const sockets = require('../../sockets');
const tracking = require('../workflow/tracking.service');

async function listCandidates({ search, page, limit, offset }) {
  const { rows, total } = await repo.listProductionCandidates({ search, offset, limit });
  return { items: rows, meta: buildMeta(page, limit, total) };
}

async function getRun(lenhId) {
  const lenh = await repo.getLenhBasic(lenhId);
  if (!lenh) throw new AppError('Lệnh sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const phieu = await repo.getActivePhieu(lenhId);
  const tems = phieu ? await repo.getTemsByPhieu(phieu.id) : [];
  const printed = tems.reduce((s, t) => s + (t.trang_thai === 'HUY' ? 0 : (Number(t.so_luong) || 0)), 0);
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
  let newTemId;
  await withTransaction(async (client) => {
    newTemId = await repo.createTem(client, { phieuId, maTem, soLuong: qty }, actorId);
    await repo.logTemPrint(client, { temId: newTemId, maTem, actorId });
    await repo.addTemToXe(client, { temId: newTemId, xeId: xe.id, soLuongPhoi: qty, phut: DEFAULT_DRY_MIN }, actorId);
  });
  await tracking.moveByLenh(phieu.lenh_san_xuat_id, 'CHO_KHO', actorId); // in tem → xe phơi → CHỜ KHÔ
  sockets.emit('production:updated', { lenhId: phieu.lenh_san_xuat_id, action: 'tem' });
  sockets.emit('drying:updated', { lenhId: phieu.lenh_san_xuat_id, action: 'auto-phoi' });
  const run = await getRun(phieu.lenh_san_xuat_id);
  return { ...run, new_tem_id: newTemId };
}

// In lại tem: HỦY tem cũ (gỡ khỏi xe phơi) + tạo TEM MỚI (mã/barcode mới) để in lại.
// Chỉ cho in lại khi tem cũ còn ở giai đoạn IN/DANG_PHOI (chưa khô/kiểm).
async function reprintTem(temId, lyDo, actorId) {
  if (!lyDo || !lyDo.trim()) throw new AppError('Nhập lý do in lại tem', { status: 422, errorCode: 'NO_LY_DO' });
  const ctx = await repo.getTemContext(temId);
  if (!ctx) throw new AppError('Tem không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (!['IN', 'DANG_PHOI'].includes(ctx.trang_thai)) {
    throw new AppError('Tem đã qua công đoạn sau (khô/kiểm/giao), không thể in lại', { status: 409, errorCode: 'WRONG_STAGE' });
  }
  const xe = await repo.getDefaultXePhoi();
  if (!xe) throw new AppError('Chưa cấu hình xe phơi', { status: 409, errorCode: 'NO_XE' });

  const maTem = await repo.nextMaTem();
  let newTemId;
  await withTransaction(async (client) => {
    await repo.cancelTem(client, temId, actorId);                 // hủy tem cũ + gỡ xe phơi
    newTemId = await repo.createTem(client, { phieuId: ctx.phieu_san_xuat_id, maTem, soLuong: ctx.so_luong }, actorId);
    await repo.logTemPrint(client, { temId: newTemId, maTem, actorId, lyDo: `In lại thay ${ctx.ma_tem}: ${lyDo.trim()}` });
    await repo.addTemToXe(client, { temId: newTemId, xeId: xe.id, soLuongPhoi: ctx.so_luong, phut: DEFAULT_DRY_MIN }, actorId);
  });
  sockets.emit('production:updated', { lenhId: ctx.lenh_san_xuat_id, action: 'reprint', temId: newTemId });
  sockets.emit('drying:updated', { lenhId: ctx.lenh_san_xuat_id, action: 'auto-phoi' });
  const run = await getRun(ctx.lenh_san_xuat_id);
  return { ...run, new_tem_id: newTemId, huy_tem: ctx.ma_tem };
}

async function temLabel(temId) {
  const data = await repo.getTemLabelData(temId);
  if (!data) throw new AppError('Tem không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  return data;
}

async function temLogs(phieuId) {
  return repo.listTemLogByPhieu(phieuId);
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
  listCandidates, getRun, startProduction, printTem, reprintTem, temLabel, temLogs, finishRun, monitor,
  getXePhoi, listTemChoPhoi, addToXe, adjustPhoi, listDrying, confirmDry,
  stopLine, resumeLine,
};
