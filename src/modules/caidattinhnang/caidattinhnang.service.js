'use strict';

const repo = require('./caidattinhnang.repository');
const AppError = require('../../utils/AppError');
const sockets = require('../../sockets');
const {
  MA_HOP_LE, xoaCache, danhSachCauHinh, trangThaiRutGon,
} = require('../../utils/caiDatTinhNang');
const duyetService = require('../duyet/duyet.service');

// ─────────────────────────────────────────────────────────────────────────────
// Hệ thống > Cài đặt tính năng (mig 087). Xem `utils/caiDatTinhNang.js` cho danh mục + luật fail-open.
// ─────────────────────────────────────────────────────────────────────────────

// Danh sách tính năng + trạng thái + người/giờ sửa gần nhất.
async function danhSach() {
  const [ds, sua] = await Promise.all([danhSachCauHinh(), thongTinSuaAnToan()]);
  const theoMa = new Map(sua.map((r) => [r.ma_tinh_nang, r]));
  return ds.map((x) => {
    const s = theoMa.get(x.ma) || {};
    return { ...x, ghi_chu: s.ghi_chu || null, nguoi_sua: s.nguoi || null, tg_sua: s.updated_date || null };
  });
}

// Thiếu bảng (chưa chạy mig 087) thì vẫn mở được trang — chỉ không có thông tin người sửa.
async function thongTinSuaAnToan() {
  try { return await repo.thongTinSua(); } catch { return []; }
}

// Lưu nhiều dòng 1 lượt. Mã lạ bị bỏ qua (danh mục nằm ở code, không tin dữ liệu từ client).
//
// ⚠⚠ TẮT CÔNG TẮC DUYỆT ⇒ DUYỆT SẠCH HÀNG ĐỢI (người dùng chốt 19/08/2026). Trả `hau_qua` để FE
//   hiện rõ đã áp dụng bao nhiêu yêu cầu — im lặng thì người bấm không biết mình vừa đổi phương án
//   in cho hàng loạt hồ sơ.
async function luu(items, actorId) {
  const ds = (Array.isArray(items) ? items : []).filter((x) => x && MA_HOP_LE.has(x.ma));
  if (!ds.length) throw new AppError('Không có mục hợp lệ để lưu', { status: 422, errorCode: 'EMPTY' });

  // ⚠ ĐỌC TRẠNG THÁI CŨ TRƯỚC KHI GHI: chỉ khi BẬT → TẮT mới dọn hàng đợi. Lưu lại khi đang tắt sẵn
  //   (vd chỉ sửa ghi chú) thì không được chạy lại việc duyệt hàng loạt.
  const truoc = await trangThaiRutGon();

  for (const it of ds) {
    await repo.luu({ ma: it.ma, bat: it.bat, ghiChu: it.ghi_chu }, actorId);
  }
  xoaCache(); // có hiệu lực NGAY, không chờ hết TTL 30s

  // Dọn hàng đợi cho những loại duyệt vừa bị tắt.
  const hauQua = [];
  for (const it of ds) {
    const loai = Object.keys(duyetService.TINH_NANG_CUA_LOAI)
      .find((k) => duyetService.TINH_NANG_CUA_LOAI[k] === it.ma);
    if (!loai) continue;
    if (!(truoc[it.ma] === true && !it.bat)) continue; // chỉ ca BẬT → TẮT
    try {
      const kq = await duyetService.duyetHetKhiTat(loai, actorId);
      if (kq.tong) hauQua.push({ ma: it.ma, loai, ...kq });
    } catch (e) {
      // ⚠ Hàng đợi lỗi KHÔNG được nuốt mất việc lưu công tắc (công tắc đã ghi xong ở trên).
      hauQua.push({ ma: it.ma, loai, tong: 0, da_duyet: 0, loi: [{ thong_diep: e.message }] });
    }
  }

  sockets.emit('cai-dat:tinh-nang', {});
  return { items: await danhSach(), hau_qua: hauQua };
}

module.exports = { danhSach, luu, trangThai: trangThaiRutGon };
