'use strict';

const repo = require('./mauphieu.repository');
const AppError = require('../../utils/AppError');
const {
  KHO_GIAY, HUONG, LE_MAC_DINH, VI_TRI_IN_PHIEU, TRUONG_PHIEU, TRUONG_DONG_PHIEU,
  DINH_DANG_NGAY, timViTriPhieu, kiemBoCucPhieu,
} = require('../../utils/mauPhieu');

// Danh mục cho màn thiết kế: khổ giấy · hướng · lề mặc định · vị trí in · 2 nhóm trường · định dạng ngày.
// FE ĐỌC TỪ ĐÂY, không chép cứng sang FE — chép là sớm muộn 2 bên lệch nhau.
async function danhMuc() {
  const gan = await repo.listGan();
  const map = new Map(gan.map((g) => [g.ma_vi_tri, g.mau_phieu_id]));
  return {
    kho_giay: KHO_GIAY,
    huong: HUONG,
    le_mac_dinh: LE_MAC_DINH,
    vi_tri_in: VI_TRI_IN_PHIEU.map((v) => ({ ...v, mau_phieu_id: map.get(v.ma) || null })),
    truong: TRUONG_PHIEU,
    truong_dong: TRUONG_DONG_PHIEU,
    dinh_dang_ngay: DINH_DANG_NGAY,
    co_bang: await repo.kiemBang(),
  };
}

async function list(actorId) {
  await repo.seedMauGoc(actorId); // đảm bảo luôn có 2 mẫu gốc để bắt đầu sửa
  return repo.listMau();
}

async function chiTiet(id) {
  const m = await repo.getMau(id);
  if (!m) throw new AppError('Không tìm thấy mẫu phiếu', { status: 404, errorCode: 'NOT_FOUND' });
  return m;
}

// Chuẩn hóa + kiểm bố cục TRƯỚC KHI LƯU. Sai thì báo rõ từng lỗi thay vì lưu dữ liệu rác rồi hỏng bản in.
function kiemHoacNem(boCuc) {
  const loi = kiemBoCucPhieu(boCuc);
  if (loi.length) {
    throw new AppError(`Bố cục phiếu không hợp lệ: ${loi.join(' · ')}`,
      { status: 422, errorCode: 'BO_CUC_INVALID', details: loi });
  }
}

async function tao({ maMau, tenMau, moTa, boCuc }, actorId) {
  const ma = String(maMau || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  if (!ma) throw new AppError('Chưa nhập mã mẫu', { status: 422, errorCode: 'NO_MA' });
  if (!String(tenMau || '').trim()) throw new AppError('Chưa nhập tên mẫu', { status: 422, errorCode: 'NO_TEN' });
  if (await repo.getMauByMa(ma)) throw new AppError(`Mã mẫu "${ma}" đã tồn tại`, { status: 409, errorCode: 'MA_TRUNG' });
  kiemHoacNem(boCuc);
  return repo.taoMau({ maMau: ma, tenMau: String(tenMau).trim(), moTa, boCuc }, actorId);
}

// Nhân bản: chép bố cục của 1 mẫu sang mẫu MỚI (để sửa thử mà không đụng mẫu đang in).
async function nhanBan(id, { maMau, tenMau }, actorId) {
  const goc = await chiTiet(id);
  return tao({ maMau, tenMau: tenMau || `${goc.ten_mau} (bản sao)`, moTa: goc.mo_ta, boCuc: goc.bo_cuc_json }, actorId);
}

async function sua(id, { tenMau, moTa, boCuc }, actorId) {
  await chiTiet(id);
  if (boCuc !== undefined) kiemHoacNem(boCuc);
  return repo.suaMau(id, { tenMau, moTa, boCuc }, actorId);
}

// Xóa mẫu — chặn mẫu GỐC do hệ thống seed (là bản dựng lại phiếu đang chạy, xóa đi thì mất mốc so sánh).
async function xoa(id, actorId) {
  const m = await chiTiet(id);
  if (m.la_mac_dinh) {
    throw new AppError('Đây là mẫu gốc của hệ thống — không xóa được. Hãy nhân bản rồi sửa bản sao.',
      { status: 409, errorCode: 'MAU_GOC' });
  }
  return repo.xoaMau(id, actorId);
}

// Gắn mẫu vào 1 vị trí in. `mauPhieuId` rỗng ⇒ GỠ gắn (nút in lùi về bố cục cứng trong code).
async function gan(maViTri, mauPhieuId, actorId) {
  if (!timViTriPhieu(maViTri)) {
    throw new AppError(`Vị trí in "${maViTri}" không có trong danh mục`, { status: 422, errorCode: 'VI_TRI_INVALID' });
  }
  if (mauPhieuId) await chiTiet(mauPhieuId); // 404 nếu mẫu không tồn tại
  return repo.ganMau(maViTri, mauPhieuId || null, actorId);
}

// Mẫu đang dùng cho 1 vị trí in — FE gọi ngay trước khi in. Chưa gắn → `null` (lùi về bố cục cứng).
async function mauChoViTri(maViTri) {
  const vt = timViTriPhieu(maViTri);
  if (!vt) throw new AppError(`Vị trí in "${maViTri}" không có trong danh mục`, { status: 422, errorCode: 'VI_TRI_INVALID' });
  const mau = await repo.getMauTheoViTri(maViTri);
  return { vi_tri: vt, mau: mau || null };
}

module.exports = { danhMuc, list, chiTiet, tao, nhanBan, sua, xoa, gan, mauChoViTri };
