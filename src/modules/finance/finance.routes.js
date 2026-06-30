'use strict';

const express = require('express');
const { body } = require('express-validator');
const c = require('./finance.controller');
const validate = require('../../middlewares/validate');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

const router = express.Router();
router.use(auth);

router.get('/don-hang', rbac('FINANCE_VIEW'), c.list);
router.get('/history', rbac('FINANCE_VIEW'), c.history);
router.get('/don-hang/:id', rbac('FINANCE_VIEW'), c.getOne);
router.post(
  '/don-hang/:id/cong-no',
  rbac('FINANCE_MANAGE'),
  [
    body('tongTien').optional({ nullable: true }).isFloat({ min: 0 }).withMessage('Tổng công nợ phải ≥ 0'),
    body('daThu').optional({ nullable: true }).isFloat({ min: 0 }).withMessage('Đã thu phải ≥ 0'),
  ],
  validate,
  c.save
);
router.post('/don-hang/:id/xac-nhan', rbac('FINANCE_MANAGE'), c.confirm);

module.exports = router;
