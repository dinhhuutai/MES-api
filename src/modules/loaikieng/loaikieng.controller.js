'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const service = require('./loaikieng.service');

const list = asyncHandler(async (req, res) => ok(res, await service.danhSach({ ca: req.query.ca === '1' })));
const add = asyncHandler(async (req, res) => ok(res, await service.them(req.body, req.user.id), 'Đã thêm loại kiếng'));
const update = asyncHandler(async (req, res) => ok(res, await service.sua(req.params.id, req.body, req.user.id), 'Đã lưu loại kiếng'));

module.exports = { list, add, update };
