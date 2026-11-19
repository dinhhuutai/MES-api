'use strict';

// ═════════════════════════════════════════════════════════════════════════════
// /api/ai — AGENT MES THLA (19/11/2026, mig 138). Trợ lý AI CHỈ ĐỌC.
//   GET  /trang-thai                 ai cũng gọi được (FE biết có hiện robot không)
//   ── từ đây đòi quyền AI TƯỜNG MINH (không đi theo '*', đọc tươi DB — `quyenAi.js`) ──
//   POST /hoi                        { cau_hoi, hoi_thoai_id?, trang_hien_tai? } ⇒ { hoi_thoai_id, tin_nhan, con_lai }
//   GET  /hoi-thoai                  cuộc trò chuyện của tôi
//   GET  /hoi-thoai/:id              tin nhắn của 1 cuộc
//   DELETE /hoi-thoai/:id            xóa mềm
//   POST /tin-nhan/:id/danh-gia      { danh_gia: 1 | -1 | 0, ghi_chu? }
//   PUT  /mau-robot                  { mau_robot: VANG_NANG | VANG_KEM } — chọn ở Thông tin cá nhân (cột nguoi_dung.ai_mau_robot)
// ⚠ POST/DELETE ở đây chỉ ghi nhật ký của CHÍNH người hỏi ⇒ đã thêm ngoại lệ ở `utils/chiXem.js`.
// ═════════════════════════════════════════════════════════════════════════════

const express = require('express');
const auth = require('../../middlewares/auth');
const asyncHandler = require('../../utils/asyncHandler');
const { ok, fail } = require('../../utils/response');
const { canQuyenAi } = require('./quyenAi');
const service = require('./ai.service');

const router = express.Router();
router.use(auth);

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const kiemId = (req, res, next) => (RE_UUID.test(req.params.id || '') ? next() : fail(res, 'Mã không hợp lệ', 'VALIDATION', [], 422));

router.get('/trang-thai', asyncHandler(async (req, res) => ok(res, await service.trangThai(req.user))));

router.use(canQuyenAi());
router.post('/hoi', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (b.hoi_thoai_id && !RE_UUID.test(String(b.hoi_thoai_id))) return fail(res, 'Mã cuộc trò chuyện không hợp lệ', 'VALIDATION', [], 422);
  return ok(res, await service.hoi(req, b));
}));
router.get('/hoi-thoai', asyncHandler(async (req, res) => ok(res, await service.dsHoiThoai(req.user.id))));
router.get('/hoi-thoai/:id', kiemId, asyncHandler(async (req, res) => ok(res, await service.chiTietHoiThoai(req.params.id, req.user.id))));
router.delete('/hoi-thoai/:id', kiemId, asyncHandler(async (req, res) => ok(res, await service.xoaHoiThoai(req.params.id, req.user.id), 'Đã xóa cuộc trò chuyện')));
router.post('/tin-nhan/:id/danh-gia', kiemId, asyncHandler(async (req, res) => ok(res, await service.danhGia(req.params.id, req.user.id, req.body || {}))));
router.put('/mau-robot', asyncHandler(async (req, res) => ok(res, await service.datMauRobot(req.user.id, req.body || {}), 'Đã đổi hình robot')));

module.exports = router;
