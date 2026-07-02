'use strict';

const repo = require('./roles.repository');
const AppError = require('../../utils/AppError');

async function listRoles(search) {
  return repo.list({ search });
}

async function getRole(id) {
  const role = await repo.findById(id);
  if (!role) throw new AppError('Vai trò không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  return role;
}

async function createRole(body, actorId) {
  if (await repo.existsCode(body.maRole)) {
    throw new AppError('Mã vai trò đã tồn tại', { status: 409, errorCode: 'DUPLICATE' });
  }
  const id = await repo.create(body, actorId);
  if (Array.isArray(body.permissionIds)) await repo.setPermissions(id, body.permissionIds, actorId);
  return getRole(id);
}

async function updateRole(id, body, actorId) {
  await getRole(id);
  await repo.update(id, body, actorId);
  if (Array.isArray(body.permissionIds)) await repo.setPermissions(id, body.permissionIds, actorId);
  return getRole(id);
}

async function getRoleUsers(id) {
  await getRole(id);
  return repo.listUsers(id);
}

async function setActive(id, active, actorId) {
  await getRole(id);
  await repo.setActive(id, active, actorId);
  return getRole(id);
}

async function setPermissions(id, permissionIds, actorId) {
  await getRole(id);
  await repo.setPermissions(id, permissionIds, actorId);
  return getRole(id);
}

module.exports = { listRoles, getRole, getRoleUsers, createRole, updateRole, setActive, setPermissions };
