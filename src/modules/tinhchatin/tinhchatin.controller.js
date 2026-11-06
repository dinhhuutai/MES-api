'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const service = require('./tinhchatin.service');

const list = asyncHandler(async (req, res) => ok(res, await service.danhSach()));
const save = asyncHandler(async (req, res) => ok(res, await service.luu(req.body?.items, req.user.id), 'Đã lưu danh mục tính chất in'));
const add = asyncHandler(async (req, res) => ok(res, await service.them(req.body, req.user.id), 'Đã thêm tính chất in'));
const remove = asyncHandler(async (req, res) => ok(res, await service.xoa(req.params.id, req.user.id), 'Đã xóa tính chất in'));

module.exports = { list, save, add, remove };
