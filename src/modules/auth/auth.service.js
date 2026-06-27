'use strict';

const bcrypt = require('bcryptjs');
const repo = require('./auth.repository');
const { sign } = require('../../utils/jwt');
const AppError = require('../../utils/AppError');

function toPublicUser(row, roles, permissions) {
  return {
    id: row.id,
    maUser: row.ma_user,
    tenDangNhap: row.ten_dang_nhap,
    hoTen: row.ho_ten,
    email: row.email,
    chucVu: row.chuc_vu,
    phongBan: row.ten_phong_ban || null,
    roles,
    permissions,
  };
}

async function login(username, password) {
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

  const token = sign({ sub: row.id, username: row.ten_dang_nhap, roles, permissions });
  return { token, user: toPublicUser(row, roles, permissions) };
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

module.exports = { login, me };
