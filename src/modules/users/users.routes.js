'use strict';

const express = require('express');
const c = require('./users.controller');
const v = require('./users.validation');
const validate = require('../../middlewares/validate');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

const router = express.Router();
router.use(auth);

router.get('/', rbac('USER_VIEW'), c.list);
router.get('/:id', rbac('USER_VIEW'), c.getOne);
router.post('/', rbac('USER_MANAGE'), v.createRules, validate, c.create);
router.patch('/:id', rbac('USER_MANAGE'), v.updateRules, validate, c.update);
router.patch('/:id/active', rbac('USER_MANAGE'), c.setActive);
router.patch('/:id/roles', rbac('USER_MANAGE'), c.setRoles);
router.post('/:id/reset-password', rbac('USER_MANAGE'), v.resetPasswordRules, validate, c.resetPassword);

module.exports = router;
