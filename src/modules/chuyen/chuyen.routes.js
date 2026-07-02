'use strict';

const express = require('express');
const repo = require('./chuyen.repository');
const asyncHandler = require('../../utils/asyncHandler');
const { ok, created } = require('../../utils/response');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

const router = express.Router();
router.use(auth);

// Quản lý chuyền in — gộp cùng nhóm cấu hình hệ thống (WORKFLOW perms).
const V = rbac('WORKFLOW_VIEW', 'WORKFLOW_MANAGE', 'PROD_MONITOR');
const M = rbac('WORKFLOW_MANAGE');
const uid = (req) => req.user.id;

router.get('/', V, asyncHandler(async (req, res) => ok(res, await repo.listChuyen({ search: req.query.search || '' }))));
router.post('/', M, asyncHandler(async (req, res) => created(res, { id: await repo.createChuyen(req.body, uid(req)) })));
router.patch('/:id', M, asyncHandler(async (req, res) => { await repo.updateChuyen(req.params.id, req.body, uid(req)); return ok(res, {}, 'Đã cập nhật'); }));
router.patch('/:id/active', M, asyncHandler(async (req, res) => { await repo.setChuyenActive(req.params.id, req.body.dangHoatDong === true, uid(req)); return ok(res, {}, 'Đã cập nhật'); }));

router.get('/loai', V, asyncHandler(async (req, res) => ok(res, await repo.listLoai())));
router.post('/loai', M, asyncHandler(async (req, res) => created(res, { id: await repo.createLoai(req.body, uid(req)) })));

module.exports = router;
