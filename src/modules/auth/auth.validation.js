'use strict';

const { body } = require('express-validator');

const loginRules = [
  body('tenDangNhap').trim().notEmpty().withMessage('Tên đăng nhập bắt buộc'),
  body('matKhau').notEmpty().withMessage('Mật khẩu bắt buộc'),
];

// Người dùng tự cập nhật hồ sơ cá nhân (không đụng tài khoản/vai trò/avatar).
const profileRules = [
  body('hoTen').optional().trim().notEmpty().withMessage('Họ tên không được rỗng'),
  body('email').optional({ values: 'falsy' }).isEmail().withMessage('Email không hợp lệ'),
  body('gioiTinh').optional({ values: 'falsy' }).isIn(['NAM', 'NU']).withMessage('Giới tính không hợp lệ'),
];

module.exports = { loginRules, profileRules };
