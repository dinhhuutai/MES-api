'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// TRANG CÔNG KHAI — KHÔNG CẦN ĐĂNG NHẬP (26/11/2026, người dùng: "modal Theo dõi chuyền in ... đường dẫn public, không cần
//   đăng nhập vẫn mở ra được, chỉ cần /san-luong"). Router này KHÔNG gắn `auth` — mọi route ở đây ai cũng gọi được ⇒ luật:
//   · CHỈ ĐỌC (GET).
//   · CHỈ TRẢ đúng các trường màn đang hiện (danh sách trắng) — KHÔNG họ tên ca trưởng / chuyền trưởng / thợ in, nhà gia
//     công, mã quét, mã vạch, id nội bộ… (`/production/monitor` nội bộ trả các thứ đó). Thêm trường ⇒ thêm vào danh sách
//     trắng ở đây, đừng trả nguyên hàng.
//   · Dùng CHUNG bộ đệm `nhoDoc` với màn nội bộ (in tem / thao tác ghi xóa cache ngay) ⇒ nhiều màn TV mở cùng lúc không
//     thêm tải DB; giới hạn lượt / IP chặn gọi dồn.
// FE: trang `/san-luong` (`features/congkhai/SanLuongPage.js`) — 3 chế độ như modal: Chuyền đang chạy · Tổng nhà máy · Theo tổ.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const AppError = require('../../utils/AppError');
const { nhoDoc } = require('../../utils/cacheDoc');

const router = express.Router();

// GIỚI HẠN LƯỢT / IP (cửa sổ 1 phút, RAM — BE chạy 1 tiến trình). Rộng tay: nhiều màn TV sau cùng 1 IP (NAT xưởng) mỗi màn
//   tự tải 10 s + theo socket. Vượt ⇒ 429.
const CUA_SO_MS = 60000;
const TOI_DA_MOI_PHUT = 600;
const luot = new Map();
const ipCua = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || req.socket?.remoteAddress || '?';
router.use((req, res, next) => {
  const now = Date.now();
  const ip = ipCua(req);
  const m = luot.get(ip);
  if (!m || now - m.tu > CUA_SO_MS) luot.set(ip, { tu: now, n: 1 });
  else if (++m.n > TOI_DA_MOI_PHUT) return next(new AppError('Gọi quá nhiều — thử lại sau ít phút', { status: 429, errorCode: 'QUA_NHIEU_LUOT' }));
  if (luot.size > 5000) { for (const [k, v] of luot) if (now - v.tu > CUA_SO_MS) luot.delete(k); }
  return next();
});
router.use((req, res, next) => (req.method === 'GET' ? next()
  : next(new AppError('Trang công khai chỉ đọc', { status: 405, errorCode: 'CHI_DOC' }))));

const chon = (o, ds) => Object.fromEntries(ds.map((k) => [k, o[k] ?? null]));

// Chuyền đang chạy — đúng các trường `frontend/.../utils/theoDoiChuyen.js gomTheoChuyen` + chip khu (`utils/khuChuyen.js`) đọc.
const COT_DANG_CHAY = [
  'chuyen_id', 'ma_chuyen', 'ten_chuyen', 'ma_loai_chuyen', 'ten_loai_chuyen',
  'target', 'printed', 'phut_in', 'tg_bd', 'ngung_phut', 'tg_bd_kh', 'tg_kt_kh', 'dang_ngung',
  'ma_phan', 'phan_list', 'ma_hang', 'mau_vai', 'ten_khach_hang',
];
const COT_CHO_CHAY = ['ma_chuyen', 'ma_loai_chuyen', 'ma_phan', 'ma_lenh_san_xuat', 'target', 'tg_bd_kh'];

router.get('/san-luong/chuyen', asyncHandler(async (req, res) => {
  const service = require('../production/production.service');
  const d = await nhoDoc('production.monitor', '', () => service.monitor());
  return ok(res, {
    running: (d.running || []).map((r) => chon(r, COT_DANG_CHAY)),
    queue: (d.queue || []).map((r) => chon(r, COT_CHO_CHAY)),
  });
}));

// Tổng nhà máy · Theo tổ — `production/theoDoiTo.js` (đã có bộ đệm riêng). Ngày SX `?ngay=YYYY-MM-DD`, sai / thiếu ⇒ hôm nay.
//   Dữ liệu vốn chỉ có số kế hoạch / thực tế + thông tin phần in, tổ / chuyền (không có tên người) — vẫn lọc theo danh sách
//   trắng cho chắc.
const COT_LENH = [
  'lenh_id', 'ma_lenh_san_xuat', 'trang_thai', 'chuyen_kh_id', 'la_ke_hoach', 'so_luong_release', 'tg_bd_kh', 'tg_kt_kh',
  'ngay_kh', 'ten_khach_hang', 'ma_don_hang', 'ma_hang', 'ma_phan', 'mau_vai', 'kich_vai', 'kich_phim', 'phan_list', 'tt',
];
const ngayHomNayVN = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
router.get('/san-luong/to', asyncHandler(async (req, res) => {
  const q = String(req.query.ngay || '').trim();
  const ngay = /^\d{4}-\d{2}-\d{2}$/.test(q) && !Number.isNaN(Date.parse(q)) ? q : ngayHomNayVN();
  const d = await require('../production/theoDoiTo').theoDoiTo(ngay);
  return ok(res, {
    ngay: d.ngay,
    co_cot_to: d.co_cot_to,
    to: (d.to || []).map((t) => chon(t, ['id', 'ma_to', 'ten_to'])),
    chuyen: (d.chuyen || []).map((c) => chon(c, ['id', 'ma_chuyen', 'ten_chuyen', 'dang_hoat_dong', 'ma_loai', 'to_in_id'])),
    lenh: (d.lenh || []).map((l) => chon(l, COT_LENH)),
  });
}));

module.exports = router;
