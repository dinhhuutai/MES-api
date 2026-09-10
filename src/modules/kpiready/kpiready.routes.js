'use strict';

const express = require('express');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');
const c = require('./kpiready.controller');

const router = express.Router();
router.use(auth);

// ⚠ Route TĨNH `/cau-hinh/don-hang` KHÔNG đụng `/` nên thứ tự không quan trọng ở đây, nhưng giữ
//   route cấu hình lên trước cho dễ đọc (và phòng khi sau này thêm `/:id`).
//
// ⚠⚠ HAI QUYỀN TÁCH BẠCH (mig 093):
//   · `KPI_READY_VIEW`      → XEM trang Dashboard → KPI READY
//   · `KPI_DON_HANG_MANAGE` → CHỌN đơn hàng lấy số liệu (trang ở Hệ thống)
//   Người chọn đơn hàng cũng cần xem được kết quả ⇒ route đọc nhận CẢ HAI.
router.get('/cau-hinh/don-hang', rbac('KPI_DON_HANG_MANAGE'), c.dsDonHang);
router.put('/cau-hinh/don-hang', rbac('KPI_DON_HANG_MANAGE'), c.luuDonHang);

// Danh mục 23 cột + owner + đích gán — cho trang *Hệ thống → Owner checkpoint/checklist* bày đủ cột
// mà gán owner. ⚠ Route TĨNH `/cot` phải đứng TRƯỚC `/` (Express khớp theo thứ tự khai).
// ⚠ Nhận thêm `WORKFLOW_VIEW`/`WORKFLOW_MANAGE`: người gán owner là quản trị workflow, họ KHÔNG nhất
//   thiết có quyền xem số liệu KPI. Endpoint này chỉ trả DANH MỤC + tên owner, không có số nghiệp vụ.
router.get('/cot', rbac('KPI_READY_VIEW', 'KPI_DON_HANG_MANAGE', 'WORKFLOW_VIEW', 'WORKFLOW_MANAGE'),
  c.danhMucCot);

router.get('/', rbac('KPI_READY_VIEW', 'KPI_DON_HANG_MANAGE'), c.duLieu);

module.exports = router;
