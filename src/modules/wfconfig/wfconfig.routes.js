'use strict';

const express = require('express');
const c = require('./wfconfig.controller');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

const router = express.Router();
router.use(auth);

const WV = rbac('WORKFLOW_VIEW', 'WORKFLOW_MANAGE');
const WM = rbac('WORKFLOW_MANAGE');
const SV = rbac('STATUS_VIEW', 'STATUS_MANAGE');
const SM = rbac('STATUS_MANAGE');

// Workflow version
router.get('/versions', WV, c.listVersions);
router.post('/versions', WM, c.createVersion);
router.patch('/versions/:id', WM, c.updateVersion);
router.post('/versions/:id/hien-hanh', WM, c.setHienHanh);

// Tram
router.get('/trams', WV, c.listTrams);
router.get('/tram-options', WV, c.tramOptions);
router.post('/trams', WM, c.createTram);
router.patch('/trams/:id', WM, c.updateTram);
router.patch('/trams/:id/active', WM, c.setTramActive);

// Checkpoint
router.get('/checkpoints', WV, c.listCheckpoints);
router.post('/checkpoints', WM, c.createCheckpoint);
router.patch('/checkpoints/:id', WM, c.updateCheckpoint);
router.patch('/checkpoints/:id/active', WM, c.setCheckpointActive);

// Rules
router.get('/rules', WV, c.listRules);
router.post('/rules', WM, c.createRule);
router.patch('/rules/:id', WM, c.updateRule);
router.patch('/rules/:id/active', WM, c.setRuleActive);

// Conditions
router.get('/conditions', WV, c.listConditions);
router.post('/conditions', WM, c.createCondition);
router.delete('/conditions/:id', WM, c.deleteCondition);

// Owners
router.get('/tram-owners', WV, c.listTramOwners);
router.post('/tram-owners', WM, c.addTramOwner);
router.delete('/tram-owners/:id', WM, c.removeTramOwner);
router.get('/checkpoint-owners', WV, c.listCheckpointOwners);
router.post('/checkpoint-owners', WM, c.addCheckpointOwner);
router.delete('/checkpoint-owners/:id', WM, c.removeCheckpointOwner);

// Status
router.get('/statuses', SV, c.listStatuses);
router.post('/statuses', SM, c.createStatus);
router.patch('/statuses/:id', SM, c.updateStatus);
router.patch('/statuses/:id/active', SM, c.setStatusActive);

module.exports = router;
