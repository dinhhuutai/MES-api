'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// MẪU PHIẾU GỐC — dựng lại ĐÚNG phiếu giao đang in bằng bố cục cứng
// (`frontend/src/features/delivery/utils/printPhieuGiao.js`) để người dùng có bản mẫu mà bắt đầu sửa.
//
// ⚠ KHÔNG tự gắn vào vị trí in: gắn là ĐỔI BẢN IN THẬT, phải do người dùng bấm ở màn Thiết kế phiếu.
//   Chưa gắn ⇒ nút In phiếu giao vẫn dùng bố cục cứng, y hệt như trước.
// ⚠ Seed idempotent theo `ma_mau` (INSERT … ON CONFLICT DO NOTHING) — chạy lại không đẻ bản trùng.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Helper dựng ô/khung cho gọn ────────────────────────────────────────────
const chu = (s) => ({ loai: 'chu', gia_tri: s });
const truong = (ma, kieu, dinhDang) => ({
  loai: 'truong', ma, kieu: kieu || 'chu', ...(dinhDang ? { dinh_dang: dinhDang } : {}),
});

// Khối đầu/cuối phiếu mặc định KHÔNG kẻ viền (bộ render coi thiếu `vien` = CÓ viền, như bảng).
const KHONG_VIEN = { vien: { tren: false, duoi: false, trai: false, phai: false } };
const CO_VIEN = { vien: { tren: true, duoi: true, trai: true, phai: true } };

// `cells`: { '<cột>': ô }. Ô nào không khai = ô trống (vẫn vẽ, theo viền mặc định của khung).
function khung(soCot, cotRong, hangs) {
  const o = {};
  hangs.forEach((h, r) => {
    Object.entries(h.cells || {}).forEach(([c, cell]) => { o[`${r},${c}`] = cell; });
  });
  return {
    so_cot: soCot,
    cot: cotRong.map((w) => ({ rong_mm: w || null })),
    hang: hangs.map((h) => ({ cao_mm: h.cao || null })),
    o,
  };
}

const TIEU_DE = { co_chu_mm: 5, dam: true, ngang: 'center', ...KHONG_VIEN };
const NHAN = { co_chu_mm: 3.2, ngang: 'left', mau_chu: '#6b7280', ...KHONG_VIEN };
const GIA_TRI = { co_chu_mm: 3.2, dam: true, ngang: 'left', ...KHONG_VIEN };
const NHO = { co_chu_mm: 2.6, ngang: 'left', mau_chu: '#6b7280', ...KHONG_VIEN };
const TH = { co_chu_mm: 2.9, dam: true, ngang: 'center', nen: '#f3f4f6', ...CO_VIEN };
const TD = { co_chu_mm: 3, ngang: 'left', ...CO_VIEN };
const TD_SO = { co_chu_mm: 3, ngang: 'right', ...CO_VIEN };
const TD_GIUA = { co_chu_mm: 3, ngang: 'center', ...CO_VIEN };

// ─── ĐẦU PHIẾU (dùng chung 2 kiểu, chỉ khác dòng phụ đề) ────────────────────
const dauPhieu = (phuDe) => khung(
  12,
  [null, null, null, null, null, null, null, null, null, null, null, null],
  [
    { cao: 8, cells: {
      0: { ...TIEU_DE, co_chu_mm: 6, ngang: 'left', cs: 3, phan: [chu('THLA')] },
      3: { ...TIEU_DE, cs: 6, phan: [chu('PHIẾU GIAO HÀNG')] },
      9: { ...GIA_TRI, cs: 3, ngang: 'right', co_chu_mm: 3.6, phan: [truong('ma_phieu_giao')] },
    } },
    { cao: 5, cells: {
      0: { ...NHO, cs: 3, phan: [chu('Công ty Thuận Hưng Long An')] },
      3: { ...NHO, cs: 6, ngang: 'center', phan: [chu(phuDe)] },
      9: { ...NHO, cs: 3, ngang: 'right', phan: [truong('ngay_giao', 'ngay', 'DD/MM/YYYY')] },
    } },
    { cao: 3, cells: { 0: { ...KHONG_VIEN, cs: 12, phan: [] } } },
    { cao: 6, cells: {
      0: { ...NHAN, cs: 2, phan: [chu('Khách hàng')] },
      2: { ...GIA_TRI, cs: 4, phan: [truong('ten_khach_hang')] },
      6: { ...NHAN, cs: 2, phan: [chu('Đơn hàng')] },
      8: { ...GIA_TRI, cs: 4, phan: [truong('ma_don_hang')] },
    } },
    { cao: 6, cells: {
      0: { ...NHAN, cs: 2, phan: [chu('Số tem')] },
      2: { ...GIA_TRI, cs: 4, phan: [truong('so_tem', 'so')] },
      6: { ...NHAN, cs: 2, phan: [chu('Tổng SL giao')] },
      8: { ...GIA_TRI, cs: 4, phan: [truong('tong_sl', 'so')] },
    } },
    { cao: 6, cells: {
      0: { ...NHAN, cs: 2, phan: [chu('Ghi chú')] },
      2: { ...GIA_TRI, cs: 10, dam: false, phan: [truong('ghi_chu')] },
    } },
    { cao: 3, cells: { 0: { ...KHONG_VIEN, cs: 12, phan: [] } } },
  ]
);

// ─── CUỐI PHIẾU ─────────────────────────────────────────────────────────────
// `soCot`/`cotRong` lấy ĐÚNG của vùng lặp để dòng TỔNG CỘNG thẳng hàng với cột SL giao.
// `ghiChuSao`: dòng chú thích dấu * (chỉ kiểu GỘP mới cần).
const cuoiPhieu = (soCot, cotRong, ghiChuSao) => khung(soCot, cotRong, [
  { cao: 7, cells: {
    0: { ...CO_VIEN, co_chu_mm: 3.2, dam: true, ngang: 'right', nen: '#f9fafb', cs: soCot - 1, phan: [chu('TỔNG CỘNG')] },
    [soCot - 1]: { ...CO_VIEN, co_chu_mm: 3.2, dam: true, ngang: 'right', nen: '#f9fafb', phan: [truong('tong_sl', 'so')] },
  } },
  { cao: 6, cells: {
    0: { ...NHO, cs: soCot, phan: ghiChuSao ? [chu('* = trong nhóm có hàng đã qua SỬA (tem 17)')] : [] },
  } },
  { cao: 6, cells: {
    0: { ...KHONG_VIEN, co_chu_mm: 3.2, ngang: 'center', cs: Math.ceil(soCot / 3), phan: [chu('Người giao')] },
    [Math.ceil(soCot / 3)]: { ...KHONG_VIEN, co_chu_mm: 3.2, ngang: 'center', cs: Math.ceil(soCot / 3), phan: [chu('Người vận chuyển')] },
    [Math.ceil(soCot / 3) * 2]: { ...KHONG_VIEN, co_chu_mm: 3.2, ngang: 'center', cs: soCot - Math.ceil(soCot / 3) * 2, phan: [chu('Người nhận')] },
  } },
  { cao: 20, cells: { 0: { ...KHONG_VIEN, cs: soCot, phan: [] } } },
  { cao: 5, cells: {
    0: { ...NHO, ngang: 'center', cs: Math.ceil(soCot / 3), phan: [chu('(Ký, ghi rõ họ tên)')] },
    [Math.ceil(soCot / 3)]: { ...NHO, ngang: 'center', cs: Math.ceil(soCot / 3), phan: [chu('(Ký, ghi rõ họ tên)')] },
    [Math.ceil(soCot / 3) * 2]: { ...NHO, ngang: 'center', cs: soCot - Math.ceil(soCot / 3) * 2, phan: [chu('(Ký, ghi rõ họ tên)')] },
  } },
  { cao: 5, cells: {
    0: { ...NHO, ngang: 'right', cs: soCot, phan: [chu('In lúc '), truong('ngay_in', 'ngay', 'DD/MM/YYYY HH:mm')] },
  } },
]);

// ─── KIỂU CHI TIẾT: 1 dòng = 1 tem ──────────────────────────────────────────
const COT_CT = [10, 30, null, 28, 22, 28, 14, 20];
const lapChiTiet = () => khung(8, COT_CT, [
  { cao: 7, cells: {
    0: { ...TH, phan: [chu('TT')] },
    1: { ...TH, phan: [chu('Mã tem')] },
    2: { ...TH, phan: [chu('Code phần')] },
    3: { ...TH, phan: [chu('Mã hàng')] },
    4: { ...TH, phan: [chu('Màu vải')] },
    5: { ...TH, phan: [chu('Kích vải / phim')] },
    6: { ...TH, phan: [chu('Nguồn')] },
    7: { ...TH, phan: [chu('SL giao')] },
  } },
  { cao: 6, cells: {
    0: { ...TD_GIUA, phan: [truong('stt', 'so')] },
    1: { ...TD, phan: [truong('ma_tem')] },
    2: { ...TD, phan: [truong('phan_list')] },
    3: { ...TD, phan: [truong('ma_hang')] },
    4: { ...TD, phan: [truong('mau_vai')] },
    5: { ...TD, phan: [truong('kich_vai_phim')] },
    6: { ...TD_GIUA, phan: [truong('nguon')] },
    7: { ...TD_SO, phan: [truong('so_luong_giao', 'so')] },
  } },
]);

// ─── KIỂU GỘP: cùng code phần thì cộng SL ───────────────────────────────────
const COT_GOP = [10, null, 30, 24, 30, 16, 22];
const lapGop = () => khung(7, COT_GOP, [
  { cao: 7, cells: {
    0: { ...TH, phan: [chu('TT')] },
    1: { ...TH, phan: [chu('Code phần')] },
    2: { ...TH, phan: [chu('Mã hàng')] },
    3: { ...TH, phan: [chu('Màu vải')] },
    4: { ...TH, phan: [chu('Kích vải / phim')] },
    5: { ...TH, phan: [chu('Số tem')] },
    6: { ...TH, phan: [chu('SL giao')] },
  } },
  { cao: 6, cells: {
    0: { ...TD_GIUA, phan: [truong('stt', 'so')] },
    1: { ...TD, phan: [truong('phan_list')] },
    2: { ...TD, phan: [truong('ma_hang')] },
    3: { ...TD, phan: [truong('mau_vai')] },
    4: { ...TD, phan: [truong('kich_vai_phim')] },
    5: { ...TD_GIUA, phan: [truong('so_tem_gop', 'so'), truong('co_sua')] },
    6: { ...TD_SO, phan: [truong('so_luong_giao', 'so')] },
  } },
]);

const MAU_GOC_PHIEU = [
  {
    ma_mau: 'PHIEU_GIAO_CT',
    ten_mau: 'Phiếu giao hàng — CHI TIẾT (mẫu gốc)',
    mo_ta: 'Dựng lại đúng phiếu A4 dọc đang in: 1 dòng = 1 tem, có 3 ô ký.',
    bo_cuc: {
      v: 1, kho: 'A4', huong: 'doc', le: { tren: 12, phai: 10, duoi: 12, trai: 10 },
      dau: dauPhieu('Bản CHI TIẾT theo từng tem'),
      lap: lapChiTiet(),
      cuoi: cuoiPhieu(8, COT_CT, false),
    },
  },
  {
    ma_mau: 'PHIEU_GIAO_GOP',
    ten_mau: 'Phiếu giao hàng — GỘP theo code phần (mẫu gốc)',
    mo_ta: 'Dựng lại đúng phiếu A4 dọc đang in: cùng code phần thì cộng SL thành 1 dòng.',
    bo_cuc: {
      v: 1, kho: 'A4', huong: 'doc', le: { tren: 12, phai: 10, duoi: 12, trai: 10 },
      dau: dauPhieu('Bản GỘP theo code phần'),
      lap: lapGop(),
      cuoi: cuoiPhieu(7, COT_GOP, true),
    },
  },
];

module.exports = { MAU_GOC_PHIEU };
