'use strict';

const service = require('./erpsync.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const { getPaging } = require('../../utils/pagination');
const AppError = require('../../utils/AppError');
const { ngayHomNayVN } = require('../../utils/khoangNgay');

// ĐỒNG BỘ LẠI TỪ NGÀY (29/10/2026, người dùng: "máy chủ lỗi chiều nay, mai sửa xong thì chọn lại ngày hôm nay để đồng
//   bộ"): job 5 phút + "Đồng bộ ngay" lấy theo GIỜ HIỆN TẠI (feed ERP chỉ trả cửa sổ vài giờ gần nhất) ⇒ đợt về lúc máy
//   chủ hỏng bị sót. Gửi `fromDate` = 'YYYY-MM-DD' ⇒ ERP trả mọi đợt TỪ 00:00 ngày đó tới hiện tại (cùng tham số "Cập nhật
//   theo code phần" đang dùng); upsert theo khóa đợt nên đợt đã có chỉ cập nhật, không đẻ trùng. Tối đa 14 ngày (proc nặng).
const SO_NGAY_TOI_DA = 14;
function chuanFromDate(v) {
  const s = String(v || '').trim();
  if (!s) return undefined;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}(?::\d{2})?))?$/);
  if (!m || Number.isNaN(new Date(`${m[1]}T00:00:00Z`).getTime())) {
    throw new AppError('Ngày đồng bộ không hợp lệ (cần dạng YYYY-MM-DD)', { status: 422, errorCode: 'NGAY_SAI' });
  }
  const homNay = ngayHomNayVN();
  const lui = (new Date(`${homNay}T00:00:00Z`) - new Date(`${m[1]}T00:00:00Z`)) / 86400000;
  if (lui < 0) throw new AppError('Không chọn ngày ở tương lai', { status: 422, errorCode: 'NGAY_SAI' });
  if (lui > SO_NGAY_TOI_DA) {
    throw new AppError(`Chỉ đồng bộ lại tối đa ${SO_NGAY_TOI_DA} ngày trước`, { status: 422, errorCode: 'QUA_XA' });
  }
  return m[2] ? `${m[1]}T${m[2].length === 5 ? `${m[2]}:00` : m[2]}` : `${m[1]}T00:00:00`;
}

const syncPhieuNhanVai = asyncHandler(async (req, res) => {
  const fromDate = chuanFromDate(req.body.fromDate || req.query.fromDate);
  const result = await service.syncPhieuNhanVai({ fromDate, actorId: req.user.id, tuDong: false });
  return ok(res, result,
    `Đồng bộ ERP xong: ${result.soMoi} mới, ${result.soCapNhat} cập nhật, ${result.soBoQua || 0} bỏ qua (không có code_part), ${result.soLoi} lỗi`);
});

const history = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  return ok(res, await service.history({ date: req.query.date || null, page, limit, offset }));
});

const rawData = asyncHandler(async (req, res) =>
  ok(res, await service.rawData(req.params.id)));

// Cập nhật lại theo code phần + ngày (21/09/2026) — 2 bước: xem trước (chỉ đọc) → cập nhật.
const xemTruocCodePhan = asyncHandler(async (req, res) =>
  ok(res, await service.xemTruocCodePhan(req.body || {}, req.user.id)));
const capNhatCodePhan = asyncHandler(async (req, res) => {
  const r = await service.capNhatCodePhan(req.body || {}, req.user.id);
  const soDoi = (r.ghi_de || []).filter((x) => x && x.doi).length;
  return ok(res, r, `Đã cập nhật: ${r.soMoi} đợt mới, ${r.soCapNhat} cập nhật, gán lại đơn/mã hàng ${soDoi} phần in`);
});

module.exports = { syncPhieuNhanVai, history, rawData, xemTruocCodePhan, capNhatCodePhan };
