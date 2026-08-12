'use strict';

// PHIÊN ĐĂNG NHẬP + ĐĂNG XUẤT TỪ XA (mig 081).
//
// Mục đích nghiệp vụ: 1 tài khoản dùng ở nhiều máy/điện thoại trong xưởng ⇒ cần thấy nó đang đăng
// nhập ở đâu và đăng xuất được máy KHÔNG dùng nữa (máy để quên trạng thái đăng nhập thì ai cũng bấm
// xác nhận được).
//
// ⚠ Đăng xuất từ xa có hiệu lực THẬT (không chỉ đá tab): `jti` của phiên vào danh sách chặn ⇒ token
//   đó bị 401 ở request kế tiếp. Kèm socket `phien:dang-xuat` để tab đang mở về màn đăng nhập NGAY.

const repo = require('./phien.repository');
const AppError = require('../../utils/AppError');
const sockets = require('../../sockets');
const { xoaCache } = require('../../utils/phienCache');

async function danhSach({ search, chiHoatDong, userId }) {
  const rows = await repo.listPhien({ search, chiHoatDong, userId });
  return {
    items: rows,
    // FE cần biết bảng đã tồn tại chưa để hiện banner nhắc chạy migration thay vì "không có dữ liệu".
    co_bang: await repo.coBangPhien(),
  };
}

// Đăng xuất 1 phiên (1 thiết bị). `actor` = req.user để tự cho phép đăng xuất phiên CỦA CHÍNH MÌNH
// mà không cần quyền `PHIEN_MANAGE`.
async function dangXuatPhien(id, { actorId, coQuyen }, lyDo) {
  const p = await repo.getPhien(id);
  if (!p) throw new AppError('Phiên không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (!coQuyen && p.nguoi_dung_id !== actorId) {
    throw new AppError('Không có quyền đăng xuất thiết bị của người khác', { status: 403, errorCode: 'FORBIDDEN' });
  }
  if (p.trang_thai !== 'HOAT_DONG') {
    throw new AppError('Phiên này đã đăng xuất trước đó', { status: 409, errorCode: 'DA_DANG_XUAT' });
  }
  const done = await repo.dongPhienTheoId(id, actorId, lyDo);
  if (!done) throw new AppError('Phiên này đã đăng xuất trước đó', { status: 409, errorCode: 'DA_DANG_XUAT' });

  xoaCache();   // ⚠ BẮT BUỘC — không xóa thì token vẫn đi được tới hết TTL của cache
  sockets.emit('phien:dang-xuat', { jti: done.jti, userId: done.nguoi_dung_id });
  return { ok: true, ho_ten: p.ho_ten, thiet_bi: p.thiet_bi };
}

// Đăng xuất MỌI thiết bị của 1 tài khoản.
// ⚠⚠ Đặt thêm mốc `nguoi_dung.tg_buoc_dang_xuat_truoc` — đây là đường DUY NHẤT chặn được token CŨ
//   (phát trước mig 081, không có `jti`). Chỉ theo `jti` thì máy nào đăng nhập từ trước bản này vẫn
//   vào được, tức là nút bấm "có mà như không".
// ⚠ `boQuaJtiCuaToi`: khi tự đăng xuất thiết bị khác của CHÍNH MÌNH thì giữ phiên đang dùng. Nhưng
//   mốc thời gian không phân biệt được phiên ⇒ chỉ đặt mốc khi đăng xuất TÀI KHOẢN KHÁC.
async function dangXuatMoiThietBi(userId, { actorId, coQuyen }, lyDo, boQuaJtiCuaToi = null) {
  if (!coQuyen && userId !== actorId) {
    throw new AppError('Không có quyền đăng xuất tài khoản khác', { status: 403, errorCode: 'FORBIDDEN' });
  }
  const laChinhMinh = userId === actorId;
  const rows = await repo.dongMoiPhienCuaUser(userId, actorId, lyDo, laChinhMinh ? boQuaJtiCuaToi : null);
  if (!laChinhMinh) await repo.datMocDangXuat(userId, actorId);

  xoaCache();
  rows.forEach((r) => sockets.emit('phien:dang-xuat', { jti: r.jti, userId }));
  if (!laChinhMinh) sockets.emit('phien:dang-xuat', { userId });   // phủ cả token cũ không có jti
  return { so_phien: rows.length, ca_token_cu: !laChinhMinh };
}

module.exports = { danhSach, dangXuatPhien, dangXuatMoiThietBi };
