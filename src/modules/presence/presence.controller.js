'use strict';

const service = require('./presence.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');

const online = asyncHandler(async (req, res) => ok(res, service.getOnline()));

const history = asyncHandler(async (req, res) =>
  ok(res, await service.history({
    date: req.query.date || null,
    userId: req.query.userId || null,
    limit: parseInt(req.query.limit || '500', 10),
  })));

module.exports = { online, history };
