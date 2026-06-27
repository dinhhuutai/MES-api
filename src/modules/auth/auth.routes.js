'use strict';

const express = require('express');
const controller = require('./auth.controller');
const { loginRules } = require('./auth.validation');
const validate = require('../../middlewares/validate');
const auth = require('../../middlewares/auth');

const router = express.Router();

router.post('/login', loginRules, validate, controller.login);
router.get('/me', auth, controller.me);
router.post('/logout', auth, controller.logout);

module.exports = router;
