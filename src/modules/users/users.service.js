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

// TỔ (mig 104, ô "Tổ" trên form người dùng — 09/10/2026). Trả `undefined` = không đụng cột tổ.
//   · Thiếu migration (`phongban.coBangTo`) ⇒ bỏ qua hẳn (form cũ / DB cũ vẫn lưu được).
//   · Gửi tổ ⇒ tổ phải tồn tại và THUỘC ĐÚNG phòng ban của người dùng (422 `TO_KHAC_PHONG`) — trước đây chưa có guard này.
//   · Không gửi tổ mà đổi phòng ⇒ tổ cũ không thuộc phòng mới thì gỡ (NULL), tránh người "phòng A, tổ của phòng B".
async function toCanGhi(body, phongBanId, toHienTai) {
  if (!(await require('../phongban/phongban.service').coBangTo())) return undefined;
  const coGui = Object.prototype.hasOwnProperty.call(body, 'toPhongBanId');
  const toId = coGui ? (body.toPhongBanId || null) : (toHienTai || null);
  if (!toId) return coGui ? null : undefined;
  const to = await repo.findTo(toId);
  if (!to) throw new AppError('Tổ không tồn tại', { status: 422, errorCode: 'TO_KHONG_TON_TAI' });
  if (to.phong_ban_id !== (phongBanId || null)) {
    if (coGui) throw new AppError(`Tổ "${to.ten_to}" không thuộc phòng ban đã chọn`, { status: 422, errorCode: 'TO_KHAC_PHONG' });
    return null;
  }
  return coGui ? toId : undefined;
}

async function createUser(body, actorId) {
  if (await repo.existsUsername(body.tenDangNhap)) {
    throw new AppError('Tên đăng nhập đã tồn tại', { status: 409, errorCode: 'DUPLICATE' });
  }
  const to = await toCanGhi(body, body.phongBanId || null, null); // guard TRƯỚC mọi thao tác ghi
  const matKhauHash = await bcrypt.hash(body.matKhau, 10);
  const maUser = body.maUser || (await repo.nextMaUser());
  const id = await repo.create({ ...body, maUser, matKhauHash }, actorId);
  if (to !== undefined) await repo.setTo(id, to, actorId);
  if (Array.isArray(body.roleIds)) await repo.setRoles(id, body.roleIds, actorId);
  return getUser(id);
}

async function updateUser(id, body, actorId) {
  const cu = await getUser(id);
  // ⚠ `repo.update` luôn ghi `phong_ban_id = body.phongBanId ?? null` ⇒ phòng sau khi lưu là giá trị này.
  const to = await toCanGhi(body, body.phongBanId ?? null, cu.to_phong_ban_id);
  await repo.update(id, body, actorId);
  if (to !== undefined) await repo.setTo(id, to, actorId);
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

// Chọn người (combobox) — dữ liệu rút gọn, chỉ cần đăng nhập.
const listUserOptions = ({ search, limit }) => repo.listOptions({ search, limit });

module.exports = { listUsers, listUserOptions, getUser, createUser, updateUser, setActive, resetPassword, setRoles };
