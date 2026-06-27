'use strict';

const express = require('express');
const c = require('./technical.controller');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

const router = express.Router();
router.use(auth);

router.get('/config', rbac('READY_VIEW'), c.config);
router.get('/candidates', rbac('READY_VIEW'), c.candidates);
router.get('/:phanInId', rbac('READY_VIEW'), c.detail);
router.post('/:phanInId/draft', rbac('READY_TECH'), c.saveDraft);
router.post('/:phanInId/confirm-tech', rbac('READY_TECH'), c.confirmTech);
router.post('/:phanInId/confirm-qc', rbac('READY_QC'), c.confirmQC);

module.exports = router;
