'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// MẪU PHIẾU — danh mục VỊ TRÍ IN + TRƯỜNG DỮ LIỆU + KHỔ GIẤY + hình dạng `bo_cuc_json` (mig 094).
//
// ⚠ Danh mục nằm ở CODE, không ở DB: thêm nút in phiếu mới / trường dữ liệu mới chỉ cần khai thêm ở
//   đây rồi gắn mẫu trên giao diện — KHÔNG cần migration (cùng khuôn `utils/mauTem.js`).
// ⚠ FE gương lại danh mục này qua API `GET /mau-phieu/danh-muc` (không chép cứng sang FE — chép là
//   sớm muộn 2 bên lệch nhau).
//
// ⚠⚠ KHÁC MẪU TEM MỘT ĐIỂM CỐT TỬ: phiếu có **VÙNG LẶP DÒNG**. Tem là lưới ô cố định, còn phiếu giao
//   có bảng chi tiết lặp N dòng theo số tem ⇒ `bo_cuc_json` chia 3 khối `dau` / `lap` / `cuoi`.
//   Xem mô tả hình dạng ở cuối file.
// ─────────────────────────────────────────────────────────────────────────────

// ─── KHỔ GIẤY ───────────────────────────────────────────────────────────────
// Người dùng chọn được (khác tem — tem CỐ ĐỊNH 110×80mm). Kích thước theo chuẩn ISO 216.
const KHO_GIAY = Object.freeze([
  { ma: 'A4', ten: 'A4 (210 × 297mm)', rong_mm: 210, cao_mm: 297 },
  { ma: 'A5', ten: 'A5 (148 × 210mm)', rong_mm: 148, cao_mm: 210 },
]);
const HUONG = Object.freeze([
  { ma: 'doc', ten: 'Dọc (portrait)' },
  { ma: 'ngang', ten: 'Ngang (landscape)' },
]);
const LE_MAC_DINH = Object.freeze({ tren: 12, phai: 10, duoi: 12, trai: 10 });

const timKho = (ma) => KHO_GIAY.find((k) => k.ma === ma) || KHO_GIAY[0];

// Bề rộng / chiều cao VÙNG NỘI DUNG (đã trừ lề) — dùng để chia cột "tự chia" và cảnh báo vượt khổ.
function vungNoiDung(boCuc) {
  const kho = timKho(boCuc && boCuc.kho);
  const ngang = (boCuc && boCuc.huong) === 'ngang';
  const le = { ...LE_MAC_DINH, ...((boCuc && boCuc.le) || {}) };
  const rongGiay = ngang ? kho.cao_mm : kho.rong_mm;
  const caoGiay = ngang ? kho.rong_mm : kho.cao_mm;
  return {
    rong: Math.max(10, rongGiay - (Number(le.trai) || 0) - (Number(le.phai) || 0)),
    cao: Math.max(10, caoGiay - (Number(le.tren) || 0) - (Number(le.duoi) || 0)),
    rongGiay,
    caoGiay,
    le,
  };
}

// ─── VỊ TRÍ IN (nút in phiếu trong app) ─────────────────────────────────────
// ⚠ 2 vị trí RIÊNG cho 2 kiểu in (người dùng chốt 04/09/2026): CHI TIẾT 1 dòng/tem · GỘP theo code
//   phần. Tách riêng vì BỘ CỘT của bảng chi tiết khác hẳn nhau (kiểu gộp không có mã tem/nguồn, đổi
//   lại có "Số tem gộp") — nhét chung 1 mẫu thì một trong hai kiểu luôn có cột rỗng.
const VI_TRI_IN_PHIEU = Object.freeze([
  {
    ma: 'GH_PHIEU_GIAO_CT', ten: 'Giao hàng — Phiếu giao (CHI TIẾT)', mau_goc: 'PHIEU_GIAO_CT',
    mo_ta: 'Nút "In phiếu (chi tiết)" ở màn Danh sách tem giao + "In chi tiết" ở panel/sidebar — 1 dòng = 1 tem',
    man_hinh: 'Giao hàng > Danh sách tem giao', kieu: 'CHI_TIET',
  },
  {
    ma: 'GH_PHIEU_GIAO_GOP', ten: 'Giao hàng — Phiếu giao (GỘP)', mau_goc: 'PHIEU_GIAO_GOP',
    mo_ta: 'Nút "In phiếu (gộp theo phần in)" — cùng code phần thì cộng SL thành 1 dòng',
    man_hinh: 'Giao hàng > Danh sách tem giao', kieu: 'GOP',
  },
]);

// ─── TRƯỜNG DỮ LIỆU ─────────────────────────────────────────────────────────
// ⚠⚠ HAI PHẠM VI KHÁC NHAU, ĐỪNG LẪN:
//   · `TRUONG_PHIEU`     — thuộc CẢ PHIẾU, đặt được ở khối `dau` và `cuoi`.
//   · `TRUONG_DONG_PHIEU`— thuộc TỪNG DÒNG của bảng chi tiết, CHỈ có nghĩa trong khối `lap`.
//   Đặt nhầm phạm vi thì ô ra RỖNG (bộ render không tìm thấy khóa) — `kiemBoCuc` chặn sẵn.
// `kieu`: 'chu' | 'so' | 'ngay' — quyết định ô Định dạng nào hiện ra ở panel thiết kế.
const TRUONG_PHIEU = Object.freeze([
  { ma: 'ma_phieu_giao', ten: 'Mã phiếu giao', kieu: 'chu', nhom: 'Phiếu' },
  { ma: 'ngay_giao', ten: 'Ngày giao', kieu: 'ngay', nhom: 'Phiếu' },
  { ma: 'ngay_lap', ten: 'Ngày lập phiếu', kieu: 'ngay', nhom: 'Phiếu' },
  { ma: 'ngay_in', ten: 'Ngày giờ IN phiếu', kieu: 'ngay', nhom: 'Phiếu' },
  { ma: 'ghi_chu', ten: 'Ghi chú phiếu', kieu: 'chu', nhom: 'Phiếu' },
  { ma: 'kieu_in', ten: 'Kiểu in (Chi tiết / Gộp)', kieu: 'chu', nhom: 'Phiếu' },

  { ma: 'ten_khach_hang', ten: 'Khách hàng', kieu: 'chu', nhom: 'Đơn hàng' },
  { ma: 'ma_don_hang', ten: 'Đơn hàng (PO)', kieu: 'chu', nhom: 'Đơn hàng' },

  { ma: 'so_tem', ten: 'Tổng số tem', kieu: 'so', nhom: 'Tổng' },
  { ma: 'so_dong', ten: 'Số dòng bảng chi tiết', kieu: 'so', nhom: 'Tổng' },
  { ma: 'tong_sl', ten: 'Tổng SL giao', kieu: 'so', nhom: 'Tổng' },
]);

const TRUONG_DONG_PHIEU = Object.freeze([
  { ma: 'stt', ten: 'STT dòng', kieu: 'so', nhom: 'Dòng' },
  { ma: 'ma_tem', ten: 'Mã tem (đã gắn tiền tố)', kieu: 'chu', nhom: 'Dòng' },
  { ma: 'nguon', ten: 'Nguồn (KCS / Sửa)', kieu: 'chu', nhom: 'Dòng' },
  { ma: 'phan_list', ten: 'Code phần', kieu: 'chu', nhom: 'Dòng' },
  { ma: 'ma_hang', ten: 'Mã hàng', kieu: 'chu', nhom: 'Dòng' },
  { ma: 'mau_vai', ten: 'Màu vải', kieu: 'chu', nhom: 'Dòng' },
  { ma: 'kich_vai', ten: 'Kích vải', kieu: 'chu', nhom: 'Dòng' },
  { ma: 'kich_phim', ten: 'Kích phim', kieu: 'chu', nhom: 'Dòng' },
  { ma: 'kich_vai_phim', ten: 'Kích vải / phim (ghép sẵn)', kieu: 'chu', nhom: 'Dòng' },
  { ma: 'ma_lenh_san_xuat', ten: 'Mã đợt SX', kieu: 'chu', nhom: 'Dòng' },
  { ma: 'so_luong_giao', ten: 'SL giao của dòng', kieu: 'so', nhom: 'Dòng' },
  // CHỈ có nghĩa ở kiểu in GỘP (nhiều tem cùng code phần dồn thành 1 dòng).
  { ma: 'so_tem_gop', ten: 'Số tem trong dòng (kiểu GỘP)', kieu: 'so', nhom: 'Dòng' },
  { ma: 'co_sua', ten: 'Dòng có hàng qua sửa (* / rỗng)', kieu: 'chu', nhom: 'Dòng' },
]);

// Định dạng ngày chọn được — GIỮ GIỐNG mẫu tem để 2 trình thiết kế không lệch nhau.
const DINH_DANG_NGAY = Object.freeze([
  { ma: 'DD/MM/YYYY', ten: '31/12/2026' },
  { ma: 'DD/MM/YYYY HH:mm', ten: '31/12/2026 14:05' },
  { ma: 'DD/MM/YY HH:mm', ten: '31/12/26 14:05' },
  { ma: 'DD/MM/YY', ten: '31/12/26' },
  { ma: 'DD/MM', ten: '31/12' },
  { ma: 'HH:mm', ten: '14:05' },
]);

const MA_VI_TRI_PHIEU = VI_TRI_IN_PHIEU.map((v) => v.ma);
const timViTriPhieu = (ma) => VI_TRI_IN_PHIEU.find((v) => v.ma === ma) || null;
const laTruongPhieu = (ma) => TRUONG_PHIEU.some((t) => t.ma === ma);
const laTruongDong = (ma) => TRUONG_DONG_PHIEU.some((t) => t.ma === ma);

// ─────────────────────────────────────────────────────────────────────────────
// HÌNH DẠNG `bo_cuc_json` (phiên bản 1)
//
// { v: 1,
//   kho:   'A4' | 'A5',
//   huong: 'doc' | 'ngang',
//   le:    { tren, phai, duoi, trai },          // mm
//   dau:   <KHUNG>,                              // đầu phiếu — lưới ô tự do
//   lap:   <KHUNG với ĐÚNG 2 HÀNG>,              // hàng 0 = tiêu đề cột · hàng 1 = mẫu 1 dòng dữ liệu
//   cuoi:  <KHUNG>                               // cuối phiếu — tổng cộng, ô ký…
// }
//
// KHUNG = { so_cot, hang: [{ cao_mm }], cot: [{ rong_mm }], o: { "<r>,<c>": <Ô> } }
// Ô — DÙNG CHUNG hình dạng với mẫu tem (`utils/mauTem.js`), trừ 2 điểm:
//   · KHÔNG có ô QR/mã vạch (phiếu A4 không cần; muốn thêm thì mở ở bộ render trước).
//   · `phan[].ma` ở khối `lap` phải là TRƯỜNG DÒNG, ở `dau`/`cuoi` phải là TRƯỜNG PHIẾU.
//
// ⚠ `cao_mm` của hàng: phiếu KHÔNG có "chia đều phần trống" như tem (chiều cao trang thay đổi theo số
//   dòng) ⇒ hàng thiếu `cao_mm` được bộ render cho chiều cao mặc định. Bề rộng cột thì vẫn chia đều
//   phần còn lại như tem.
// ─────────────────────────────────────────────────────────────────────────────

const BO_CUC_PHIEU_V = 1;
const khoaO = (r, c) => `${r},${c}`;

// Kiểm bố cục TRƯỚC KHI LƯU — chặn dữ liệu rác làm hỏng bản in. Trả mảng lỗi (rỗng = hợp lệ).
// Cố ý KHÔNG tự sửa: sai thì báo để người dùng biết.
function kiemBoCucPhieu(boCuc) {
  const loi = [];
  if (!boCuc || typeof boCuc !== 'object') return ['Bố cục trống'];
  if (boCuc.kho && !KHO_GIAY.some((k) => k.ma === boCuc.kho)) loi.push(`Khổ giấy "${boCuc.kho}" không có thật`);
  if (boCuc.huong && !HUONG.some((h) => h.ma === boCuc.huong)) loi.push(`Hướng giấy "${boCuc.huong}" không có thật`);

  // `laDong` = khối này dùng TRƯỜNG DÒNG (khối `lap`) hay TRƯỜNG PHIẾU (`dau`/`cuoi`).
  const kiemKhung = (k, ten, laDong) => {
    if (!k) return;
    const soCot = Number(k.so_cot);
    // Trần 24 cột: khớp trần của trình thiết kế tem để 2 màn dùng chung được thao tác lưới.
    if (!Number.isInteger(soCot) || soCot < 1 || soCot > 24) { loi.push(`${ten}: số cột phải 1–24`); return; }
    const soHang = Array.isArray(k.hang) ? k.hang.length : 0;
    if (soHang < 1 || soHang > 60) { loi.push(`${ten}: số hàng phải 1–60`); return; }
    // ⚠ VÙNG LẶP BẮT BUỘC ĐÚNG 2 HÀNG — bộ render lấy hàng 0 làm <thead> và NHÂN hàng 1 theo số dòng
    //   dữ liệu. 3 hàng trở lên thì không biết hàng nào là mẫu để nhân.
    if (laDong && soHang !== 2) loi.push(`${ten}: phải có ĐÚNG 2 hàng (hàng 1 = tiêu đề cột, hàng 2 = mẫu dòng dữ liệu)`);

    const o = k.o && typeof k.o === 'object' ? k.o : {};
    const chiem = new Set();
    for (const [key, val] of Object.entries(o)) {
      const [r, c] = String(key).split(',').map(Number);
      if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0 || r >= soHang || c >= soCot) {
        loi.push(`${ten}: ô "${key}" nằm ngoài lưới`); continue;
      }
      const cs = Math.max(1, Number(val.cs) || 1);
      const rs = Math.max(1, Number(val.rs) || 1);
      if (c + cs > soCot || r + rs > soHang) { loi.push(`${ten}: ô "${key}" gộp tràn ra ngoài lưới`); continue; }
      for (let i = r; i < r + rs; i += 1) {
        for (let j = c; j < c + cs; j += 1) {
          const kk = khoaO(i, j);
          if (chiem.has(kk)) loi.push(`${ten}: ô "${kk}" bị gộp chồng lấn`);
          chiem.add(kk);
        }
      }
      // ⚠⚠ Ô gộp DỌC trong vùng lặp sẽ nối tiêu đề với mẫu dòng ⇒ khi nhân dòng ra thì rowspan
      //   trỏ vào chỗ không còn tồn tại. Chặn ngay lúc lưu.
      if (laDong && rs > 1) loi.push(`${ten}: ô "${key}" không được gộp DỌC (tiêu đề và dòng dữ liệu là 2 phần khác nhau)`);

      const laTruong = laDong ? laTruongDong : laTruongPhieu;
      const tenPhamVi = laDong ? 'DÒNG (bảng chi tiết)' : 'PHIẾU (đầu/cuối phiếu)';
      for (const p of (Array.isArray(val.phan) ? val.phan : [])) {
        if (!p || p.loai !== 'truong') continue;
        if (!laTruong(p.ma)) {
          loi.push(`${ten}: ô "${key}" dùng trường "${p.ma}" không thuộc phạm vi ${tenPhamVi}`);
        }
      }
      // ⚠⚠ Ô QR / mã vạch CHỈ dùng được ở ĐẦU và CUỐI phiếu. Vùng lặp dòng thì mỗi dòng phải dựng
      //   ảnh mã RIÊNG — chưa hỗ trợ; cho lưu thì bản in ra ô trống mà không báo gì.
      if (val.kieu === 'qr' || val.kieu === 'barcode') {
        if (laDong) loi.push(`${ten}: ô "${key}" — vùng lặp dòng chưa hỗ trợ ô QR / mã vạch`);
        else if (val.ma_qr && !laTruong(val.ma_qr)) {
          loi.push(`${ten}: ô "${key}" mã ${val.kieu} trỏ tới trường "${val.ma_qr}" không thuộc phạm vi ${tenPhamVi}`);
        }
      }
    }
  };

  kiemKhung(boCuc.dau, 'Đầu phiếu', false);
  kiemKhung(boCuc.lap, 'Vùng lặp dòng', true);
  kiemKhung(boCuc.cuoi, 'Cuối phiếu', false);
  if (!boCuc.lap) loi.push('Thiếu vùng lặp dòng (bảng chi tiết)');
  return loi.slice(0, 20); // đủ để sửa, không dội hàng trăm dòng
}

module.exports = {
  KHO_GIAY, HUONG, LE_MAC_DINH, timKho, vungNoiDung,
  VI_TRI_IN_PHIEU, TRUONG_PHIEU, TRUONG_DONG_PHIEU, DINH_DANG_NGAY,
  MA_VI_TRI_PHIEU, BO_CUC_PHIEU_V,
  timViTriPhieu, laTruongPhieu, laTruongDong, kiemBoCucPhieu, khoaO,
};
