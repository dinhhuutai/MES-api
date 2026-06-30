'use strict';

const express = require('express');
const c = require('./gomset.controller');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

const router = express.Router();
router.use(auth);

// Route tĩnh trước route động /:id
router.get('/candidates', rbac('READY_GOMSET'), c.candidates);
router.get('/history', rbac('READY_GOMSET'), c.history);
router.get('/', rbac('READY_GOMSET'), c.list);
router.post('/', rbac('READY_GOMSET'), c.create);
router.get('/:id', rbac('READY_GOMSET'), c.detail);
router.post('/:id/them', rbac('READY_GOMSET'), c.addItems);
router.delete('/:id/dot-vai/:dotVaiId', rbac('READY_GOMSET'), c.removeItem);
router.post('/:id/huy', rbac('READY_GOMSET'), c.cancel);

module.exports = router;
