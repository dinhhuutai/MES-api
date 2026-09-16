'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const service = require('./thoigiantram.service');

const duLieu = asyncHandler(async (req, res) => ok(res, await service.duLieu(req.query)));

module.exports = { duLieu };
