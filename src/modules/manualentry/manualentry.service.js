'use strict';

const repo = require('./manualentry.repository');
const AppError = require('../../utils/AppError');
const { withTransaction } = require('../../config/db');
const sockets = require('../../sockets');
// ⚠⚠ TÁI DÙNG ĐÚNG 2 HÀM ERP ĐANG CHẠY, KHÔNG viết đường ghi HSKT riêng cho nhập tay.
// `upsertHsktForPin` lo hết: tra HSKT theo **11 SỐ ĐẦU** barcode (số cuối = phương án in nên ERP và
// MES lệch nhau), KHÔNG ghi đè `phuong_an_in` của HSKT đã tồn tại, ghi `lich_su_hskt`, nối
// `hskt_phan_in`, và tự lùi về bản KHÔNG barcode khi chỉ có Pain. Viết lại là chắc chắn lệch.
const erpRepo = require('../erpsync/erpsync.repository');
const hsktRepo = require('../hskt/hskt.repository');

const searchKhach = (q) => repo.searchKhach(q || '');
const searchDon = (khachId, q) => repo.searchDon(khachId || null, q || '');
const searchMaHang = (donId, q) => repo.searchMaHang(donId || null, q || '');
const searchPhanIn = (maHangId, q) => repo.searchPhanIn(maHangId || null, q || '');
const listLoaiDotVai = () => repo.listLoaiDotVai();

// Tạo chuỗi khách → đơn → mã hàng → phần in → đợt vải.
// Mỗi cấp: truyền `id` để DÙNG có sẵn, hoặc bỏ id + nhập thông tin để TẠO MỚI.
async function createChain(payload, actorId) {
  const p = payload || {};
  const dotVai = Array.isArray(p.dotVai) ? p.dotVai : [];

  // Validate tối thiểu.
  if (!p.phanIn?.id) {
    if (!p.khach?.id && !(p.khach?.ten_khach_hang || '').trim()) {
      throw new AppError('Chọn khách hàng có sẵn hoặc nhập tên khách hàng mới', { status: 422, errorCode: 'VALIDATION_ERROR' });
    }
  }
  if (dotVai.length === 0) {
    throw new AppError('Cần thêm ít nhất 1 đợt vải', { status: 422, errorCode: 'VALIDATION_ERROR' });
  }
  for (const [i, d] of dotVai.entries()) {
    const sl = Number(d.so_luong_vai_ve);
    if (!Number.isFinite(sl) || sl < 0) {
      throw new AppError(`Đợt vải #${i + 1}: SL vải về phải là số ≥ 0`, { status: 422, errorCode: 'VALIDATION_ERROR' });
    }
  }

  const result = await withTransaction((client) => repo.createChainTx(client, p, actorId));

  // ─── HỒ SƠ KỸ THUẬT — chạy SAU transaction chính, y hệt trình tự của `syncPhieuNhanVai` ───
  // ⚠ `upsertHsktForPin` tự mở transaction riêng nên KHÔNG gọi được bên trong `createChainTx`.
  const hs = p.hskt || {};
  const barcodeHskt = (hs.barcode_hskt || '').trim() || null;
  const pain = hs.phuong_an_in === '' || hs.phuong_an_in == null ? null : Number(hs.phuong_an_in);
  let hsktId = null;
  if (barcodeHskt || pain != null) {
    try {
      hsktId = await erpRepo.upsertHsktForPin({
        pinId: result.phan_in_id,
        barcodeHskt,
        pain,
        inset: hs.inset ?? null,
        maDonReady: hs.ma_don_ready || null,
        maPhan: result.ma_phan,
        actorId,
      });
    } catch (e) {
      // Hồ sơ kỹ thuật hỏng KHÔNG được nuốt mất chuỗi khách→đơn→…→đợt vải đã tạo xong ở trên.
      // Báo rõ để người dùng bổ sung ở trang Hồ sơ kỹ thuật thay vì tưởng cả thao tác thất bại.
      result.hskt_loi = e.message || 'Không tạo được hồ sơ kỹ thuật';
    }
  } else if (result.phan_in_id) {
    // Thêm đợt vải vào phần in CÓ SẴN (hoặc không nhập HSKT): vẫn phải tính lại phương án in
    // vì tổng SL vải của hồ sơ vừa đổi — đúng như post-pass của ERP.
    const cur = await hsktRepo.activeHsktOfPhanIn(result.phan_in_id).catch(() => null);
    hsktId = cur ? cur.id : null;
  }

  // POST-PASS luật sản lượng — **cùng hàm** ERP gọi cuối mỗi lần đồng bộ: Σ SL vải của CẢ hồ sơ
  // ≥ 2000 m → in Máy, < 2000 → in Bàn (bỏ qua khi `pa_in_sua_tay`). Nhờ vậy hàng nhập tay không
  // bị "5 phút sau ERP đổi phương án in" một cách khó hiểu.
  if (hsktId) {
    try {
      const r = await erpRepo.applyPainTheoSanLuong(hsktId, actorId);
      result.phuong_an_in = r.pain;
      result.tong_vai_hskt = r.tong;
      result.doi_phuong_an_in = !!r.doi;
    } catch { /* không chặn: chuỗi dữ liệu đã tạo xong */ }
  }

  sockets.emit('dashboard:refresh', {});
  sockets.emit('ready:confirmed', {});   // màn READY / QC READY tải lại ngầm
  return result;
}

// ─── Cập nhật SL nhận vải / SL release ───────────────────────────────────────
const searchVaiVe = (q) => repo.searchVaiVe(q || '');

const toInt = (v, label) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    throw new AppError(`${label} phải là số nguyên ≥ 0`, { status: 422, errorCode: 'VALIDATION_ERROR' });
  }
  return n;
};

async function updateVaiVe(id, soLuong, actorId) {
  if (!id) throw new AppError('Thiếu đợt vải', { status: 422, errorCode: 'VALIDATION_ERROR' });
  const val = toInt(soLuong, 'SL nhận vải');
  await withTransaction((client) => repo.updateVaiVeTx(client, id, val, actorId));
  sockets.emit('dashboard:refresh', {});
  return { id, so_luong_vai_ve: val };
}

async function updateRelease(lenhId, dotId, soLuong, actorId) {
  if (!lenhId || !dotId) throw new AppError('Thiếu lệnh hoặc đợt vải', { status: 422, errorCode: 'VALIDATION_ERROR' });
  const val = toInt(soLuong, 'SL release');
  await withTransaction((client) => repo.updateReleaseTx(client, lenhId, dotId, val, actorId));
  sockets.emit('dashboard:refresh', {});
  sockets.emit('production:updated', {});
  return { lenh_san_xuat_id: lenhId, dot_vai_ve_id: dotId, so_luong: val };
}

module.exports = {
  searchKhach, searchDon, searchMaHang, searchPhanIn, listLoaiDotVai, createChain,
  searchVaiVe, updateVaiVe, updateRelease,
};
