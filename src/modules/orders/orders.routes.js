'use strict';

const express = require('express');
const { body } = require('express-validator');
const c = require('./orders.controller');
const validate = require('../../middlewares/validate');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

const router = express.Router();
router.use(auth);

router.get('/', rbac('ORDER_VIEW'), c.list);
router.get('/profit-history', rbac('PROFIT_MANAGE'), c.profitHistory);
router.get('/:id', rbac('ORDER_VIEW'), c.getOne);
router.patch(
  '/:id/loi-nhuan',
  rbac('PROFIT_MANAGE'),
  [body('loiNhuan').isFloat({ min: 0 }).withMessage('Lợi nhuận phải là số ≥ 0')],
  validate,
  c.setLoiNhuan
);

module.exports = router;
