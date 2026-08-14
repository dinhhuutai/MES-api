'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const service = require('./caidatapi.service');

const list = asyncHandler(async (req, res) => ok(res, { items: await service.danhSach() }));

const save = asyncHandler(async (req, res) =>
  ok(res, { items: await service.luu(req.body?.items, req.user.id) }, 'Đã lưu cài đặt API'));

const thu = asyncHandler(async (req, res) => ok(res, await service.thuKetNoi(req.params.ma)));

module.exports = { list, save, thu };
