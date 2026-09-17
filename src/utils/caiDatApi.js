'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// BẬT / TẮT CÁC API ERP NGAY TRÊN GIAO DIỆN (mig 083, bảng `cai_dat_api`)
// Trang **Hệ thống > Cài đặt API**. Trước đây chỉ tắt được bằng biến `.env` ⇒ phải sửa file trên
// máy chủ + restart BE; nay bấm 1 nút là có hiệu lực ngay.
//
// ⚠⚠ FAIL-OPEN Ở MỌI NHÁNH LỖI: thiếu bảng (chưa chạy mig 083) / DB chớp mạng ⇒ dùng **giá trị mặc
//   định lấy từ `.env`** chứ KHÔNG tắt bừa. Tắt nhầm API mã tem là cả xưởng ngừng in được tem —
//   hậu quả nặng hơn nhiều so với việc một cấu hình chậm có hiệu lực vài giây.
//
// ⚠ KHÔNG query DB mỗi lần in tem: giữ cache trong RAM (TTL 30s) — cùng khuôn `utils/phienCache.js`.
//   `xoaCache()` gọi NGAY sau khi lưu nên bấm nút là ăn liền, không phải chờ hết TTL.
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../config/db');
const env = require('./../config/env');

// Danh mục API — nằm ở CODE (như `VI_TRI_IN` của mẫu tem, `TRANG_PAIN` của hiển thị phương án in)
// ⇒ thêm API mới chỉ khai ở đây, KHÔNG cần migration.
//   `macDinh()` = giá trị dùng khi chưa có dòng trong DB (giữ nguyên hành vi của biến `.env` cũ).
//   `url()`     = URL đang thực sự gọi, để trang cài đặt hiện ra + nút "Thử kết nối" dùng.
const DANH_MUC_API = [
  {
    // ⚠ `ma_api` GIỮ NGUYÊN 'ERP_BARCODE_TEM' dù endpoint đã đổi tên thành `/barcode-tem-15`:
    //   nó là KHÓA của bảng `cai_dat_api` và là `hanh_dong` của mọi dòng lịch sử trong `audit_log`.
    //   Đổi mã = mất dòng bật/tắt đang lưu + mất sạch lịch sử 51 lượt gọi đã ghi trên prod.
    ma: 'ERP_BARCODE_TEM',
    ten: 'Lấy mã tem 15 (in ở chuyền) từ ERP',
    mo_ta: 'Gọi mỗi lần TẠO TEM MỚI để xin barcode 12 số bắt đầu bằng 15. TẮT ⇒ MES tự sinh mã dạng TEM00123 '
      + '(vẫn quét được trong MES, nhưng máy quét bên ERP KHÔNG đọc được).',
    canh_bao: 'Tắt thì tem in ra không quét được bằng máy quét của ERP.',
    macDinh: () => true,
    url: () => env.erp.barcodeTemUrl,
  },
  // ─── MÃ TEM RIÊNG CHO TEM 17 / TEM 13 (thêm 06/09/2026) ────────────────────
  // Trước đây 2 công đoạn này KHÔNG xin mã: lấy mã tem 15 rồi thay 2 số đầu ⇒ ERP không phân biệt
  // được nhãn 15 với nhãn 17/13 của cùng lô. Nay mỗi loại một dãy số riêng.
  {
    ma: 'ERP_BARCODE_TEM_17',
    ten: 'Lấy mã tem 17 (sửa đạt) từ ERP',
    mo_ta: 'Gọi khi xác nhận SỬA ĐẠT lần đầu của một tem — xin barcode 12 số bắt đầu bằng 17. '
      + 'TẮT ⇒ lùi về cách cũ: lấy mã tem gốc rồi thay 2 số đầu thành 17.',
    canh_bao: 'Tắt thì tem 17 dùng lại 10 số đuôi của tem gốc — ERP không phân biệt được 2 nhãn.',
    macDinh: () => true,
    url: () => env.erp.barcodeTem17Url,
  },
  {
    ma: 'ERP_BARCODE_TEM_13',
    ten: 'Lấy mã tem 13 (gia công về) từ ERP',
    mo_ta: 'Gọi khi Kế hoạch bấm "Nhận hàng → OQC" — xin barcode 12 số bắt đầu bằng 13. '
      + 'TẮT ⇒ lùi về cách cũ: xin mã tem 15 rồi in nhãn với tiền tố 13.',
    canh_bao: 'Tắt thì tem 13 mang mã của dãy tem 15 — ERP không phân biệt được 2 nhãn.',
    macDinh: () => true,
    url: () => env.erp.barcodeTem13Url,
  },
  {
    ma: 'ERP_GHI_IN_TEM',
    ten: 'Báo ERP mỗi lần in tem',
    mo_ta: 'Gửi ngược lên ERP thông tin lượt in (proc MES_spr_MES2SF0). Chạy ngầm — TẮT hay lỗi đều '
      + 'KHÔNG ảnh hưởng việc in tem.',
    canh_bao: null,
    macDinh: () => env.erp.ghiInTemEnabled,
    url: () => env.erp.ghiInTemUrl,
    // API DUY NHẤT cho giới hạn theo code phần — để chạy thử vài phần in rồi mới mở toàn bộ.
    // ⚠ Cố ý KHÔNG mở cho 2 API kia: "Lấy mã tem" mà lọc thì cùng 1 lệnh gom set có thể ra 2 loại
    //   mã khác nhau; "Đồng bộ đợt vải" kéo dữ liệu ở MỨC ERP, chưa biết code phần nào cho tới khi
    //   xử lý xong nên lọc ở đó vô nghĩa.
    loc_code_phan: true,
  },
  // ─── 3 API PHIẾU GIAO / PHÂN LOẠI LỖI (thêm 04/09/2026) ─────────────────────
  // Khai ở đây là XONG: trang *Cài đặt API* tự hiện thêm 3 dòng (bật/tắt · URL · Thử kết nối · Lịch sử)
  // vì trang dựng theo danh mục backend trả về. KHÔNG cần migration, KHÔNG cần sửa FE.
  {
    ma: 'ERP_LAY_ID_PHIEU_GIAO',
    ten: 'Lấy ID phiếu giao từ ERP',
    mo_ta: 'Gọi khi TẠO PHIẾU GIAO để xin số phiếu do ERP cấp. TẮT ⇒ MES tự sinh mã phiếu giao như '
      + 'trước (ERP sẽ không đối soát được theo số này).',
    canh_bao: 'Mỗi lần gọi TIÊU MỘT SỐ của ERP — giống API lấy mã tem.',
    macDinh: () => true,
    url: () => env.erp.layIdPhieuGiaoUrl,
  },
  {
    ma: 'ERP_GUI_PHIEU_GIAO',
    ten: 'Gửi phiếu giao sang ERP',
    mo_ta: 'Đẩy nội dung phiếu giao (danh sách tem + số lượng) sang ERP. Chạy ngầm — TẮT hay lỗi đều '
      + 'KHÔNG chặn việc xác nhận giao hàng.',
    canh_bao: null,
    macDinh: () => env.erp.guiPhieuGiaoEnabled,
    url: () => env.erp.guiPhieuGiaoUrl,
  },
  {
    ma: 'ERP_GUI_PHAN_LOAI_LOI',
    ten: 'Gửi phân loại lỗi sang ERP',
    mo_ta: 'Đẩy phiếu phân loại lỗi (loại lỗi · biện pháp · SL sửa/hủy) sang ERP mỗi lần lưu. '
      + 'Chạy ngầm — TẮT hay lỗi đều KHÔNG chặn việc lưu phiếu.',
    canh_bao: null,
    macDinh: () => env.erp.guiPhanLoaiLoiEnabled,
    url: () => env.erp.guiPhanLoaiLoiUrl,
  },
  {
    ma: 'ERP_DONG_BO_VAI',
    ten: 'Đồng bộ đợt vải từ ERP',
    mo_ta: 'Job tự chạy mỗi ' + env.erp.syncIntervalMin + ' phút để kéo phiếu nhận vải về READY. '
      + 'TẮT ⇒ job bỏ qua lượt chạy và nút "Đồng bộ ngay" cũng báo đang tắt.',
    canh_bao: 'Tắt lâu thì đợt vải mới từ ERP sẽ không lên MES.',
    macDinh: () => env.erp.syncEnabled,
    url: () => env.erp.phieuNhanVaiUrl,
  },
];

const MA_HOP_LE = new Set(DANH_MUC_API.map((x) => x.ma));
const TTL_MS = 30000;

let cache = null;      // { [ma]: bool } — chỉ những mã CÓ dòng trong DB
let cacheHan = 0;
let dangNap = null;    // gộp các lời gọi song song thành 1 query

function macDinhCua(ma) {
  const m = DANH_MUC_API.find((x) => x.ma === ma);
  try { return m ? !!m.macDinh() : true; } catch { return true; }
}

// Tách chuỗi code phần người dùng nhập (phẩy / xuống dòng / chấm phẩy) → mảng đã chuẩn hóa.
// ⚠ Khớp CHÍNH XÁC (chốt với người dùng) nên chỉ trim + viết HOA, KHÔNG bỏ dấu/không khớp chứa —
//   `ma_phan` toàn chữ-số-gạch nên viết hoa là đủ chống gõ thường.
const tachCodePhan = (s) => String(s || '')
  .split(/[,;\r\n]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);

// ⚠⚠ DÒ CỘT `code_phan` TRƯỚC KHI DÙNG (khuôn `temCoCot` mig 066) — cột này thêm SAU khi bảng
//   `cai_dat_api` đã lên production ⇒ có môi trường đã tạo bảng mà chưa có cột.
//   **KHÔNG được dựa vào try/catch quanh SELECT**: `napCache` nuốt lỗi rồi trả `{}` ⇒ fail-open ⇒
//   **toàn bộ cấu hình bật/tắt đã lưu bị bỏ qua, API nào cũng chạy theo mặc định `.env`**
//   — người dùng tắt API mà nó vẫn gọi, mà log thì chỉ có 1 dòng cảnh báo mờ nhạt.
//   (Lỗi thật 14/08/2026: prod chạy mig 083 bản cũ nên thiếu cột, lưu cấu hình ăn 42703.)
// Cache khi ĐÃ có cột; chưa có thì dò lại mỗi lần ⇒ chạy migration xong nhận ngay, khỏi restart BE.
let _coCotCodePhan = false;
async function coCotCodePhan() {
  if (_coCotCodePhan) return true;
  try {
    const { rows } = await query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='cai_dat_api' AND column_name='code_phan' LIMIT 1`
        .replace(/\s+/g, ' ')
    );
    _coCotCodePhan = rows.length > 0;
  } catch { _coCotCodePhan = false; }
  return _coCotCodePhan;
}

async function napCache() {
  const co = await coCotCodePhan();
  const { rows } = await query(`SELECT ma_api, bat${co ? ', code_phan' : ''} FROM cai_dat_api`);
  const m = {};
  for (const r of rows) m[r.ma_api] = { bat: r.bat !== false, code_phan: (co && r.code_phan) || null };
  return m;
}

async function layCache() {
  const now = Date.now();
  if (cache && now < cacheHan) return cache;
  if (!dangNap) {
    dangNap = napCache()
      .then((m) => { cache = m; cacheHan = Date.now() + TTL_MS; return m; })
      .catch((e) => {
        // Thiếu bảng / DB lỗi ⇒ KHÔNG chặn API nào. Cache rỗng trong TTL để khỏi spam query.
        console.warn(`[cai-dat-api] Không đọc được cấu hình (dùng mặc định .env): ${e.message}`);
        cache = {}; cacheHan = Date.now() + TTL_MS; return cache;
      })
      .finally(() => { dangNap = null; });
  }
  return dangNap;
}

// API này có đang BẬT không. Thiếu dòng trong DB ⇒ lấy mặc định từ `.env`.
async function apiBat(ma) {
  const m = await layCache();
  return Object.prototype.hasOwnProperty.call(m, ma) ? m[ma].bat : macDinhCua(ma);
}

// Danh sách code phần được phép gọi API này — `null` = KHÔNG giới hạn (áp dụng cho tất cả).
// ⚠ Trả `Set` (đã viết HOA) để bên gọi kiểm O(1); lệnh gom set in nhiều tem 1 lượt.
async function codePhanChoPhep(ma) {
  const m = await layCache();
  const ds = tachCodePhan(m[ma] && m[ma].code_phan);
  return ds.length ? new Set(ds) : null;
}

// Phần in này có được gọi API không (gộp cả 2 điều kiện: API bật + nằm trong danh sách giới hạn).
// ⚠ FAIL-OPEN: lỗi đọc cấu hình ⇒ `layCache` trả {} ⇒ không giới hạn gì.
async function apiChoPhepPhanIn(ma, maPhan) {
  if (!(await apiBat(ma))) return false;
  const cho = await codePhanChoPhep(ma);
  if (!cho) return true;
  return cho.has(String(maPhan || '').trim().toUpperCase());
}

function xoaCache() { cache = null; cacheHan = 0; }

// Danh sách đầy đủ cho trang cài đặt: trạng thái thật + URL đang gọi + mô tả.
async function danhSachCauHinh() {
  const m = await layCache();
  const coCot = await coCotCodePhan(); // tính 1 LẦN — `await` trong `.map()` sẽ ra Promise, không chạy
  return DANH_MUC_API.map((x) => ({
    ma: x.ma,
    ten: x.ten,
    mo_ta: x.mo_ta,
    canh_bao: x.canh_bao,
    url: (() => { try { return x.url(); } catch { return null; } })(),
    bat: Object.prototype.hasOwnProperty.call(m, x.ma) ? m[x.ma].bat : macDinhCua(x.ma),
    theo_mac_dinh: !Object.prototype.hasOwnProperty.call(m, x.ma),
    mac_dinh: macDinhCua(x.ma),
    // Giới hạn theo code phần — chỉ API nào khai `loc_code_phan` mới có ô này trên giao diện.
    loc_code_phan: !!x.loc_code_phan,
    code_phan: (m[x.ma] && m[x.ma].code_phan) || '',
    so_code_phan: tachCodePhan(m[x.ma] && m[x.ma].code_phan).length,
    // FE dùng để hiện lời nhắc chạy migration thay vì để người dùng bấm Lưu rồi ăn lỗi khó hiểu.
    thieu_cot_code_phan: !!x.loc_code_phan && !coCot,
  }));
}

function urlCua(ma) {
  const m = DANH_MUC_API.find((x) => x.ma === ma);
  if (!m) return null;
  try { return m.url(); } catch { return null; }
}

module.exports = {
  DANH_MUC_API, MA_HOP_LE, apiBat, codePhanChoPhep, apiChoPhepPhanIn,
  xoaCache, danhSachCauHinh, urlCua, macDinhCua, tachCodePhan, coCotCodePhan,
};
