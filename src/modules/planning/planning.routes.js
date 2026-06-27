'use strict';

const express = require('express');
const c = require('./planning.controller');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

const router = express.Router();
router.use(auth);

const TEST_VIEW = ['TESTRUN_CNSP', 'TESTRUN_QA', 'RELEASE1', 'RELEASE2'];

// Release 1 (Kế hoạch)
router.get('/release1/candidates', rbac('RELEASE1'), c.release1Candidates);
router.post('/release1', rbac('RELEASE1'), c.createRelease1);

// Test Run (CNSP + QA)
router.get('/test-run/candidates', rbac(...TEST_VIEW), c.testRunCandidates);
router.get('/lenh/:lenhId', rbac(...TEST_VIEW), c.lenhDetail);
router.post('/test-run/:lenhId/run', rbac('TESTRUN_CNSP', 'TESTRUN_QA'), c.recordTestRun);
router.post('/test-run/:lenhId/confirm-cnsp', rbac('TESTRUN_CNSP'), c.confirmCNSP);
router.post('/test-run/:lenhId/confirm-qa', rbac('TESTRUN_QA'), c.confirmQA);

// Release 2 (Kế hoạch duyệt cuối)
router.get('/release2/candidates', rbac('RELEASE2'), c.release2Candidates);
router.post('/release2/:lenhId', rbac('RELEASE2'), c.approveRelease2);

module.exports = router;
