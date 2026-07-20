'use strict';

const repo = require('./manualentry.repository');
const AppError = require('../../utils/AppError');
const { withTransaction } = require('../../config/db');
const sockets = require('../../sockets');

const searchKhach = (q) => repo.searchKhach(q || '');
const searchDon = (khachId, q) => repo.searchDon(khachId || null, q || '');
const searchMaHang = (donId, q) => repo.searchMaHang(donId || null, q || '');
const searchPhanIn = (maHangId, q) => repo.searchPhanIn(maHangId || null, q || '');
const listLoaiDotVai = () => repo.listLoaiDotVai();

// Tạo chuỗi khách → đơn → mã hàng → phần in → đợt vải.
// Mỗi cấp: truyền `id` để DÙNG có sẵn, hoặc bỏ id + nhập thông tin để TẠO MỚI.
async function createChain(payload, actorId) {
  const p = payload || {};
  const dotVai = Array.isArray(p.dotVai) ? p.dotVai : [];

  // Validate tối thiểu.
  if (!p.phanIn?.id) {
    if (!p.khach?.id && !(p.khach?.ten_khach_hang || '').trim()) {
      throw new AppError('Chọn khách hàng có sẵn hoặc nhập tên khách hàng mới', { status: 422, errorCode: 'VALIDATION_ERROR' });
    }
  }
  if (dotVai.length === 0) {
    throw new AppError('Cần thêm ít nhất 1 đợt vải', { status: 422, errorCode: 'VALIDATION_ERROR' });
  }
  for (const [i, d] of dotVai.entries()) {
    const sl = Number(d.so_luong_vai_ve);
    if (!Number.isFinite(sl) || sl < 0) {
      throw new AppError(`Đợt vải #${i + 1}: SL vải về phải là số ≥ 0`, { status: 422, errorCode: 'VALIDATION_ERROR' });
    }
  }

  const result = await withTransaction((client) => repo.createChainTx(client, p, actorId));
  sockets.emit('dashboard:refresh', {});
  return result;
}

// ─── Cập nhật SL nhận vải / SL release ───────────────────────────────────────
const searchVaiVe = (q) => repo.searchVaiVe(q || '');

const toInt = (v, label) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    throw new AppError(`${label} phải là số nguyên ≥ 0`, { status: 422, errorCode: 'VALIDATION_ERROR' });
  }
  return n;
};

async function updateVaiVe(id, soLuong, actorId) {
  if (!id) throw new AppError('Thiếu đợt vải', { status: 422, errorCode: 'VALIDATION_ERROR' });
  const val = toInt(soLuong, 'SL nhận vải');
  await withTransaction((client) => repo.updateVaiVeTx(client, id, val, actorId));
  sockets.emit('dashboard:refresh', {});
  return { id, so_luong_vai_ve: val };
}

async function updateRelease(lenhId, dotId, soLuong, actorId) {
  if (!lenhId || !dotId) throw new AppError('Thiếu lệnh hoặc đợt vải', { status: 422, errorCode: 'VALIDATION_ERROR' });
  const val = toInt(soLuong, 'SL release');
  await withTransaction((client) => repo.updateReleaseTx(client, lenhId, dotId, val, actorId));
  sockets.emit('dashboard:refresh', {});
  sockets.emit('production:updated', {});
  return { lenh_san_xuat_id: lenhId, dot_vai_ve_id: dotId, so_luong: val };
}

module.exports = {
  searchKhach, searchDon, searchMaHang, searchPhanIn, listLoaiDotVai, createChain,
  searchVaiVe, updateVaiVe, updateRelease,
};
