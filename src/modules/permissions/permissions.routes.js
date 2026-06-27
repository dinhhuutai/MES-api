'use strict';

const express = require('express');
const { body } = require('express-validator');
const c = require('./permissions.controller');
const validate = require('../../middlewares/validate');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

const router = express.Router();
router.use(auth);

const createRules = [
  body('maPermission').trim().notEmpty().withMessage('Mã permission bắt buộc'),
  body('tenPermission').trim().notEmpty().withMessage('Tên permission bắt buộc'),
];

router.get('/', rbac('PERM_VIEW', 'ROLE_VIEW'), c.list); // role editor cũng cần xem danh sách quyền
router.post('/', rbac('PERM_MANAGE'), createRules, validate, c.create);
router.patch('/:id', rbac('PERM_MANAGE'), c.update);
router.patch('/:id/active', rbac('PERM_MANAGE'), c.setActive);

module.exports = router;
