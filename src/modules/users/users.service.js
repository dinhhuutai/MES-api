'use strict';

const bcrypt = require('bcryptjs');
const repo = require('./users.repository');
const AppError = require('../../utils/AppError');
const { buildMeta } = require('../../utils/pagination');

async function listUsers({ search, active, page, limit, offset }) {
  const { rows, total } = await repo.list({ search, active, offset, limit });
  return { items: rows, meta: buildMeta(page, limit, total) };
}

async function getUser(id) {
  const user = await repo.findById(id);
  if (!user) throw new AppError('Người dùng không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  return user;
}

async function createUser(body, actorId) {
  if (await repo.existsUsername(body.tenDangNhap)) {
    throw new AppError('Tên đăng nhập đã tồn tại', { status: 409, errorCode: 'DUPLICATE' });
  }
  const matKhauHash = await bcrypt.hash(body.matKhau, 10);
  const maUser = body.maUser || (await repo.nextMaUser());
  const id = await repo.create({ ...body, maUser, matKhauHash }, actorId);
  if (Array.isArray(body.roleIds)) await repo.setRoles(id, body.roleIds, actorId);
  return getUser(id);
}

async function updateUser(id, body, actorId) {
  await getUser(id);
  await repo.update(id, body, actorId);
  if (Array.isArray(body.roleIds)) await repo.setRoles(id, body.roleIds, actorId);
  return getUser(id);
}

async function setActive(id, active, actorId) {
  await getUser(id);
  await repo.setActive(id, active, actorId);
  return getUser(id);
}

async function resetPassword(id, matKhauMoi, actorId) {
  await getUser(id);
  const hash = await bcrypt.hash(matKhauMoi, 10);
  await repo.setPassword(id, hash, actorId);
}

async function setRoles(id, roleIds, actorId) {
  await getUser(id);
  await repo.setRoles(id, roleIds, actorId);
  return getUser(id);
}

module.exports = { listUsers, getUser, createUser, updateUser, setActive, resetPassword, setRoles };
