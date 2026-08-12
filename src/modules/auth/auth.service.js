'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const repo = require('./auth.repository');
const { sign } = require('../../utils/jwt');
const AppError = require('../../utils/AppError');
const { saveAvatarFile, removeAvatarFiles } = require('../../utils/avatarStorage');
const phienRepo = require('../phien/phien.repository');
const { tenThietBi } = require('../../utils/thietBi');

function toPublicUser(row, roles, permissions) {
  return {
    id: row.id,
    maUser: row.ma_user,
    tenDangNhap: row.ten_dang_nhap,
    hoTen: row.ho_ten,
    email: row.email,
    soDienThoai: row.so_dien_thoai || null,
    chucVu: row.chuc_vu,
    gioiTinh: row.gioi_tinh || null,
    avatarUrl: row.avatar_url || null,
    phongBan: row.ten_phong_ban || null,
    roles,
    permissions,
  };
}

// `ctx` = { userAgent, ip } của request đăng nhập → ghi PHIÊN theo thiết bị (mig 081).
async function login(username, password, ctx = {}) {
  const row = await repo.findByUsername(username);
  if (!row) {
    throw new AppError('Sai tài khoản hoặc mật khẩu', { status: 401, errorCode: 'INVALID_CREDENTIALS' });
  }
  if (!row.dang_hoat_dong) {
    throw new AppError('Tài khoản đã bị khóa', { status: 403, errorCode: 'ACCOUNT_DISABLED' });
  }
  const matched = await bcrypt.compare(password, row.mat_khau_hash || '');
  if (!matched) {
    throw new AppError('Sai tài khoản hoặc mật khẩu', { status: 401, errorCode: 'INVALID_CREDENTIALS' });
  }

  const [roles, permissions] = await Promise.all([
    repo.getRoles(row.id),
    repo.getPermissions(row.id),
  ]);

  await repo.updateLastLogin(row.id);

  // `jti` = MÃ PHIÊN nhúng vào JWT ⇒ đăng xuất từ xa chặn được đúng token của thiết bị đó (mig 081).
  // ⚠ Ghi phiên là BEST-EFFORT: chưa chạy mig 081 / lỗi ghi ⇒ `taoPhien` trả false và ĐĂNG NHẬP VẪN
  //   THÀNH CÔNG. Không được để việc quản lý thiết bị chặn đường vào của cả nhà máy.
  const jti = crypto.randomUUID();
  await phienRepo.taoPhien({
    userId: row.id,
    jti,
    thietBi: tenThietBi(ctx.userAgent),
    userAgent: ctx.userAgent || null,
    ip: ctx.ip || null,
  });

  const token = sign({ sub: row.id, username: row.ten_dang_nhap, roles, permissions, jti });
  return { token, user: toPublicUser(row, roles, permissions) };
}

// Đăng xuất do CHÍNH người dùng bấm → đóng phiên của token đang dùng (nếu có `jti`).
// Token cũ không có `jti` thì chỉ xóa token phía client như trước — không có gì để đóng.
async function logout(jti) {
  if (jti) await phienRepo.dongPhienTheoJti(jti, 'DA_DANG_XUAT');
  return { ok: true };
}

async function me(userId) {
  const row = await repo.findById(userId);
  if (!row) {
    throw new AppError('Người dùng không tồn tại', { status: 404, errorCode: 'USER_NOT_FOUND' });
  }
  const [roles, permissions] = await Promise.all([
    repo.getRoles(userId),
    repo.getPermissions(userId),
  ]);
  return toPublicUser(row, roles, permissions);
}

async function updateProfile(userId, body) {
  await repo.updateProfile(userId, body);
  return me(userId);
}

async function uploadAvatar(userId, file) {
  if (!file) throw new AppError('Chưa chọn ảnh', { status: 400, errorCode: 'NO_FILE' });
  const { url } = await saveAvatarFile(userId, file);
  await repo.setAvatar(userId, url);
  return me(userId);
}

// Đặt lại avatar mặc định: xóa file + set avatar_url = NULL.
async function resetAvatar(userId) {
  await removeAvatarFiles(userId);
  await repo.setAvatar(userId, null);
  return me(userId);
}

// Người dùng tự đổi mật khẩu (cần mật khẩu hiện tại).
async function changePassword(userId, matKhauCu, matKhauMoi) {
  if (!matKhauMoi || String(matKhauMoi).length < 6) {
    throw new AppError('Mật khẩu mới tối thiểu 6 ký tự', { status: 422, errorCode: 'WEAK_PASSWORD' });
  }
  const hash = await repo.getHash(userId);
  const matched = await bcrypt.compare(matKhauCu || '', hash || '');
  if (!matched) {
    throw new AppError('Mật khẩu hiện tại không đúng', { status: 400, errorCode: 'WRONG_PASSWORD' });
  }
  const newHash = await bcrypt.hash(String(matKhauMoi), 10);
  await repo.setPassword(userId, newHash);
  return { ok: true };
}

module.exports = { login, logout, me, updateProfile, uploadAvatar, resetAvatar, changePassword };
