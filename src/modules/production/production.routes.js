'use strict';

const express = require('express');
const c = require('./production.controller');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');

const router = express.Router();
router.use(auth);

// Xác nhận chạy + in tem
router.get('/candidates', rbac('PROD_RUN'), c.candidates);
router.get('/run/:lenhId', rbac('PROD_RUN', 'PROD_MONITOR'), c.getRun);
router.post('/:lenhId/start', rbac('PROD_RUN'), c.start);
router.post('/phieu/:phieuId/tem', rbac('PROD_RUN'), c.printTem);
router.post('/phieu/:phieuId/finish', rbac('PROD_RUN'), c.finish);
router.post('/tem/:temId/in-lai', rbac('PROD_RUN'), c.reprintTem);
router.get('/tem/:temId/label', rbac('PROD_RUN', 'PROD_MONITOR'), c.temLabel);
router.get('/phieu/:phieuId/tem-logs', rbac('PROD_RUN', 'PROD_MONITOR'), c.temLogs);
router.post('/phieu/:phieuId/vai-huy', rbac('PROD_RUN'), c.addVaiHuy);
router.post('/phieu/:phieuId/ngung', rbac('PROD_RUN'), c.stopLine);
router.post('/phieu/:phieuId/hoat-dong-lai', rbac('PROD_RUN'), c.resumeLine);

// Hủy lệnh in tem (xóa/HỦY tem chưa kiểm + gỡ xe phơi, trả SL về) — dùng ở trang Hủy lệnh xác nhận
router.get('/huy-tem/candidates', rbac('PROD_RUN'), c.cancelableTem);
router.post('/huy-tem/:temId', rbac('PROD_RUN'), c.cancelPrintTem);

// Đóng lệnh sản xuất (= Chạy hoàn tất, khi lệch SL không bấm được ở màn SX) — trang Hủy lệnh xác nhận
router.get('/dong-lenh/candidates', rbac('PROD_RUN'), c.closeCandidates);
router.post('/dong-lenh/:phieuId', rbac('PROD_RUN'), c.closeProduction);

// Mở lại lệnh sản xuất (đã đóng/hoàn tất trong 2 ngày, cần in tiếp) — trang Đóng lệnh sản xuất
router.get('/mo-lai/candidates', rbac('PROD_RUN'), c.reopenCandidates);
router.post('/mo-lai/:phieuId', rbac('PROD_RUN'), c.reopenProduction);

// Ngừng lệnh chạy (ngừng phần in đang chạy để in hàng gấp hơn) → lệnh về chờ chạy — màn Xác nhận chạy
router.post('/phieu/:phieuId/ngung-lenh', rbac('PROD_RUN'), c.pauseLenhChay);

// Vượt sản xuất: cộng SL vượt vào release + trừ đợt vải chưa release cùng phần in — sidebar Xác nhận chạy
router.post('/phieu/:phieuId/vuot-san-xuat', rbac('PROD_RUN'), c.vuotSanXuat);

// Hủy lệnh đang chạy (bấm nhầm Xác nhận chạy) → đưa về danh sách chờ chạy — trang Hủy lệnh xác nhận
router.get('/huy-chay/candidates', rbac('PROD_RUN'), c.undoStartCandidates);
router.post('/huy-chay/:phieuId', rbac('PROD_RUN'), c.undoStartProduction);

// Theo dõi chuyền
router.get('/monitor', rbac('PROD_MONITOR'), c.monitor);

// Xe phơi
router.get('/xe-phoi', rbac('XEPHOI'), c.xePhoi);
router.get('/tem-cho-phoi', rbac('XEPHOI'), c.temChoPhoi);
router.post('/xe-phoi/them-tem', rbac('XEPHOI'), c.themTem);
router.patch('/tem-xe-phoi/:id', rbac('XEPHOI'), c.adjustPhoi);

// Chờ khô
router.get('/drying', rbac('DRYING'), c.drying);
router.post('/drying/:temId/confirm', rbac('DRYING'), c.confirmDry);
// Phơi lại 1 tem (từ màn KCS hoặc chờ khô)
router.post('/tem/:temId/phoi-lai', rbac('KCS', 'DRYING'), c.redry);

module.exports = router;
