'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// MẪU TEM — danh mục VỊ TRÍ IN + TRƯỜNG DỮ LIỆU + hình dạng `bo_cuc_json` (mig 073).
//
// ⚠ Danh mục nằm ở CODE, không ở DB: thêm nút in mới / trường dữ liệu mới chỉ cần khai thêm ở đây
//   rồi gắn mẫu trên giao diện — KHÔNG cần migration (cùng khuôn với `utils/phuongAnIn.js`).
// ⚠ FE gương lại danh mục này qua API `GET /mau-tem/danh-muc` (không chép cứng sang FE — chép là
//   sớm muộn 2 bên lệch nhau).
// ─────────────────────────────────────────────────────────────────────────────

// KHỔ TEM — CỐ ĐỊNH (chốt 08/08/2026). Trùng khớp `SHEET_CSS` trong FE `printTemLabel.js`:
// tờ 110×80mm chứa 2 tem; khung tem TRÁI thu còn 51mm (lề phải 1mm) để kéo tem PHẢI vào trong 4mm.
// Vùng NỘI DUNG của cả 2 tem đều 49mm — người thiết kế chỉ làm việc trong vùng này.
const KHO_TEM = Object.freeze({
  to_rong_mm: 110, to_cao_mm: 80,
  tem_rong_mm: 55, tem_cao_mm: 80,
  noi_dung_rong_mm: 49, noi_dung_cao_mm: 78,
  le_tren_mm: 1, le_duoi_mm: 1, le_trai_mm: 1, le_phai_mm: 5,
});

// ─── VỊ TRÍ IN (nút in tem trong app) ───────────────────────────────────────
// `hai_khung_khac_nhau`: true = nhãn trái/phải là 2 bố cục KHÁC nhau (tem sản xuất: 15 + 16);
//                        false = in 2 nhãn GIỐNG hệt nhau (chỉ thiết kế khung trái, khung phải chép theo).
// `tien_to`: tiền tố công đoạn ghép vào mã tem cho từng khung (xem utils/temPrefix.js).
const VI_TRI_IN = Object.freeze([
  {
    ma: 'SX_IN_TEM', ten: 'Sản xuất — In tem', mau_goc: 'TEM_SX',
    mo_ta: 'Nút "In tem" ở sidebar Xác nhận chạy · in tem gom set (từng dòng) · Vượt sản xuất · In lại tem',
    man_hinh: 'Sản xuất > Xác nhận chạy', hai_khung_khac_nhau: true, tien_to: { trai: 15, phai: 16 },
  },
  {
    ma: 'KCS_IN_TEM_GIAO', ten: 'KCS — In tem giao', mau_goc: 'TEM_KCS_GIAO',
    mo_ta: 'Nút "In tem" trong sidebar Đã hoàn thành của màn KCS (tem 15 — KCS đạt)',
    man_hinh: 'Chất lượng > KCS', hai_khung_khac_nhau: false, tien_to: { trai: 15, phai: 15 },
  },
  {
    ma: 'SUA_IN_TEM_OQC', ten: 'Sửa — In tem OQC', mau_goc: 'TEM_OQC_SUA',
    mo_ta: 'Nút "In tem" trong sidebar Đã hoàn thành của màn Sửa (tem 17 — sửa đạt để giao)',
    man_hinh: 'Chất lượng > Sửa', hai_khung_khac_nhau: false, tien_to: { trai: 17, phai: 17 },
  },
  {
    ma: 'GIA_CONG_IN_TEM_VE', ten: 'Gia công — In tem hàng về', mau_goc: 'TEM_GIA_CONG',
    mo_ta: 'Nút "In tem" ở màn Gia công + trong Lịch sử chuyển (tem 13 — "TH VỀ")',
    man_hinh: 'Kế hoạch > Gia công', hai_khung_khac_nhau: false, tien_to: { trai: 13, phai: 13 },
  },
]);

// ─── TRƯỜNG DỮ LIỆU chèn được vào ô ─────────────────────────────────────────
// `ma` = khóa trong object dữ liệu nhãn (BE `getTemLabelData` + phần FE bù thêm).
// `kieu`: 'chu' | 'so' | 'ngay' — quyết định ô Định dạng nào hiện ra ở panel thiết kế.
const TRUONG_TEM = Object.freeze([
  { ma: 'ma_tem', ten: 'Mã tem (đã gắn tiền tố)', kieu: 'chu', nhom: 'Tem' },
  { ma: 'ma_lenh_san_xuat', ten: 'Mã lệnh sản xuất', kieu: 'chu', nhom: 'Tem' },
  { ma: 'trang_thai', ten: 'Trạng thái tem', kieu: 'chu', nhom: 'Tem' },

  { ma: 'ten_khach_hang', ten: 'Khách hàng', kieu: 'chu', nhom: 'Đơn hàng' },
  { ma: 'ma_don_hang', ten: 'Đơn hàng (PO)', kieu: 'chu', nhom: 'Đơn hàng' },
  { ma: 'ma_hang', ten: 'Mã hàng', kieu: 'chu', nhom: 'Đơn hàng' },
  { ma: 'ma_phan', ten: 'Code phần', kieu: 'chu', nhom: 'Đơn hàng' },
  { ma: 'so_luong_don_hang', ten: 'SL đơn hàng (pcs)', kieu: 'so', nhom: 'Đơn hàng' },

  { ma: 'mau_vai', ten: 'Màu vải', kieu: 'chu', nhom: 'Phần in' },
  { ma: 'kich_vai', ten: 'Kích vải', kieu: 'chu', nhom: 'Phần in' },
  { ma: 'kich_phim', ten: 'Kích phim', kieu: 'chu', nhom: 'Phần in' },
  { ma: 'gc_mau_vai', ten: 'GC màu vải', kieu: 'chu', nhom: 'Phần in' },

  { ma: 'so_luong', ten: 'SL in của tem (pcs)', kieu: 'so', nhom: 'Sản xuất' },
  { ma: 'ma_chuyen', ten: 'Mã chuyền', kieu: 'chu', nhom: 'Sản xuất' },
  { ma: 'ten_chuyen', ten: 'Tên chuyền', kieu: 'chu', nhom: 'Sản xuất' },
  { ma: 'ca', ten: 'Ca sản xuất', kieu: 'chu', nhom: 'Sản xuất' },
  { ma: 'ma_ngay_ca', ten: 'Mã ngày ca (vd 260805D2)', kieu: 'chu', nhom: 'Sản xuất' },
  { ma: 'nguoi_in', ten: 'Người in tem', kieu: 'chu', nhom: 'Sản xuất' },
  { ma: 'nha_gia_cong', ten: 'Nhà gia công', kieu: 'chu', nhom: 'Sản xuất' },
  { ma: 'so_luong_vai_ve', ten: 'SL vải về của đợt (m)', kieu: 'so', nhom: 'Sản xuất' },
  // Nhập ở màn Sản xuất lúc PHÂN CÔNG (mig 063) — đi theo PHIẾU, mọi tem của phiếu dùng chung.
  { ma: 'ca_truong', ten: 'Ca trưởng', kieu: 'chu', nhom: 'Phân công' },
  { ma: 'chuyen_truong', ten: 'Chuyền trưởng', kieu: 'chu', nhom: 'Phân công' },
  { ma: 'tho_in', ten: 'Thợ in trên chuyền', kieu: 'chu', nhom: 'Phân công' },

  { ma: 'created_date', ten: 'Ngày giờ in tem', kieu: 'ngay', nhom: 'Thời gian' },
  { ma: 'tg_bd_in', ten: 'Giờ bắt đầu in (phiếu)', kieu: 'ngay', nhom: 'Thời gian' },
  { ma: 'tg_bd_phoi', ten: 'Giờ bắt đầu phơi', kieu: 'ngay', nhom: 'Thời gian' },
  { ma: 'tg_kt_phoi', ten: 'Giờ phơi xong', kieu: 'ngay', nhom: 'Thời gian' },
  { ma: 'gio_sx_bd', ten: 'Giờ SX từ', kieu: 'chu', nhom: 'Thời gian' },
  { ma: 'gio_sx_kt', ten: 'Giờ SX đến', kieu: 'chu', nhom: 'Thời gian' },
  { ma: 'ngay_ca', ten: 'Ngày ca', kieu: 'ngay', nhom: 'Thời gian' },
]);

// Định dạng ngày chọn được (áp cho ô có trường kiểu `ngay`).
const DINH_DANG_NGAY = Object.freeze([
  { ma: 'DD/MM/YY HH:mm', ten: '31/12/26 14:05' },
  { ma: 'DD/MM/YYYY HH:mm', ten: '31/12/2026 14:05' },
  { ma: 'DD/MM HH:mm', ten: '31/12 14:05' },
  { ma: 'DD/MM/YYYY', ten: '31/12/2026' },
  { ma: 'DD/MM/YY', ten: '31/12/26' },
  { ma: 'DD/MM', ten: '31/12' },
  { ma: 'HH:mm', ten: '14:05' },
  { ma: 'HH:mm:ss', ten: '14:05:30' },
]);

const MA_VI_TRI = VI_TRI_IN.map((v) => v.ma);
const timViTri = (ma) => VI_TRI_IN.find((v) => v.ma === ma) || null;
const laTruongHopLe = (ma) => TRUONG_TEM.some((t) => t.ma === ma);

// ─────────────────────────────────────────────────────────────────────────────
// HÌNH DẠNG `bo_cuc_json` (phiên bản 1)
//
// { v: 1,
//   trai: <KHUNG>,
//   phai: <KHUNG> | null   // null = chép y hệt khung trái (vị trí in `hai_khung_khac_nhau=false`)
// }
//
// KHUNG = {
//   so_cot: 4,                                  // số cột của lưới
//   hang: [ { cao_mm: 3.4 | null }, ... ],       // cao_mm null = tự giãn chia đều phần trống còn lại
//   cot:  [ { rong_mm: 9 | null }, ... ],        // rong_mm null = tự chia đều phần còn lại
//   o: {                                         // CHỈ ô gốc (ô bị gộp che thì KHÔNG có mặt)
//     "0,0": {
//       kieu: 'chu' | 'qr' | 'barcode',          // mặc định 'chu'
//       phan: [                                  // nội dung ghép nối, để trống = ô rỗng (ghi tay)
//         { loai: 'chu', gia_tri: 'PO' },        //   chữ cố định
//         { loai: 'truong', ma: 'ma_don_hang', dinh_dang: 'DD/MM/YY HH:mm',
//           thay: [{ tu: 'Chuyền M', thanh: '' }] }   // TÌM & THAY khi hiện lên tem
//       ],
//       cs: 3, rs: 1,                            // colspan/rowspan (mặc định 1)
//       dam: true, nghieng: false, gach_chan: false,
//       co_chu_mm: 2.4,                          // cỡ chữ (mm)
//       tu_co: true,                             // TỰ CO cỡ chữ cho vừa ô khi nội dung dài
//       ngang: 'center'|'left'|'right', doc: 'middle'|'top'|'bottom',
//       nen: '#f1f1f1' | null,
//       mau_chu: '#000000' | null,
//       xuong_dong: false,                       // false = ép 1 dòng (nowrap)
//       gian_chu_mm: 0.3,                        // GIÃN CHỮ (letter-spacing, mm) — âm = bóp lại
//       xoay: 90,                                // 0 ngang · 90 dọc đọc từ trên xuống · 270 từ dưới lên
//       vien: { tren: true, duoi: true, trai: true, phai: true },
//       ma_qr: 'ma_tem'                          // kieu qr/barcode: lấy giá trị từ trường nào
//     }
//   }
// }
// ⚠ Khóa ô là "<hàng>,<cột>" (0-based). Ô bị gộp che KHÔNG lưu — bộ render tự bỏ qua theo cs/rs.
// ─────────────────────────────────────────────────────────────────────────────

const BO_CUC_V = 1;
const khoaO = (r, c) => `${r},${c}`;

// Kiểm tra bố cục hợp lệ TRƯỚC KHI LƯU — chặn dữ liệu rác làm hỏng bản in.
// Trả mảng lỗi (rỗng = hợp lệ). Cố ý KHÔNG tự sửa: sai thì báo để người dùng biết.
function kiemBoCuc(boCuc) {
  const loi = [];
  if (!boCuc || typeof boCuc !== 'object') return ['Bố cục trống'];
  const kiemKhung = (k, ten) => {
    if (!k) return;
    const soCot = Number(k.so_cot);
    // Trần 24 cột: đủ để chia đều mọi tiết diện của 4 mẫu gốc (tem trái cần bội của 4, tem phải bội
    // của 5 → 20 cột chia trọn cả hai) mà vẫn còn bấm được trên màn thiết kế.
    if (!Number.isInteger(soCot) || soCot < 1 || soCot > 24) { loi.push(`${ten}: số cột phải 1–24`); return; }
    const soHang = Array.isArray(k.hang) ? k.hang.length : 0;
    if (soHang < 1 || soHang > 60) { loi.push(`${ten}: số hàng phải 1–60`); return; }
    const o = k.o && typeof k.o === 'object' ? k.o : {};
    // Bản đồ ô bị chiếm — bắt gộp ô chồng lấn / tràn ra ngoài lưới.
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
      for (const p of (Array.isArray(val.phan) ? val.phan : [])) {
        if (p && p.loai === 'truong' && !laTruongHopLe(p.ma)) loi.push(`${ten}: ô "${key}" dùng trường không có thật "${p.ma}"`);
      }
      if ((val.kieu === 'qr' || val.kieu === 'barcode') && val.ma_qr && !laTruongHopLe(val.ma_qr)) {
        loi.push(`${ten}: ô "${key}" mã ${val.kieu} trỏ tới trường không có thật "${val.ma_qr}"`);
      }
    }
  };
  kiemKhung(boCuc.trai, 'Khung trái');
  if (boCuc.phai) kiemKhung(boCuc.phai, 'Khung phải');
  if (!boCuc.trai) loi.push('Thiếu khung trái');
  return loi.slice(0, 20); // đủ để sửa, không dội hàng trăm dòng
}

module.exports = {
  KHO_TEM, VI_TRI_IN, TRUONG_TEM, DINH_DANG_NGAY, MA_VI_TRI, BO_CUC_V,
  timViTri, laTruongHopLe, kiemBoCuc, khoaO,
};
