'use strict';

const express = require('express');
const auth = require('../../middlewares/auth');
const c = require('./duyet.controller');

const router = express.Router();
router.use(auth);

// ⚠⚠ CỐ Ý KHÔNG khai `rbac` ở route nào — quyền kiểm TRONG service (xem duyet.controller.js).
//   Người chỉ GỬI được yêu cầu vẫn phải xem được yêu cầu của chính mình; đặt `rbac('PA_IN_APPROVE')`
//   ở đây là chặn oan đúng nhóm đó.

// ⚠ ROUTE TĨNH ĐẶT TRƯỚC ROUTE THAM SỐ (`/:id/...`) — luật §11.2.
router.get('/dem-cho-duyet', c.demChoDuyet);
router.get('/', c.danhSach);

// Gửi yêu cầu ĐỔI PHƯƠNG ÁN IN. Người có quyền duyệt → áp dụng NGAY (service tự rẽ nhánh).
router.post('/doi-phuong-an-in', c.guiDoiPain);

router.post('/:id/duyet', c.duyet);
router.post('/:id/tu-choi', c.tuChoi);
router.post('/:id/huy', c.huy);

module.exports = router;
