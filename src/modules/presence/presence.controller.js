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

const activity = asyncHandler(async (req, res) =>
  ok(res, await service.activity({
    date: req.query.date || null,
    userId: req.query.userId || null,
    loai: req.query.loai || null,
    search: (req.query.search || '').trim() || null,
    page: parseInt(req.query.page || '1', 10),
    limit: parseInt(req.query.limit || '50', 10),
  })));

module.exports = { online, history, activity };
