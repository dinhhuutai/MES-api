'use strict';

const service = require('./roles.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok, created } = require('../../utils/response');

const list = asyncHandler(async (req, res) => ok(res, await service.listRoles(req.query.search || '')));
const getOne = asyncHandler(async (req, res) => ok(res, await service.getRole(req.params.id)));
const getUsers = asyncHandler(async (req, res) => ok(res, await service.getRoleUsers(req.params.id)));
const create = asyncHandler(async (req, res) => created(res, await service.createRole(req.body, req.user.id)));
const update = asyncHandler(async (req, res) =>
  ok(res, await service.updateRole(req.params.id, req.body, req.user.id), 'Đã cập nhật'));
const setActive = asyncHandler(async (req, res) =>
  ok(res, await service.setActive(req.params.id, req.body.dangHoatDong === true, req.user.id), 'Đã cập nhật trạng thái'));
const setPermissions = asyncHandler(async (req, res) =>
  ok(res, await service.setPermissions(req.params.id, req.body.permissionIds || [], req.user.id), 'Đã cập nhật quyền'));

module.exports = { list, getOne, getUsers, create, update, setActive, setPermissions };
