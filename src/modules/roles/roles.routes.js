'use strict';

const express = require('express');
const { body } = require('express-validator');
const c = require('./roles.controller');
const validate = require('../../middlewares/validate');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

const router = express.Router();
router.use(auth);

const createRules = [
  body('maRole').trim().notEmpty().withMessage('Mã vai trò bắt buộc'),
  body('tenRole').trim().notEmpty().withMessage('Tên vai trò bắt buộc'),
];

router.get('/', rbac('ROLE_VIEW'), c.list);
router.get('/:id', rbac('ROLE_VIEW'), c.getOne);
router.post('/', rbac('ROLE_MANAGE'), createRules, validate, c.create);
router.patch('/:id', rbac('ROLE_MANAGE'), c.update);
router.patch('/:id/active', rbac('ROLE_MANAGE'), c.setActive);
router.patch('/:id/permissions', rbac('ROLE_MANAGE'), c.setPermissions);

module.exports = router;
