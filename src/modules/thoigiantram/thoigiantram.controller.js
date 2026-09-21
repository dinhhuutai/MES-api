'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const service = require('./thoigiantram.service');

const duLieu = asyncHandler(async (req, res) => ok(res, await service.duLieu(req.query)));

// Checklist của 1 trạm (tải lười khi người dùng bấm mũi tên sổ xuống).
const checklist = asyncHandler(async (req, res) =>
  ok(res, await service.duLieuChecklist(req.params.maTram, req.query)));

module.exports = { duLieu, checklist };
