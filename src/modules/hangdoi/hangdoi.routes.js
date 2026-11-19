'use strict';

// /api/hang-doi — HÀNG ĐỢI TÍCH TEM (19/11/2026, `hangDoi.js`).
//   GET  /            ?loai&trangThai&lo&tim&soGio — trang Hệ thống › Hàng đợi tích tem + nút Hàng đợi ở 4 màn
//   POST /            { loai: KCS|PHAN_LOAI_LOI|NHAN_SUA|SUA, items: [{ temId, body }], nguon } — quyền của màn đó (service kiểm)
//   POST /:id/bo      { lyDo } — người xếp bỏ mục của mình, quản trị bỏ mọi mục
// Đọc: ai có 1 trong các quyền màn (KCS / PHAN_LOAI_LOI / SUA) hoặc xem Hệ thống / quản trị.

const express = require('express');
const auth = require('../../middlewares/auth');
const rbac = require('../../middlewares/rbac');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const hd = require('./hangDoi');

const router = express.Router();
router.use(auth);
const QUYEN_MAN = ['KCS', 'PHAN_LOAI_LOI', 'SUA', 'WORKFLOW_VIEW'];

router.get('/', rbac(...QUYEN_MAN), asyncHandler(async (req, res) => ok(res, await hd.danhSach(req.query || {}))));
router.post('/', rbac(...QUYEN_MAN), asyncHandler(async (req, res) => {
  const kq = await hd.xep(req.user, req.body || {});
  return ok(res, kq, `Đã đưa ${kq.so} tem vào hàng đợi`);
}));
router.post('/:id/bo', rbac(...QUYEN_MAN), asyncHandler(async (req, res) =>
  ok(res, await hd.bo(req.user, req.params.id, (req.body || {}).lyDo), 'Đã bỏ khỏi hàng đợi')));

module.exports = router;
