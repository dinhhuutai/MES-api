'use strict';

const express = require('express');
const c = require('./quality.controller');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

const router = express.Router();
router.use(auth);

router.get('/kcs/candidates', rbac('KCS'), c.kcsCandidates);
router.post('/kcs/:temId', rbac('KCS'), c.recordKcs);

router.get('/sua/candidates', rbac('SUA'), c.suaCandidates);
router.post('/sua/:temId', rbac('SUA'), c.recordSua);

router.get('/oqc/candidates', rbac('OQC'), c.oqcCandidates);
router.post('/oqc/:temId', rbac('OQC'), c.recordOqc);

module.exports = router;
