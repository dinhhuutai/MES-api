'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const { ok, fail } = require('../../utils/response');
const service = require('./siso.service');
const { MAN } = require('../../utils/siSoTram');

// ⚠ Quyền kiểm THEO MÀN (mỗi màn khai `quyen` riêng trong `utils/siSoTram.js`) chứ không đặt 1 rbac
//   cứng ở route: sĩ số của màn KCS phải đòi quyền KCS, của Release 1 phải đòi RELEASE1… Người chỉ
//   có quyền 1 màn thì chỉ xem được sĩ số màn đó.
function coQuyen(req, maTrang) {
  const m = MAN[maTrang];
  if (!m) return false;
  const perms = (req.user && req.user.permissions) || [];
  return perms.includes('*') || m.quyen.some((p) => perms.includes(p));
}

const guard = (req, res) => {
  const { maTrang } = req.params;
  if (!MAN[maTrang]) { fail(res, 'Màn hình không có sĩ số', 'MAN_LA', null, 404); return false; }
  if (!coQuyen(req, maTrang)) { fail(res, 'Không có quyền xem sĩ số màn này', 'FORBIDDEN', MAN[maTrang].quyen, 403); return false; }
  return true;
};

const danhMuc = asyncHandler(async (req, res) => ok(res, service.danhMuc()));

const siSo = asyncHandler(async (req, res) => {
  if (!guard(req, res)) return undefined;
  return ok(res, await service.siSo(req.params.maTrang, req.query));
});

const chiTiet = asyncHandler(async (req, res) => {
  if (!guard(req, res)) return undefined;
  return ok(res, await service.chiTiet(req.params.maTrang, req.params.o, req.query));
});

module.exports = { danhMuc, siSo, chiTiet };
