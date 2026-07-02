'use strict';

const express = require('express');
const controller = require('./auth.controller');
const { loginRules, profileRules } = require('./auth.validation');
const validate = require('../../middlewares/validate');
const auth = require('../../middlewares/auth');
const { singleImage } = require('../../middlewares/upload');

const router = express.Router();

router.post('/login', loginRules, validate, controller.login);
router.get('/me', auth, controller.me);
router.patch('/me', auth, profileRules, validate, controller.updateProfile);
router.post('/me/avatar', auth, singleImage('avatar'), controller.uploadAvatar);
router.delete('/me/avatar', auth, controller.resetAvatar);
router.post('/me/doi-mat-khau', auth, controller.changePassword);
router.post('/logout', auth, controller.logout);

module.exports = router;
