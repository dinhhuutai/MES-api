// ─────────────────────────────────────────────────────────────────────────────
// READY TRẢ VỀ GIAO NHẬN (GN) SỬA THÔNG TIN — nguồn luật chung (25/09/2026, mig 105).
//
// Luồng: Kỹ thuật / QC ở màn READY thấy thông tin phần in SAI (màu, kích phim, SLĐH…) → bấm
// "Trả về GN", tick các mục sai (+ ô "Khác") → phần in RỜI màn READY, hiện ở trang
// *Đơn hàng › Phần in chờ sửa thông tin* → GN sửa rồi bấm "Xác nhận lại" → phần in QUAY LẠI READY.
//
// ⚠ Lưu vào `qc_tra_ve` với `loai = 'TRA_VE_GN'` (cột `loai` là VARCHAR tự do ⇒ KHÔNG cần bảng mới).
//   `checklist_list` = TÊN các mục đã tick (ngăn bằng ", "), `ly_do` = câu tóm tắt đọc được ngay.
// ⚠ Giữ nguyên xác nhận Khuôn/Film/Mực/QC (cùng tinh thần luật 17/09/2026 "trả về READY giữ xác
//   nhận kỹ thuật") — GN sửa xong mà mục nào cần làm lại thì kỹ thuật tự hủy xác nhận mục đó.
// ─────────────────────────────────────────────────────────────────────────────

const LOAI_GN = 'TRA_VE_GN';

// Danh mục mục thông tin để tick. `sua` = GN sửa được NGAY trên trang (cột nằm trong whitelist của
// Quản trị phần in); `sua: false` = khóa nghiệp vụ do ERP quản (khách/đơn/mã hàng/code phần) — vẫn cho
// tick để nói RÕ chỗ sai, GN sửa bên ERP rồi mới xác nhận lại.
// Thêm mục mới = thêm 1 dòng ở đây, KHÔNG cần migration.
const THONG_TIN_GN = [
  { ma: 'MAU_VAI', ten: 'Màu vải', nhom: 'Phần in', sua: true },
  { ma: 'KICH_VAI', ten: 'Kích vải', nhom: 'Phần in', sua: true },
  { ma: 'KICH_PHIM', ten: 'Kích phim', nhom: 'Phần in', sua: true },
  { ma: 'TINH_CHAT_IN', ten: 'Tính chất in', nhom: 'Phần in', sua: true },
  { ma: 'MAU_IN', ten: 'Màu in', nhom: 'Phần in', sua: true },
  { ma: 'DO_IN', ten: 'Độ in', nhom: 'Phần in', sua: true },
  { ma: 'SL_DON_HANG', ten: 'Số lượng đơn hàng (SLĐH)', nhom: 'Phần in', sua: true },
  { ma: 'BARCODE_PHAN_IN', ten: 'Mã vạch phần in (TDTHĐH)', nhom: 'Phần in', sua: true },
  { ma: 'CHO_KHO', ten: 'Thời gian chờ khô', nhom: 'Phần in', sua: true },
  { ma: 'IN_KIENG', ten: 'In kiếng', nhom: 'Phần in', sua: true },
  { ma: 'SL_VAI_VE', ten: 'Số lượng vải về', nhom: 'Đợt vải', sua: true },
  { ma: 'HAN_GIAO', ten: 'Hạn giao hàng', nhom: 'Đợt vải', sua: true },
  { ma: 'NGAY_VAI_VE', ten: 'Ngày vải về', nhom: 'Đợt vải', sua: true },
  { ma: 'LOAI_DOT_VAI', ten: 'Loại đợt vải', nhom: 'Đợt vải', sua: true },
  { ma: 'NHA_GIA_CONG', ten: 'Nhà gia công', nhom: 'Đợt vải', sua: true },
  { ma: 'BARCODE_DOT', ten: 'Barcode đợt vải', nhom: 'Đợt vải', sua: true },
  { ma: 'KHACH_HANG', ten: 'Khách hàng', nhom: 'Mã ERP (sửa bên ERP)', sua: false },
  { ma: 'DON_HANG', ten: 'Đơn hàng', nhom: 'Mã ERP (sửa bên ERP)', sua: false },
  { ma: 'MA_HANG', ten: 'Mã hàng', nhom: 'Mã ERP (sửa bên ERP)', sua: false },
  { ma: 'CODE_PHAN', ten: 'Code phần', nhom: 'Mã ERP (sửa bên ERP)', sua: false },
  // 26/09/2026: không phải thông tin sai mà là đề nghị GN HỦY đợt vải (không in nữa) — GN bấm
  // "Hủy đợt vải" ở trang chờ sửa thông tin.
  { ma: 'HUY_VAI', ten: 'Hủy vải không in', nhom: 'Khác', sua: false },
];
const TEN_THEO_MA = Object.fromEntries(THONG_TIN_GN.map((x) => [x.ma, x.ten]));

// Phần in đang ở GN (còn cờ trả về chưa xử lý) ⇒ RỜI màn READY.
// ⚠ Gương ở: technical.repository listCandidates + countReadyItems. KHÔNG gương vào dải "Theo dõi"
//   (`utils/siSoTram.js`): mô hình khoảng [tg_vao, tg_ra) không biểu diễn được "rời rồi quay lại",
//   nên trong lúc ở GN phần in vẫn được sĩ số READY tính là TỒN — chênh lệch CỐ Ý, số rất nhỏ.
const CHO_GN_SQL = (pinCol) => `EXISTS (SELECT 1 FROM qc_tra_ve gnq WHERE gnq.loai = '${LOAI_GN}'
  AND gnq.phan_in_id = ${pinCol} AND gnq.da_xu_ly = false)`;

module.exports = { LOAI_GN, THONG_TIN_GN, TEN_THEO_MA, CHO_GN_SQL };
