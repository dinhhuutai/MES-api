'use strict';

// GHI NHẬN FILE PHẦN IN XUỐNG PHÒNG KỸ THUẬT (17/11/2026, mig 136) — luật ở `filekt.repository.js`.
const repo = require('./filekt.repository');
const AppError = require('../../utils/AppError');
const { buildMeta } = require('../../utils/pagination');
const sockets = require('../../sockets');

const SU_KIEN = 'filekt:updated';
const laUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
const ngayHopLe = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : '');

async function canBang() {
  if (!(await repo.coBang())) {
    throw new AppError('Chưa chạy migration 136 (ghi nhận file xuống KT)', { status: 409, errorCode: 'CHUA_MIGRATION_136' });
  }
}

// Mã từ máy quét / camera / gõ tay: bỏ khoảng trắng hai đầu; code phần viết HOA (QR code phần có thể thường).
function chuanMa(v) {
  const ma = String(v == null ? '' : v).trim().replace(/\s+/g, '');
  if (!ma) throw new AppError('Chưa có mã quét', { status: 422, errorCode: 'NO_MA' });
  if (ma.length > 100) throw new AppError('Mã quét quá dài (tối đa 100 ký tự)', { status: 422, errorCode: 'MA_QUA_DAI' });
  const loai = repo.loaiMa(ma);
  return { ma: loai === 'CODE_PHAN' ? ma.toUpperCase() : ma, loai };
}

async function quet({ ma, ghiChu } = {}, actorId) {
  await canBang();
  const c = chuanMa(ma);
  const gc = String(ghiChu || '').replace(/\s+/g, ' ').trim();
  if (gc.length > 500) throw new AppError('Ghi chú tối đa 500 ký tự', { status: 422, errorCode: 'GHI_CHU_QUA_DAI' });
  const kq = await repo.ghiQuet({ ma: c.ma, loai: c.loai, ghiChu: gc || null, actorId });
  sockets.emit(SU_KIEN, { action: 'quet', id: kq.id });
  return kq;
}

async function huy(id, lyDo, actorId) {
  await canBang();
  if (!laUuid(id)) throw new AppError('Lượt quét không hợp lệ', { status: 422, errorCode: 'ID_SAI' });
  const ly = String(lyDo || '').trim();
  if (!ly) throw new AppError('Nhập lý do hủy lượt quét', { status: 422, errorCode: 'NO_LY_DO' });
  const cu = await repo.layQuet(id);
  if (!cu) throw new AppError('Không tìm thấy lượt quét', { status: 404, errorCode: 'NOT_FOUND' });
  if (cu.trang_thai === 'HUY') throw new AppError('Lượt quét đã hủy', { status: 409, errorCode: 'DA_HUY' });
  const kq = await repo.huyQuet(id, ly, actorId);
  if (!kq) throw new AppError('Lượt quét vừa bị hủy bởi người khác', { status: 409, errorCode: 'DA_HUY' });
  sockets.emit(SU_KIEN, { action: 'huy', id });
  return kq;
}

// Nút "Ghép lại" + hook sau đồng bộ ERP (gọi `repo.ghepTuDong` thẳng — không ném lỗi chưa migration).
async function ghepLai(actorId) {
  await canBang();
  const kq = await repo.ghepTuDong(actorId);
  if (kq.so_cap_moi) sockets.emit(SU_KIEN, { action: 'ghep' });
  return kq;
}

async function dsQuet(q) {
  if (!(await repo.coBang())) return { items: [], meta: buildMeta(q.page, q.limit, 0), dem: {}, chua_migration: true };
  const { rows, total, dem } = await repo.dsQuet({
    tuNgay: ngayHopLe(q.tuNgay), denNgay: ngayHopLe(q.denNgay), search: String(q.search || '').slice(0, 100),
    trangThai: String(q.trangThai || ''), offset: q.offset, limit: q.limit,
  });
  return { items: rows, meta: buildMeta(q.page, q.limit, total), dem };
}

async function dsPhanIn(q) {
  if (!(await repo.coBang())) return { items: [], meta: buildMeta(q.page, q.limit, 0), chua_migration: true };
  const { rows, total } = await repo.dsPhanIn({
    tuNgay: ngayHopLe(q.tuNgay), denNgay: ngayHopLe(q.denNgay), search: String(q.search || '').slice(0, 100),
    offset: q.offset, limit: q.limit,
  });
  return { items: rows, meta: buildMeta(q.page, q.limit, total) };
}

module.exports = { quet, huy, ghepLai, dsQuet, dsPhanIn, SU_KIEN };
