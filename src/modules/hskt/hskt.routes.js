'use strict';

const express = require('express');
const c = require('./hskt.controller');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

const router = express.Router();
router.use(auth);

// Xem: dùng chung quyền kỹ thuật READY (không thêm quyền mới → không phải đăng xuất lại).
// ⚠⚠ `READY_QC` được thêm vào CẢ HAI vì màn **QC chuẩn bị kỹ thuật** nay cũng đổi được phương án in
// ngay tại cột (giống màn READY của Kỹ thuật). Vai trò **QA chỉ có `READY_QC`** — thiếu quyền ở đây
// thì nút ⟳/✓ hiện ra nhưng bấm là 403, tính năng "có mà như không".
//  - MANAGE: PATCH /:id/phuong-an-in — đường GHI duy nhất của ô đó.
//  - VIEW:   `PhuongAnInCell` gọi `GET /hskt/:id` trước khi ghi để cảnh báo "HSKT dùng chung N phần in".
//    Thiếu VIEW thì lời gọi đó 403, bị try/catch nuốt ⇒ QC đổi cho cả gom set mà KHÔNG được hỏi lại.
// ⚠ Không mở thêm màn nào cho QA: trang "Hồ sơ kỹ thuật" gác bằng `READY_VIEW` ở FE (constants/modules.js),
//   không phải bằng 2 hằng này.
const VIEW = rbac('READY_KHUON', 'READY_FILM', 'READY_MUC', 'WORKFLOW_VIEW', 'READY_QC');
const MANAGE = rbac('READY_KHUON', 'READY_FILM', 'READY_MUC', 'READY_QC');

// Route TĨNH trước route động /:id.
router.get('/by-barcode/:barcode', VIEW, c.byBarcode);
router.get('/phan-in/:phanInId', VIEW, c.byPhanIn);
router.get('/', VIEW, c.list);
router.get('/:id', VIEW, c.detail);
router.patch('/:id/phuong-an-in', MANAGE, c.changePhuongAnIn);

module.exports = router;
