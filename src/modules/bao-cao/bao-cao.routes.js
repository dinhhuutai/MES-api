'use strict';

const express = require('express');
const c = require('./bao-cao.controller');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

const router = express.Router();
router.use(auth);

// Literal routes TRƯỚC /:id để không bị bắt nhầm.
router.get('/metrics', rbac('BAOCAO_VIEW'), c.listMetrics);
router.get('/tat-ca', rbac('BAOCAO_ASSIGN', 'BAOCAO_APPROVE'), c.listAll);

// Phòng ban
router.get('/phong-ban', rbac('BAOCAO_VIEW'), c.listPhongBan);
router.get('/phong-ban/:phongBanId/hien-hanh', rbac('BAOCAO_VIEW'), c.hienHanh);
router.post('/phong-ban/:phongBanId/de-xuat', rbac('BAOCAO_ASSIGN'), c.deXuat);
router.post('/phong-ban-ap-dung/:id/duyet', rbac('BAOCAO_APPROVE'), c.duyet);
router.post('/phong-ban-ap-dung/:id/tu-choi', rbac('BAOCAO_APPROVE'), c.tuChoi);
router.post('/phong-ban/:phongBanId/huy-ap-dung', rbac('BAOCAO_APPROVE'), c.huyApDung);

// Báo cáo
router.get('/', rbac('BAOCAO_VIEW'), c.list);
router.post('/', rbac('BAOCAO_DESIGN'), c.create);
router.get('/:id', rbac('BAOCAO_VIEW'), c.getOne);
router.put('/:id', rbac('BAOCAO_DESIGN'), c.update);
router.delete('/:id', rbac('BAOCAO_DESIGN'), c.remove);
router.post('/:id/hoan-tac', rbac('BAOCAO_DESIGN'), c.undo);
router.post('/:id/render', rbac('BAOCAO_VIEW'), c.render);
router.get('/:id/lich-su', rbac('BAOCAO_VIEW'), c.history);

module.exports = router;
