'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// BẬT / TẮT TÍNH NĂNG NGHIỆP VỤ NGAY TRÊN GIAO DIỆN (mig 087, bảng `cai_dat_tinh_nang`)
// Trang **Hệ thống > Cài đặt tính năng**.
//
// Khác `utils/caiDatApi.js` (bật/tắt API ERP — chuyện KỸ THUẬT), file này bật/tắt **LUẬT NGHIỆP VỤ**.
//
// ⚠⚠ FAIL-OPEN THEO MẶC ĐỊNH KHAI Ở CODE, KHÔNG PHẢI "TẮT": thiếu bảng (chưa chạy mig 087) / DB chớp
//   mạng ⇒ dùng `macDinh` bên dưới (hiện cả 2 tính năng đều `true`) ⇒ **giữ nguyên luật đang chạy**.
//   ⚠ CỐ Ý NGHIÊNG VỀ "BẬT" — ngược với `caiDatApi` (nghiêng về "gọi API bình thường"): ở đây tắt
//   nhầm nghĩa là **âm thầm bỏ qua một luật kiểm soát chất lượng**, người dùng không hề biết; còn
//   chặn oan thì họ thấy ngay và báo lại. Sai theo hướng dễ phát hiện.
//
// ⚠ KHÔNG query DB mỗi lần release: cache RAM (TTL 30s) — cùng khuôn `utils/caiDatApi.js`.
//   `xoaCache()` gọi NGAY sau khi lưu nên bấm nút là ăn liền, không phải chờ hết TTL.
//
// ⚠⚠ THÊM TOGGLE MỚI = khai thêm 1 dòng ở `DANH_MUC_TINH_NANG`, **KHÔNG cần migration**
//   (`ma_tinh_nang` không có FK, bảng không seed dòng nào) — cùng khuôn `DANH_MUC_API` (mig 083) ·
//   `VI_TRI_IN` (073) · `TRANG_PAIN` (067) · `LOAI_DUYET` (086).
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../config/db');

// `canh_bao` = câu hiện màu cam trên giao diện khi người dùng gạt sang TẮT (hệ quả thật sự xảy ra).
// `khi_tat`  = mô tả ngắn hành vi sau khi tắt, hiện ngay dưới tên tính năng.
const DANH_MUC_TINH_NANG = [
  {
    ma: 'RELEASE1_KHOP_LOAI_CHUYEN',
    ten: 'Chỉ cho Release 1 khi phương án in khớp loại chuyền',
    mo_ta: 'Bàn ↔ PA Bàn · Máy ↔ PA Máy · Robot ↔ PA Robot. Lệch thì không xác nhận Release 1 được, '
      + 'phải đổi phương án in trước. Ép · Logo · Gia công và 3 chuyền dùng chung '
      + '(M1A-1B Canh hàng · M2A-2B Bổ sung MTĐ · M3A-3B Mẫu) luôn được miễn, bật hay tắt cũng vậy.',
    khi_tat: 'Release 1 lên chuyền nào cũng được, không kiểm phương án in.',
    canh_bao: 'Tắt thì hàng phương án in Bàn vẫn xếp được lên chuyền Máy mà không ai được cảnh báo.',
    macDinh: true,
  },
  {
    ma: 'DUYET_DOI_PHUONG_AN_IN',
    ten: 'Đổi phương án in phải được duyệt',
    mo_ta: 'Người không có quyền PA_IN_APPROVE bấm đổi phương án in thì tạo yêu cầu chờ duyệt '
      + '(giá trị giữ nguyên tới khi được thông qua). Người có quyền duyệt luôn đổi thẳng.',
    khi_tat: 'Ai đổi được phương án in thì đổi thẳng, không cần lý do, không qua hàng đợi duyệt.',
    // ⚠ Nói TRƯỚC hệ quả nặng nhất: tắt là DUYỆT HẾT hàng đợi (người dùng chốt 19/08/2026).
    canh_bao: 'Tắt thì MỌI yêu cầu đang chờ duyệt sẽ được ÁP DỤNG NGAY, và từ đó đổi phương án in '
      + 'không cần lý do nữa.',
    macDinh: true,
  },
];

const MA_HOP_LE = new Set(DANH_MUC_TINH_NANG.map((x) => x.ma));
const TTL_MS = 30000;

let cache = null;    // { [ma]: bool } — chỉ những mã CÓ dòng trong DB
let cacheHan = 0;
let dangNap = null;  // gộp các lời gọi song song thành 1 query

function macDinhCua(ma) {
  const m = DANH_MUC_TINH_NANG.find((x) => x.ma === ma);
  return m ? !!m.macDinh : true;
}

async function napCache() {
  const { rows } = await query('SELECT ma_tinh_nang, bat FROM cai_dat_tinh_nang');
  const m = {};
  for (const r of rows) m[r.ma_tinh_nang] = r.bat !== false;
  return m;
}

async function layCache() {
  const now = Date.now();
  if (cache && now < cacheHan) return cache;
  if (!dangNap) {
    dangNap = napCache()
      .then((m) => { cache = m; cacheHan = Date.now() + TTL_MS; return m; })
      .catch((e) => {
        // Thiếu bảng / DB lỗi ⇒ mọi tính năng theo MẶC ĐỊNH ở code (đang là BẬT) — giữ nguyên luật.
        console.warn(`[cai-dat-tinh-nang] Không đọc được cấu hình (dùng mặc định ở code): ${e.message}`);
        cache = {}; cacheHan = Date.now() + TTL_MS; return cache;
      })
      .finally(() => { dangNap = null; });
  }
  return dangNap;
}

// Tính năng này có đang BẬT không. Thiếu dòng trong DB ⇒ lấy mặc định khai ở code.
async function tinhNangBat(ma) {
  const m = await layCache();
  return Object.prototype.hasOwnProperty.call(m, ma) ? m[ma] : macDinhCua(ma);
}

function xoaCache() { cache = null; cacheHan = 0; }

// Danh sách đầy đủ cho trang cài đặt: trạng thái thật + mô tả + cờ "đang theo mặc định".
async function danhSachCauHinh() {
  const m = await layCache();
  return DANH_MUC_TINH_NANG.map((x) => ({
    ma: x.ma,
    ten: x.ten,
    mo_ta: x.mo_ta,
    khi_tat: x.khi_tat,
    canh_bao: x.canh_bao,
    bat: Object.prototype.hasOwnProperty.call(m, x.ma) ? m[x.ma] : macDinhCua(x.ma),
    theo_mac_dinh: !Object.prototype.hasOwnProperty.call(m, x.ma),
    mac_dinh: macDinhCua(x.ma),
  }));
}

// Trạng thái rút gọn `{ma: bool}` cho FE (mọi người đăng nhập đều đọc được — FE cần biết để hiện
// đúng chữ và có bắt buộc nhập lý do hay không). ⚠ Đây CHỈ là gợi ý hiển thị: chốt chặn thật nằm ở
// backend, FE cầm cờ cũ cũng không lách được luật.
async function trangThaiRutGon() {
  const m = await layCache();
  const out = {};
  for (const x of DANH_MUC_TINH_NANG) {
    out[x.ma] = Object.prototype.hasOwnProperty.call(m, x.ma) ? m[x.ma] : macDinhCua(x.ma);
  }
  return out;
}

module.exports = {
  DANH_MUC_TINH_NANG, MA_HOP_LE,
  tinhNangBat, xoaCache, danhSachCauHinh, trangThaiRutGon, macDinhCua,
};
