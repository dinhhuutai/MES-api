'use strict';

const { body } = require('express-validator');

const createRules = [
  body('tenDangNhap').trim().notEmpty().withMessage('Tên đăng nhập bắt buộc')
    .isLength({ min: 3 }).withMessage('Tên đăng nhập tối thiểu 3 ký tự'),
  body('matKhau').isLength({ min: 6 }).withMessage('Mật khẩu tối thiểu 6 ký tự'),
  body('hoTen').trim().notEmpty().withMessage('Họ tên bắt buộc'),
  body('email').optional({ values: 'falsy' }).isEmail().withMessage('Email không hợp lệ'),
  body('gioiTinh').optional({ values: 'falsy' }).isIn(['NAM', 'NU']).withMessage('Giới tính không hợp lệ'),
  body('roleIds').optional().isArray().withMessage('roleIds phải là mảng'),
];

const updateRules = [
  body('hoTen').optional().trim().notEmpty().withMessage('Họ tên không được rỗng'),
  body('email').optional({ values: 'falsy' }).isEmail().withMessage('Email không hợp lệ'),
  body('gioiTinh').optional({ values: 'falsy' }).isIn(['NAM', 'NU']).withMessage('Giới tính không hợp lệ'),
  body('roleIds').optional().isArray().withMessage('roleIds phải là mảng'),
];

const resetPasswordRules = [
  body('matKhauMoi').isLength({ min: 6 }).withMessage('Mật khẩu mới tối thiểu 6 ký tự'),
];

module.exports = { createRules, updateRules, resetPasswordRules };
