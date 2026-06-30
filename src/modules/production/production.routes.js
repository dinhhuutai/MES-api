'use strict';

const express = require('express');
const c = require('./production.controller');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

const router = express.Router();
router.use(auth);

// Xác nhận chạy + in tem
router.get('/candidates', rbac('PROD_RUN'), c.candidates);
router.get('/run/:lenhId', rbac('PROD_RUN', 'PROD_MONITOR'), c.getRun);
router.post('/:lenhId/start', rbac('PROD_RUN'), c.start);
router.post('/phieu/:phieuId/tem', rbac('PROD_RUN'), c.printTem);
router.post('/phieu/:phieuId/finish', rbac('PROD_RUN'), c.finish);
router.post('/phieu/:phieuId/ngung', rbac('PROD_RUN'), c.stopLine);
router.post('/phieu/:phieuId/hoat-dong-lai', rbac('PROD_RUN'), c.resumeLine);

// Theo dõi chuyền
router.get('/monitor', rbac('PROD_MONITOR'), c.monitor);

// Xe phơi
router.get('/xe-phoi', rbac('XEPHOI'), c.xePhoi);
router.get('/tem-cho-phoi', rbac('XEPHOI'), c.temChoPhoi);
router.post('/xe-phoi/them-tem', rbac('XEPHOI'), c.themTem);
router.patch('/tem-xe-phoi/:id', rbac('XEPHOI'), c.adjustPhoi);

// Chờ khô
router.get('/drying', rbac('DRYING'), c.drying);
router.post('/drying/:temId/confirm', rbac('DRYING'), c.confirmDry);

module.exports = router;
