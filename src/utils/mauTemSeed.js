'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SEED 4 MẪU TEM GỐC — dựng lại bố cục ĐANG CHẠY trong `frontend/.../printTemLabel.js`
// thành dữ liệu lưới để người dùng sửa được trên giao diện (mig 073).
//
// ⚠ Vì sao dùng LƯỚI ĐỀU thay vì bảng xếp chồng như bản cũ: người dùng muốn thao tác kiểu Excel
//   (bao nhiêu hàng/cột · gộp · tách). Bản cũ là 4 bảng chồng nhau, mỗi bảng một kiểu chia cột —
//   không "gộp/tách" được. Chọn số cột là BỘI CHUNG của các tiết diện để gộp lại ra đúng khổ cũ:
//     · Tem trái  → 20 cột (49mm / 20 = 2.45mm): tiết diện 4 phần = 5 cột/phần, 2 phần = 10 cột.
//     · Tem phải  → 20 cột: lưới kiểm 5 phần = 4 cột/phần, phần thân 4 phần = 5 cột/phần.
//   Vài mốc lệch ≤ 1.2mm so với bản cũ (vd cột nhãn 9mm → 9.8mm) — mắt thường không thấy, và giờ
//   người dùng kéo lại được bề rộng cột.
//
// ⚠⚠ SEED KHÔNG TỰ ĐỔI BẢN IN: 4 nút in vẫn chạy bố cục CỨNG cho tới khi người dùng GẮN mẫu vào
//   vị trí in (bảng `gan_mau_tem`). Xem `printTemLabel.js` — không có mẫu thì lùi về bản cũ.
// ─────────────────────────────────────────────────────────────────────────────

const { TRUONG_TEM } = require('./mauTem');

const SO_COT = 20;                  // lưới chuẩn cho cả 4 mẫu
const P = (n) => SO_COT / n;        // số cột cho 1 phần khi chia lưới thành n phần bằng nhau

// `kieu` (chu|so|ngay) LƯU THẲNG vào mảnh trường ⇒ bộ render FE tự đủ, không phải tra danh mục.
const kieuCua = (ma) => (TRUONG_TEM.find((t) => t.ma === ma) || {}).kieu || 'chu';
const truong = (ma, dinhDang) => ({ loai: 'truong', ma, kieu: kieuCua(ma), ...(dinhDang ? { dinh_dang: dinhDang } : {}) });

// Ô chữ cố định (nhãn): nền xám, đậm, canh trái, 1 dòng.
const L = (chu, cs) => ({ phan: [{ loai: 'chu', gia_tri: chu }], cs, dam: true, nen: '#f1f1f1', ngang: 'left', co_chu_mm: 2.2, xuong_dong: false });
// Ô giá trị (1 trường dữ liệu): đậm, canh giữa, tự co cho vừa ô.
const V = (ma, cs, them) => {
  const { dinh_dang: dd, ...rest } = them || {};
  return { phan: [truong(ma, dd)], cs, dam: true, ngang: 'center', co_chu_mm: 2.4, tu_co: true, ...rest };
};
// Ô trống để ghi tay.
const B = (cs) => ({ phan: [], cs });
// Ô chữ thường (tiêu đề / mã form).
const T = (chu, cs, them) => ({ phan: [{ loai: 'chu', gia_tri: chu }], cs, ngang: 'center', co_chu_mm: 2.2, ...them });

// Gom danh sách ô của 1 hàng thành object khóa "<r>,<c>" — tự cộng dồn cột theo `cs`.
function hangO(r, oList, o) {
  let c = 0;
  for (const cell of oList) {
    const cs = Math.max(1, Number(cell.cs) || 1);
    o[`${r},${c}`] = { ...cell, cs };
    c += cs;
  }
  return c;
}

// Dựng 1 khung từ mảng hàng: mỗi phần tử = { cao, o: [ô…] }.
function dungKhung(dsHang) {
  const o = {};
  dsHang.forEach((h, r) => hangO(r, h.o, o));
  return {
    so_cot: SO_COT,
    hang: dsHang.map((h) => ({ cao_mm: h.cao == null ? null : h.cao })),
    cot: Array.from({ length: SO_COT }, () => ({ rong_mm: null })), // null = chia đều 49mm
    o,
  };
}

// ─── Đầu tem: THLA | <tiêu đề> | ngày giờ in ────────────────────────────────
// Bản cũ: brand 8mm | title 28mm | dt 13mm  →  20 cột: 3 | 12 | 5 (7.35 | 29.4 | 12.25 mm)
const hangDau = (tieuDe) => ({
  cao: 4,
  o: [
    T('THLA', 3, { dam: true }),
    T(tieuDe, 12, { dam: true, co_chu_mm: 2.8 }),
    V('created_date', 5, { dam: false, co_chu_mm: 1.9, dinh_dang: 'DD/MM/YY HH:mm' }),
  ],
});

// ─── Băng QR: QR + mã tem bên trái, phần còn lại để trống ───────────────────
// Bản cũ: ô QR rộng 20mm → 20 cột: 8 (19.6mm).
const hangQr = () => ({
  cao: 16,
  o: [
    { kieu: 'qr', ma_qr: 'ma_tem', cs: 8, hien_ma: true, co_chu_mm: 2.2 },
    B(12),
  ],
});

// ═══════════════════════════════════════════════════════════════════════════
// 1) TEM TRÁI — PHIẾU GIAO HÀNG (form 104-THLA-CM I-011 B3)
//    Bản cũ chia 4 phần: 9mm | 11.5 | 11.5 | 17  →  20 cột: 4 | 6 | 6 | 4 (gần đúng, lệch ≤1.2mm)
// ═══════════════════════════════════════════════════════════════════════════
const khungPhieuGiaoHang = (tieuDe = 'PHIẾU GIAO HÀNG', maForm = '104-THLA-CM I-011 B3') => dungKhung([
  hangDau(tieuDe),
  hangQr(),
  { cao: 3.4, o: [V('ten_khach_hang', 14), V('ma_chuyen', 6)] },
  { cao: 3.4, o: [L('PO', 4), V('ma_don_hang', 16)] },
  { cao: 3.4, o: [L('MH', 4), V('ma_hang', 16)] },
  { cao: 3.4, o: [L('MV', 4), V('mau_vai', 16)] },
  { cao: 3.4, o: [L('KV', 4), V('kich_vai', 16)] },
  { cao: 3.4, o: [L('KP', 4), V('kich_phim', 16)] },
  {
    cao: 3.4,
    o: [
      V('so_luong_don_hang', 10, { co_chu_mm: 3 }),
      // Bản cũ ghép "bắt đầu phơi - phơi xong" trong 1 ô, chữ nhỏ 1 dòng.
      {
        cs: 10, dam: true, ngang: 'center', co_chu_mm: 1.8, xuong_dong: false, tu_co: true,
        // ⚠ Dùng helper `truong()` chứ ĐỪNG khai tay object: helper gắn kèm `kieu` (ngay/so/chu) —
        // thiếu nó thì lúc in ra chuỗi ISO thô thay vì ngày đã định dạng (đã mắc thật khi làm seed này).
        phan: [
          truong('tg_bd_phoi', 'DD/MM HH:mm'),
          { loai: 'chu', gia_tri: ' - ' },
          truong('tg_kt_phoi', 'DD/MM HH:mm'),
        ],
      },
    ],
  },
  { cao: 3.4, o: [L('IN', 4), V('so_luong', 11, { co_chu_mm: 3 }), V('ca', 5)] },
  // 4 hàng ghi tay — bản cũ giãn ra lấp phần trống (cao_mm null = tự giãn).
  { cao: null, o: [L('Lo', 5), B(5), B(5), B(5)] },
  { cao: null, o: [L('SL Giao', 5), B(5), B(5), B(5)] },
  { cao: null, o: [L('KCS', 5), B(5), B(5), B(5)] },
  { cao: null, o: [L('N Kiểm', 5), B(5), B(5), B(5)] },
  {
    cao: 2.6,
    o: [T(maForm, 20, {
      ngang: 'right', co_chu_mm: 1.8,
      vien: { tren: false, duoi: false, trai: false, phai: false },
    })],
  },
]);

// ═══════════════════════════════════════════════════════════════════════════
// 2) TEM PHẢI — IN-K / lưới kiểm (form 104-THLA-CM I-011 B2)
//    Thân chia 4 phần = 5 cột/phần; lưới kiểm 5 phần = 4 cột/phần.
// ═══════════════════════════════════════════════════════════════════════════
const TH = (chu) => ({ phan: [{ loai: 'chu', gia_tri: chu }], cs: P(5), dam: true, nen: '#f1f1f1', ngang: 'center', co_chu_mm: 2.2 });

const khungInK = () => dungKhung([
  hangDau('IN-K'),
  hangQr(),
  { cao: 3.4, o: [V('ten_khach_hang', 10), V('ma_don_hang', 10)] },
  { cao: 3.4, o: [V('ma_hang', 20)] },
  { cao: 3.4, o: [V('mau_vai', 20)] },
  { cao: 3.4, o: [V('kich_vai', 10), V('kich_phim', 10)] },
  { cao: 3.4, o: [V('so_luong_don_hang', 10, { co_chu_mm: 3 }), V('ma_chuyen', 5), V('ca', 5)] },
  { cao: 4.4, o: [TH('IN'), TH('KIỂM'), TH('ĐẠT'), TH('SỬA'), TH('HỦY')] },
  { cao: 4.4, o: [V('so_luong', 4, { co_chu_mm: 3 }), B(4), B(4), B(4), B(4)] },
  { cao: 4.4, o: [L('LOẠI LỖI', 8), L('SL', 4), L('S.ĐẠT', 4), L('S.HỦY', 4)] },
  { cao: null, o: [B(8), B(4), B(4), B(4)] },
  { cao: null, o: [B(8), B(4), B(4), B(4)] },
  {
    cao: 2.6,
    o: [T('104-THLA-CM I-011 B2', 20, {
      ngang: 'right', co_chu_mm: 1.8,
      vien: { tren: false, duoi: false, trai: false, phai: false },
    })],
  },
]);

// ═══════════════════════════════════════════════════════════════════════════
// 4 MẪU GỐC — khớp `mau_goc` của từng vị trí in (utils/mauTem.js VI_TRI_IN)
// `phai: null` = in 2 nhãn GIỐNG hệt nhau (chỉ thiết kế khung trái).
// ═══════════════════════════════════════════════════════════════════════════
const MAU_GOC = [
  {
    ma_mau: 'TEM_SX', ten_mau: 'Tem sản xuất (PHIẾU GIAO HÀNG + IN-K)',
    mo_ta: 'Nhãn trái = tem 15 PHIẾU GIAO HÀNG · nhãn phải = tem 16 IN-K (lưới kiểm). Dùng cho nút In tem ở màn Sản xuất.',
    bo_cuc: { v: 1, trai: khungPhieuGiaoHang(), phai: khungInK() },
  },
  {
    ma_mau: 'TEM_KCS_GIAO', ten_mau: 'Tem KCS giao (2 nhãn giống nhau)',
    mo_ta: 'Tem 15 — layout PHIẾU GIAO HÀNG, dòng IN = SL đã kiểm. In 2 nhãn giống hệt nhau.',
    bo_cuc: { v: 1, trai: khungPhieuGiaoHang(), phai: null },
  },
  {
    ma_mau: 'TEM_OQC_SUA', ten_mau: 'Tem OQC sau sửa (2 nhãn giống nhau)',
    mo_ta: 'Tem 17 — layout PHIẾU GIAO HÀNG, SL = sửa đạt. In 2 nhãn giống hệt nhau.',
    bo_cuc: { v: 1, trai: khungPhieuGiaoHang(), phai: null },
  },
  {
    ma_mau: 'TEM_GIA_CONG', ten_mau: 'Tem gia công về "TH VỀ" (2 nhãn giống nhau)',
    mo_ta: 'Tem 13 — layout PHIẾU GIAO HÀNG nhưng tiêu đề đổi thành "TH VỀ". In 2 nhãn giống hệt nhau.',
    bo_cuc: { v: 1, trai: khungPhieuGiaoHang('TH VỀ'), phai: null },
  },
];

module.exports = { MAU_GOC, SO_COT };
