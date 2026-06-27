'use strict';

const { body } = require('express-validator');

const loginRules = [
  body('tenDangNhap').trim().notEmpty().withMessage('Tên đăng nhập bắt buộc'),
  body('matKhau').notEmpty().withMessage('Mật khẩu bắt buộc'),
];

module.exports = { loginRules };
