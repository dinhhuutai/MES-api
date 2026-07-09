'use strict';

const express = require('express');
const c = require('./presence.controller');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

const router = express.Router();
router.use(auth);

router.get('/online', rbac('PRESENCE_VIEW'), c.online);
router.get('/history', rbac('PRESENCE_VIEW'), c.history);
router.get('/activity', rbac('PRESENCE_VIEW'), c.activity);

module.exports = router;
