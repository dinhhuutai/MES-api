'use strict';

const AppError = require('../../utils/AppError');
const repo = require('./loaikieng.repository');

// ─────────────────────────────────────────────────────────────────────────────
// DANH MỤC KIẾNG + LUẬT Ô "LOẠI KIẾNG / HỆ SỐ KIẾNG" KHI IN TEM (mig 126, 09/11/2026, người dùng chốt).
//   · Hệ số kiếng = 1 tấm kiếng chia được bao nhiêu phần (người in nhập) ⇒ số tấm kiếng = SL in ÷ hệ số.
//   · Bắt buộc ở tem công đoạn IN của phần in luồng IN_KIENG (`utils/luongSanXuat.canNhapKieng`); nhớ theo lệnh.
// ─────────────────────────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HE_SO_TOI_DA = 100000;

const soTamKieng = (soLuong, heSo) => {
  const h = Number(heSo);
  return h > 0 ? Math.round((Number(soLuong) || 0) / h * 100) / 100 : null;
};

function chuanDong(x = {}) {
  const ma = String(x.ma_hang_hoa ?? '').trim();
  const ten = String(x.ten ?? '').trim().replace(/\s+/g, ' ');
  if (!ma || ma.length > 30) throw new AppError('Mã hàng hóa bắt buộc, tối đa 30 ký tự', { status: 422, errorCode: 'MA_SAI' });
  if (!ten || ten.length > 255) throw new AppError('Tên kiếng bắt buộc, tối đa 255 ký tự', { status: 422, errorCode: 'TEN_SAI' });
  const dvt = String(x.dvt ?? '').trim().slice(0, 20) || null;
  const ghiChu = String(x.ghi_chu ?? '').trim().slice(0, 300) || null;
  return { ma_hang_hoa: ma, ten, dvt, ghi_chu: ghiChu, dang_hoat_dong: x.dang_hoat_dong !== false };
}

const giaTri = (r) => ({ ma_hang_hoa: r.ma_hang_hoa, ten: r.ten, dvt: r.dvt, dang_hoat_dong: r.dang_hoat_dong });

async function danhSach({ ca } = {}) { return repo.danhSach({ ca: !!ca }); }

async function them(body, actorId) {
  const d = chuanDong(body);
  if (await repo.theoMa(d.ma_hang_hoa)) throw new AppError(`Mã ${d.ma_hang_hoa} đã có trong danh mục`, { status: 409, errorCode: 'DA_CO' });
  const id = await repo.them(d, actorId);
  await repo.ghiVet(id, 'THEM_LOAI_KIENG', null, giaTri(d), actorId);
  return repo.danhSach({ ca: true });
}

async function sua(id, body, actorId) {
  if (!UUID_RE.test(String(id))) throw new AppError('Mã không hợp lệ', { status: 422, errorCode: 'ID_SAI' });
  const cu = await repo.theoId(id);
  if (!cu) throw new AppError('Không tìm thấy loại kiếng', { status: 404, errorCode: 'NOT_FOUND' });
  const d = chuanDong({ ...cu, ...body });
  const trung = await repo.theoMa(d.ma_hang_hoa);
  if (trung && trung.id !== cu.id) throw new AppError(`Mã ${d.ma_hang_hoa} đã có trong danh mục`, { status: 409, errorCode: 'DA_CO' });
  await repo.sua(id, d, actorId);
  await repo.ghiVet(id, 'SUA_LOAI_KIENG', giaTri(cu), giaTri(d), actorId);
  return repo.danhSach({ ca: true });
}

// Kiểm 2 ô kiếng của 1 lượt in tem. `can` = lệnh cần nhập kiếng. Trả { loaiKiengId, heSoKieng } (null khi không cần).
async function kiemKiengIn(can, body = {}) {
  if (!can) return { loaiKiengId: null, heSoKieng: null };
  const id = String(body.loaiKiengId || '').trim();
  if (!id) throw new AppError('Chọn loại kiếng trước khi in tem (hàng in kiếng)', { status: 422, errorCode: 'THIEU_LOAI_KIENG' });
  if (!UUID_RE.test(id)) throw new AppError('Loại kiếng không hợp lệ', { status: 422, errorCode: 'LOAI_KIENG_SAI' });
  const k = await repo.theoId(id);
  if (!k || !k.dang_hoat_dong) throw new AppError('Loại kiếng không có trong danh mục (hoặc đã ngưng dùng)', { status: 422, errorCode: 'LOAI_KIENG_SAI' });
  const heSo = Number(String(body.heSoKieng ?? '').replace(',', '.'));
  if (!(heSo > 0) || heSo > HE_SO_TOI_DA) {
    throw new AppError('Nhập hệ số kiếng (1 tấm kiếng chia được bao nhiêu phần, > 0)', { status: 422, errorCode: 'HE_SO_KIENG_SAI' });
  }
  return { loaiKiengId: k.id, heSoKieng: Math.round(heSo * 10000) / 10000 };
}

module.exports = { danhSach, them, sua, kiemKiengIn, soTamKieng, HE_SO_TOI_DA };
