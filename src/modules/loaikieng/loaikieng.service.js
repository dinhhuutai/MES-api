'use strict';

const AppError = require('../../utils/AppError');
const repo = require('./loaikieng.repository');

// ─────────────────────────────────────────────────────────────────────────────
// DANH MỤC KIẾNG + LUẬT 3 Ô KIẾNG KHI IN TEM (mig 126 + 127) — khớp 3 tham số proc ERP `MES_spr_MES2SF0`:
//   · Loại kiếng   ⇒ `@pKieng nvarchar(20)` = mã hàng hóa ERP của loại kiếng (danh mục ⇒ mã tối đa 20 ký tự).
//   · Hệ số kiếng  ⇒ `@pHsKieng int` = 1 tấm kiếng chia được bao nhiêu phần — SỐ NGUYÊN ≥ 1.
//   · SL kiếng     ⇒ `@pSoluongKieng int` = số lượng kiếng NGƯỜI IN NHẬP cho TỪNG TEM (số nguyên ≥ 0, bắt buộc nhập).
//   · NGƯỜI IN TỰ NHẬP CẢ 3 Ô — không gợi ý, không điền sẵn từ lần in trước (10/11/2026, người dùng chốt).
//   · Bắt buộc ở tem công đoạn IN của phần in luồng IN_KIENG (`utils/luongSanXuat.canNhapKieng`), MỌI đường in: tem lẻ ·
//     ô "Số tem" · gom set (mỗi dòng 1 bộ) · In tem nhiều phần in (mỗi dòng 1 bộ).
// ─────────────────────────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HE_SO_TOI_DA = 100000;
const SL_KIENG_TOI_DA = 1000000;
const MA_TOI_DA = 20; // @pKieng nvarchar(20)

// ⌈SL ÷ hệ số⌉ — CHỈ để lùi khi gửi ERP tem chưa lưu SL kiếng (in trước mig 127), không hiện cho người dùng.
const soTamKieng = (soLuong, heSo) => {
  const h = Number(heSo);
  return h > 0 ? Math.ceil((Number(soLuong) || 0) / h) : null;
};

// Chuỗi số nguyên không âm ('12', ' 12 ') ⇒ số; còn lại ⇒ NaN ('12.5', '1,5', '', 'abc').
const soNguyenChuoi = (v) => {
  const s = String(v ?? '').trim();
  return /^\d+$/.test(s) ? Number(s) : NaN;
};

function chuanDong(x = {}) {
  const ma = String(x.ma_hang_hoa ?? '').trim();
  const ten = String(x.ten ?? '').trim().replace(/\s+/g, ' ');
  if (!ma || ma.length > MA_TOI_DA) throw new AppError(`Mã hàng hóa bắt buộc, tối đa ${MA_TOI_DA} ký tự (ERP nhận tối đa ${MA_TOI_DA})`, { status: 422, errorCode: 'MA_SAI' });
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

// Kiểm 3 ô kiếng của 1 TEM (hoặc 1 dòng bảng in nhiều tem). `can` = lệnh cần nhập kiếng. `src` = { loaiKiengId,
//   heSoKieng, slKieng }. `nhan` = tên dòng gắn vào thông báo lỗi (bảng nhiều dòng). `nho` = Map id → loại kiếng đã đọc
//   trong lượt (đỡ đọc lại khi nhiều dòng cùng loại). Trả { loaiKiengId, heSoKieng, slKieng } (null hết khi không cần).
async function kiemKiengIn(can, src = {}, { nhan = '', nho = null } = {}) {
  if (!can) return { loaiKiengId: null, heSoKieng: null, slKieng: null };
  const truoc = nhan ? `${nhan}: ` : '';
  const id = String(src.loaiKiengId || '').trim();
  if (!id) throw new AppError(`${truoc}Chọn loại kiếng trước khi in tem (hàng in kiếng)`, { status: 422, errorCode: 'THIEU_LOAI_KIENG' });
  if (!UUID_RE.test(id)) throw new AppError(`${truoc}Loại kiếng không hợp lệ`, { status: 422, errorCode: 'LOAI_KIENG_SAI' });
  let k = nho ? nho.get(id) : undefined;
  if (k === undefined) { k = await repo.theoId(id); if (nho) nho.set(id, k); }
  if (!k || !k.dang_hoat_dong) throw new AppError(`${truoc}Loại kiếng không có trong danh mục (hoặc đã ngưng dùng)`, { status: 422, errorCode: 'LOAI_KIENG_SAI' });
  const heSo = soNguyenChuoi(src.heSoKieng);
  if (!(heSo >= 1) || heSo > HE_SO_TOI_DA) {
    throw new AppError(`${truoc}Nhập hệ số kiếng — số nguyên ≥ 1 (1 tấm kiếng chia được bao nhiêu phần)`, { status: 422, errorCode: 'HE_SO_KIENG_SAI' });
  }
  const sl = soNguyenChuoi(src.slKieng);
  if (!(sl >= 0) || sl > SL_KIENG_TOI_DA) {
    throw new AppError(`${truoc}Nhập số lượng kiếng — số nguyên ≥ 0`, { status: 422, errorCode: 'SL_KIENG_SAI' });
  }
  return { loaiKiengId: k.id, heSoKieng: heSo, slKieng: sl };
}

module.exports = { danhSach, them, sua, kiemKiengIn, soTamKieng, HE_SO_TOI_DA, MA_TOI_DA };
