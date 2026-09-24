'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// GHI CHÚ PHẦN IN + PHẦN IN BẤT THƯỜNG — màn Chuẩn bị kỹ thuật — READY (mig 103, 24/09/2026).
//   · GHI_CHU    : mỗi lần lưu = 1 dòng mới ⇒ lịch sử; SidePanel hiện dòng MỚI NHẤT + lịch sử bên dưới.
//   · BAT_THUONG : dòng `dang_hoat_dong` = phần in đang bất thường; gỡ = xóa mềm (giữ người/giờ gỡ).
// ⚠ DÒ BẢNG TRƯỚC (`coBangGhiChu`) — thiếu mig 103 thì ĐỌC trả rỗng + cờ `thieu_migration`, GHI báo
//   409 `THIEU_MIGRATION`. Không sập màn READY. Cache khi ĐÃ có bảng ⇒ chạy migration xong nhận ngay.
// ─────────────────────────────────────────────────────────────────────────────

const { query, withTransaction } = require('../../config/db');
const asyncHandler = require('../../utils/asyncHandler');
const AppError = require('../../utils/AppError');
const { ok } = require('../../utils/response');
const sockets = require('../../sockets');

const DAI_TOI_DA = 2000; // ký tự / ghi chú

let _coBang = false;
async function coBangGhiChu() {
  if (_coBang) return true;
  try {
    const { rows } = await query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='phan_in_ghi_chu' LIMIT 1");
    _coBang = rows.length > 0;
  } catch { _coBang = false; }
  return _coBang;
}
async function canBang() {
  if (!(await coBangGhiChu())) {
    throw new AppError('Chưa chạy migration 103 (ghi chú phần in) — báo quản trị chạy database/migrations/103_phan_in_ghi_chu.sql',
      { status: 409, errorCode: 'THIEU_MIGRATION' });
  }
}
const laUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
const dsId = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(laUuid))];
function chuanNoiDung(v, batBuoc = true) {
  const s = String(v == null ? '' : v).trim();
  if (batBuoc && !s) throw new AppError('Nhập nội dung ghi chú', { status: 422, errorCode: 'NO_NOI_DUNG' });
  if (s.length > DAI_TOI_DA) throw new AppError(`Ghi chú tối đa ${DAI_TOI_DA} ký tự`, { status: 422, errorCode: 'QUA_DAI' });
  return s;
}

const COT = `g.id, g.phan_in_id, g.loai, g.noi_dung, g.dang_hoat_dong, g.created_date,
  nt.ho_ten AS nguoi_tao, g.updated_date, ng.ho_ten AS nguoi_go`;

// ── ĐỌC ──
// Ghi chú + dấu bất thường ĐANG hiệu lực của 1 phần in (cho SidePanel).
async function cuaPhanIn(phanInId) {
  if (!(await coBangGhiChu())) return { ghi_chu: [], bat_thuong: null, thieu_migration: true };
  const { rows } = await query(
    `SELECT ${COT} FROM phan_in_ghi_chu g
       LEFT JOIN nguoi_dung nt ON nt.id = g.created_by LEFT JOIN nguoi_dung ng ON ng.id = g.updated_by
      WHERE g.phan_in_id = $1 AND (g.loai = 'GHI_CHU' OR g.dang_hoat_dong)
      ORDER BY g.created_date DESC LIMIT 200`.replace(/\s+/g, ' '), [phanInId]);
  return {
    ghi_chu: rows.filter((r) => r.loai === 'GHI_CHU'),
    bat_thuong: rows.find((r) => r.loai === 'BAT_THUONG') || null,
    thieu_migration: false,
  };
}

// Danh sách phần in ĐANG bất thường (kèm thông tin phần in) — modal "Phần in bất thường".
// `lichSu=1` ⇒ trả thêm các dấu ĐÃ GỠ (để tra ai gỡ, lúc nào).
async function dsBatThuong({ lichSu = false } = {}) {
  if (!(await coBangGhiChu())) return { items: [], thieu_migration: true };
  const { rows } = await query(
    `SELECT ${COT}, p.ma_phan, p.mau_vai, p.kich_vai, p.kich_phim, mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang
       FROM phan_in_ghi_chu g
       JOIN phan_in p ON p.id = g.phan_in_id
       LEFT JOIN ma_hang mh ON mh.id = p.ma_hang_id
       LEFT JOIN don_hang dh ON dh.id = mh.don_hang_id
       LEFT JOIN khach_hang kh ON kh.id = dh.khach_hang_id
       LEFT JOIN nguoi_dung nt ON nt.id = g.created_by LEFT JOIN nguoi_dung ng ON ng.id = g.updated_by
      WHERE g.loai = 'BAT_THUONG' AND ($1::boolean OR g.dang_hoat_dong)
      ORDER BY g.dang_hoat_dong DESC, g.created_date DESC LIMIT 1000`.replace(/\s+/g, ' '), [!!lichSu]);
  return { items: rows, thieu_migration: false };
}

// ── GHI ──
async function themGhiChu(phanInId, noiDung, actorId) {
  await canBang();
  const nd = chuanNoiDung(noiDung);
  const { rows: p } = await query('SELECT 1 FROM phan_in WHERE id = $1', [phanInId]);
  if (!p.length) throw new AppError('Không tìm thấy phần in', { status: 404, errorCode: 'NOT_FOUND' });
  await query(
    "INSERT INTO phan_in_ghi_chu (phan_in_id, loai, noi_dung, created_by) VALUES ($1, 'GHI_CHU', $2, $3)",
    [phanInId, nd, actorId]);
  sockets.emit('ready:ghi-chu', { phanInId });
  return cuaPhanIn(phanInId);
}

// Đánh dấu bất thường cho NHIỀU phần in cùng 1 ghi chú. Phần in đã đang bất thường ⇒ CẬP NHẬT ghi chú
// bằng cách gỡ dấu cũ + tạo dấu mới (giữ lịch sử), không để 2 dấu cùng hiệu lực (UNIQUE partial index).
async function danhDauBatThuong(phanInIds, noiDung, actorId) {
  await canBang();
  const ids = dsId(phanInIds);
  if (!ids.length) throw new AppError('Chọn ít nhất 1 phần in', { status: 422, errorCode: 'NO_PHAN_IN' });
  const nd = chuanNoiDung(noiDung);
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE phan_in_ghi_chu SET dang_hoat_dong = false, updated_date = CURRENT_TIMESTAMP, updated_by = $2
        WHERE loai = 'BAT_THUONG' AND dang_hoat_dong AND phan_in_id = ANY($1::uuid[])`, [ids, actorId]);
    await client.query(
      `INSERT INTO phan_in_ghi_chu (phan_in_id, loai, noi_dung, created_by)
       SELECT p.id, 'BAT_THUONG', $2, $3 FROM phan_in p WHERE p.id = ANY($1::uuid[])`, [ids, nd, actorId]);
  });
  sockets.emit('ready:bat-thuong', { phanInIds: ids });
  return { count: ids.length };
}

async function goBatThuong(phanInIds, actorId) {
  await canBang();
  const ids = dsId(phanInIds);
  if (!ids.length) throw new AppError('Chọn ít nhất 1 phần in', { status: 422, errorCode: 'NO_PHAN_IN' });
  const { rowCount } = await query(
    `UPDATE phan_in_ghi_chu SET dang_hoat_dong = false, updated_date = CURRENT_TIMESTAMP, updated_by = $2
      WHERE loai = 'BAT_THUONG' AND dang_hoat_dong AND phan_in_id = ANY($1::uuid[])`, [ids, actorId]);
  sockets.emit('ready:bat-thuong', { phanInIds: ids });
  return { count: rowCount };
}

// ── CONTROLLER ──
const ctl = {
  cuaPhanIn: asyncHandler(async (req, res) => ok(res, await cuaPhanIn(req.params.phanInId))),
  themGhiChu: asyncHandler(async (req, res) =>
    ok(res, await themGhiChu(req.params.phanInId, req.body.noiDung, req.user.id))),
  dsBatThuong: asyncHandler(async (req, res) =>
    ok(res, await dsBatThuong({ lichSu: req.query.lichSu === '1' }))),
  danhDauBatThuong: asyncHandler(async (req, res) =>
    ok(res, await danhDauBatThuong(req.body.phanInIds, req.body.noiDung, req.user.id))),
  goBatThuong: asyncHandler(async (req, res) => ok(res, await goBatThuong(req.body.phanInIds, req.user.id))),
};

module.exports = { cuaPhanIn, dsBatThuong, themGhiChu, danhDauBatThuong, goBatThuong, coBangGhiChu, ctl };
