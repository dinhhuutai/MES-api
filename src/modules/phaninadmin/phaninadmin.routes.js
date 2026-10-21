'use strict';

const express = require('express');
const c = require('./phaninadmin.controller');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

// QUẢN TRỊ PHẦN IN — trang gỡ rối: xem/sửa mọi thứ của 1 phần in.
// ⚠ Quyền `PHAN_IN_ADMIN` (mig 078) cho MỌI route, kể cả GET: màn này phơi bày toàn bộ trạng thái
//   runtime và là đường đặt lại giai đoạn, không phải màn tra cứu thường.
const router = express.Router();
router.use(auth);
router.use(rbac('PHAN_IN_ADMIN'));

router.get('/tra-cuu', c.traCuu);

// Route TĨNH đặt TRƯỚC route có tham số động cùng cấp (quy ước đã có ở các module khác).
router.post('/dot-vai/huy', c.huyDotVai);
router.post('/dot-vai/mo', c.moDotVai);
router.patch('/dot-vai/:dotVaiId', c.suaDotVai);
router.post('/dot-vai/:dotVaiId/dat-giai-doan', c.datGiaiDoan);

router.get('/:phanInId', c.chiTiet);
router.patch('/:phanInId', c.suaPhanIn);
router.post('/:phanInId/huy-muc-ready', c.huyMucReady);
// 19/10/2026: khóa ERP (mig 116) · lùi lệnh về trạm bất kỳ (body.xemTruoc = chỉ dựng kế hoạch) · hủy lẻ 1 bản ghi ·
// phân công 1 phiếu · hủy / mở cả phần in.
router.post('/:phanInId/khoa-erp', c.datKhoaErp);
router.post('/:phanInId/lenh/:lenhId/lui-ve', c.luiVe);
router.post('/:phanInId/huy-le', c.huyLe);
router.post('/:phanInId/phieu/:phieuId/phan-cong', c.luuPhanCong);
router.post('/:phanInId/huy', c.huyPhanIn);
router.post('/:phanInId/mo', c.moPhanIn);

module.exports = router;
