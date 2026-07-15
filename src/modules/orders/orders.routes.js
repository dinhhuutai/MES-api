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
router.get('/vai-ve', rbac('ORDER_VIEW'), c.listVaiVe);
router.get('/profit-history', rbac('PROFIT_MANAGE'), c.profitHistory);
// Hủy phần in (xóa mềm) — quyền READY_CANCEL (admin). Đặt TRƯỚC /:id để không bị nuốt.
router.get('/huy/search', rbac('READY_CANCEL'), c.searchCancel);
router.post('/huy', rbac('READY_CANCEL'), c.huyPhanIn);
// Mở phần in (khôi phục xóa mềm).
router.get('/mo/deleted', rbac('READY_CANCEL'), c.listDeleted);
router.post('/mo', rbac('READY_CANCEL'), c.moPhanIn);
router.get('/:id', rbac('ORDER_VIEW'), c.getOne);
router.patch(
  '/:id/loi-nhuan',
  rbac('PROFIT_MANAGE'),
  [body('loiNhuan').isFloat({ min: 0 }).withMessage('Lợi nhuận phải là số ≥ 0')],
  validate,
  c.setLoiNhuan
);
router.patch('/:id/cho-kho', rbac('ORDER_VIEW'), c.setChoKho);

module.exports = router;
