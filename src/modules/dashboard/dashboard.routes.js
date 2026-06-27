'use strict';

const express = require('express');
const repo = require('./dashboard.repository');
const reportService = require('../reports/reports.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const auth = require('../../middlewares/auth');

const router = express.Router();
router.use(auth);

router.get('/summary', asyncHandler(async (req, res) => ok(res, await repo.summary())));
router.get('/activity', asyncHandler(async (req, res) => ok(res, await repo.activity())));

// Báo cáo (gắn dưới /dashboard cho gọn; module BAO_CAO)
router.get('/reports', asyncHandler(async (req, res) => ok(res, reportService.listReports())));
router.get('/reports/:ma', asyncHandler(async (req, res) => ok(res, await reportService.getReport(req.params.ma))));

module.exports = router;
