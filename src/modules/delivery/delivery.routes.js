'use strict';

const express = require('express');
const c = require('./delivery.controller');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

const router = express.Router();
router.use(auth);

router.get('/tem-san-sang', rbac('DELIVERY_VIEW', 'DELIVERY_MANAGE'), c.temSanSang);
router.get('/', rbac('DELIVERY_VIEW', 'DELIVERY_MANAGE'), c.list);
router.get('/:id', rbac('DELIVERY_VIEW', 'DELIVERY_MANAGE'), c.detail);
router.post('/', rbac('DELIVERY_MANAGE'), c.create);
router.post('/:id/confirm', rbac('DELIVERY_MANAGE'), c.confirm);

module.exports = router;
