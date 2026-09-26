'use strict';

require('dotenv').config();

function required(name, fallback) {
  const val = process.env[name] ?? fallback;
  if (val === undefined) {
    throw new Error(`Thiếu biến môi trường bắt buộc: ${name}`);
  }
  return val;
}

// ⚠⚠ MỌI API ERP PHẢI ĐI CHUNG MỘT GỐC — bài học 2026-08-11: PRODUCTION KHÔNG IN TEM ĐƯỢC.
// Nguyên nhân: `.env` (mọi môi trường) chỉ đặt `ERP_PHIEU_NHAN_VAI_URL`, còn `ERP_BARCODE_TEM_URL`
// KHÔNG ai đặt ⇒ rơi về mặc định CỨNG `http://10.84.40.34:5000/...` (địa chỉ LAN). Máy chủ production
// ra được ERP bằng địa chỉ khác nên **đồng bộ ERP vẫn chạy ngon mà lấy mã tem thì timeout** → 503
// `ERP_BARCODE_TEM` → không in được tem, trong khi log đồng bộ vẫn xanh nên rất khó đoán ra.
//
// ⇒ CÁCH LÀM NAY, theo đúng khuôn của URL nhận vải:
//   1. **`ERP_BARCODE_TEM_15_URL` là biến CHÍNH THỨC trong `.env` của TỪNG môi trường** (đã đưa vào
//      `.env.example` **và** `.env` local) — production sửa host ngay tại biến này.
//   2. Nếu môi trường nào QUÊN đặt thì **suy GỐC từ URL đồng bộ** (2 API cùng nằm dưới
//      `/api/server/backup/mes/`) làm lưới an toàn — thà đi theo host đang chạy được còn hơn trỏ về
//      địa chỉ LAN cứng như trước. Lúc đó `index.js` in cảnh báo ngay khi khởi động.
const ERP_PHIEU_NHAN_VAI_URL = process.env.ERP_PHIEU_NHAN_VAI_URL
  || 'http://10.84.40.34:5000/api/server/backup/mes/phieu-nhan-vai-60';
const ERP_GOC = ERP_PHIEU_NHAN_VAI_URL.split('?')[0].replace(/\/+$/, '').replace(/\/[^/]*$/, '');

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '5000', 10),
  db: {
    host: required('PGHOST'),
    port: parseInt(process.env.PGPORT || '5432', 10),
    database: required('PGDATABASE'),
    user: required('PGUSER'),
    password: required('PGPASSWORD'),
    ssl: String(process.env.PGSSL || 'false').toLowerCase() === 'true',
  },
  jwt: {
    secret: required('JWT_SECRET'),
    expiresIn: process.env.JWT_EXPIRES || '8h',
  },
  corsOrigin: [
    "http://localhost:3000",
    "https://mes.thuanhunglongan.com",
  ] || 'http://localhost:3000',
  upload: {
    // Thư mục gốc lưu file trên ổ đĩa server (đã cấu hình sẵn).
    root: process.env.UPLOAD_ROOT || 'D:/uploads',
    // Domain public phục vụ file trong UPLOAD_ROOT (ví dụ .../uploads/images/avatar/...).
    publicBaseUrl: process.env.PUBLIC_BASE_URL || 'https://api.thuanhunglongan.com',
  },
  erp: {
    // API ERP lấy phiếu nhận vải CHÍNH THỨC (60 ngày) — dữ liệu này chuyển phần in qua READY. Override qua .env.
    phieuNhanVaiUrl: ERP_PHIEU_NHAN_VAI_URL,
    // API lấy MÃ TEM 15 (barcode 12 số, 2 số đầu = tiền tố công đoạn `15`) — thay mã tự sinh `TEM00001`.
    // ⚠ Mỗi lần gọi TIÊU MỘT SỐ ⇒ chỉ gọi khi TẠO tem mới (in lại tem không gọi).
    // ⚠⚠ MẶC ĐỊNH SUY TỪ URL ĐỒNG BỘ (xem ghi chú đầu file) — đừng hardcode host lại ở đây.
    // ⚠⚠ ERP ĐỔI TÊN ENDPOINT `/barcode-tem` → `/barcode-tem-15` (16/09/2026) cho đồng bộ với 2 endpoint
    //   `-17`/`-13`. Biến `.env` nhận CẢ HAI TÊN: `ERP_BARCODE_TEM_15_URL` (tên mới, ưu tiên) và
    //   `ERP_BARCODE_TEM_URL` (tên cũ, giữ để môi trường đã deploy không chết khi chưa kịp sửa `.env`).
    //   ⚠ Môi trường nào đang đặt `ERP_BARCODE_TEM_URL` trỏ `/barcode-tem` thì PHẢI sửa đuôi thành
    //   `-15`, vì biến tường minh luôn THẮNG giá trị mặc định suy ra ở đây.
    barcodeTemUrl: process.env.ERP_BARCODE_TEM_15_URL || process.env.ERP_BARCODE_TEM_URL
      || `${ERP_GOC}/barcode-tem-15`,
    // Timeout 1 lần gọi lấy mã tem (ms) — API này nhẹ, người dùng đang ĐỨNG CHỜ máy in nên để ngắn.
    barcodeTemTimeoutMs: parseInt(process.env.ERP_BARCODE_TEM_TIMEOUT_MS || '10000', 10),
    // Số lần thử lại khi lấy mã tem lỗi; hết lượt thì CHẶN in và báo rõ (không lùi về mã `TEM…` cũ).
    barcodeTemRetry: parseInt(process.env.ERP_BARCODE_TEM_RETRY || '3', 10),
    // ─── MÃ TEM RIÊNG CHO 2 CÔNG ĐOẠN (chốt 06/09/2026) ──────────────────────
    // ⚠⚠ Tem 17 (sửa đạt) và tem 13 (hàng gia công về) KHÔNG còn suy từ mã tem 15 bằng cách thay 2
    //   số đầu — mỗi loại XIN MÃ RIÊNG của ERP để 2 bên đối soát được từng nhãn giấy.
    //   Liên kết "tem 17 này là hàng sửa đạt của tem 15 kia" nay do cột `tem.tem_goc_id` (mig 091)
    //   gánh, KHÔNG còn nằm trong chuỗi mã ⇒ ĐỪNG suy quan hệ từ `ma_tem` nữa.
    // ⚠ Dùng chung `barcodeTemTimeoutMs`/`barcodeTemRetry`: cùng bản chất (gọi nhẹ, người đang đứng chờ).
    barcodeTem17Url: process.env.ERP_BARCODE_TEM_17_URL || `${ERP_GOC}/barcode-tem-17`,
    barcodeTem13Url: process.env.ERP_BARCODE_TEM_13_URL || `${ERP_GOC}/barcode-tem-13`,
    // API BÁO NGƯỢC LÊN ERP mỗi lần in tem (proc `MES_spr_MES2SF0`) — chiều ĐẨY duy nhất của hệ.
    // ⚠⚠ MẶC ĐỊNH SUY TỪ URL ĐỒNG BỘ (xem ghi chú đầu file) — đừng hardcode host lại ở đây.
    ghiInTemUrl: process.env.ERP_GHI_IN_TEM_URL || `${ERP_GOC}/ghi-in-tem`,
    // Timeout 1 lần gọi (ms). Gọi NGẦM sau khi tem đã tạo nên người in không phải chờ.
    ghiInTemTimeoutMs: parseInt(process.env.ERP_GHI_IN_TEM_TIMEOUT_MS || '10000', 10),
    // Số lần thử lại khi báo lỗi. Hết lượt thì GHI LOG rồi thôi — KHÔNG chặn in (khác `barcodeTemRetry`:
    // lúc đó tem đã tạo và mã tem đã tiêu của ERP, chặn lại là hỏng việc của người đứng máy).
    ghiInTemRetry: parseInt(process.env.ERP_GHI_IN_TEM_RETRY || '3', 10),
    // Tắt nhanh khi ERP bảo trì mà không phải sửa code/deploy lại.
    ghiInTemEnabled: String(process.env.ERP_GHI_IN_TEM_ENABLED || 'true').toLowerCase() === 'true',
    // ─── 3 API PHIẾU GIAO / PHÂN LOẠI LỖI (thêm 04/09/2026) ───────────────────
    // ⚠⚠ CÙNG LUẬT VỚI 2 API TRÊN: mặc định SUY TỪ `ERP_GOC` (host của URL đồng bộ), **KHÔNG hardcode
    //   host** — sự cố 11/08/2026 (prod không in được tem) chính là do một URL bị ghim cứng địa chỉ LAN
    //   trong khi server public đi bằng host khác. Muốn đổi thì đặt biến `.env` của môi trường đó.
    // Xin ID phiếu giao từ ERP (giống `barcode-tem`: mỗi lần gọi TIÊU MỘT SỐ) — gọi khi TẠO phiếu giao.
    layIdPhieuGiaoUrl: process.env.ERP_LAY_ID_PHIEU_GIAO_URL || `${ERP_GOC}/lay-id-phieu-giao`,
    layIdPhieuGiaoTimeoutMs: parseInt(process.env.ERP_LAY_ID_PHIEU_GIAO_TIMEOUT_MS || '10000', 10),
    layIdPhieuGiaoRetry: parseInt(process.env.ERP_LAY_ID_PHIEU_GIAO_RETRY || '3', 10),
    // Đẩy dữ liệu phiếu giao sang ERP (chiều ĐẨY, chạy ngầm — không chặn thao tác giao hàng).
    guiPhieuGiaoUrl: process.env.ERP_GUI_PHIEU_GIAO_URL || `${ERP_GOC}/gui-erp-phieu-giao`,
    guiPhieuGiaoTimeoutMs: parseInt(process.env.ERP_GUI_PHIEU_GIAO_TIMEOUT_MS || '10000', 10),
    guiPhieuGiaoRetry: parseInt(process.env.ERP_GUI_PHIEU_GIAO_RETRY || '3', 10),
    guiPhieuGiaoEnabled: String(process.env.ERP_GUI_PHIEU_GIAO_ENABLED || 'true').toLowerCase() === 'true',
    // Đẩy dữ liệu phân loại lỗi sang ERP (chiều ĐẨY, chạy ngầm).
    guiPhanLoaiLoiUrl: process.env.ERP_GUI_PHAN_LOAI_LOI_URL || `${ERP_GOC}/gui-erp-phan-loai-loi`,
    guiPhanLoaiLoiTimeoutMs: parseInt(process.env.ERP_GUI_PHAN_LOAI_LOI_TIMEOUT_MS || '10000', 10),
    guiPhanLoaiLoiRetry: parseInt(process.env.ERP_GUI_PHAN_LOAI_LOI_RETRY || '3', 10),
    guiPhanLoaiLoiEnabled: String(process.env.ERP_GUI_PHAN_LOAI_LOI_ENABLED || 'true').toLowerCase() === 'true',
    // Đẩy SỬA ĐẠT (tem 17) sang ERP — proc `MES_spr_MES2SK6`, cùng 20 tham số với `ghi-in-tem` (21/09/2026).
    // ⚠ Proc RIÊNG chính là để KHÔNG cộng vào sản lượng in (gửi tem 17 qua `ghi-in-tem` là đếm đôi).
    guiSuaDatUrl: process.env.ERP_GUI_SUA_DAT_URL || `${ERP_GOC}/gui-erp-sua-dat`,
    guiSuaDatTimeoutMs: parseInt(process.env.ERP_GUI_SUA_DAT_TIMEOUT_MS || '10000', 10),
    guiSuaDatRetry: parseInt(process.env.ERP_GUI_SUA_DAT_RETRY || '3', 10),
    guiSuaDatEnabled: String(process.env.ERP_GUI_SUA_DAT_ENABLED || 'true').toLowerCase() === 'true',
    // Đẩy KẾT QUẢ KIỂM KCS (kiểm phẩm) sang ERP lúc xác nhận KCS (24/09/2026). Chưa có hợp đồng tham số
    // riêng ⇒ dùng cùng 20 tham số với `ghi-in-tem` (khuôn sửa đạt) — xem `quality/kiemPhamErp.js`.
    guiKiemPhamUrl: process.env.ERP_GUI_KIEM_PHAM_URL || `${ERP_GOC}/gui-erp-kiem-pham`,
    guiKiemPhamTimeoutMs: parseInt(process.env.ERP_GUI_KIEM_PHAM_TIMEOUT_MS || '10000', 10),
    guiKiemPhamRetry: parseInt(process.env.ERP_GUI_KIEM_PHAM_RETRY || '3', 10),
    guiKiemPhamEnabled: String(process.env.ERP_GUI_KIEM_PHAM_ENABLED || 'true').toLowerCase() === 'true',
    // KÉO danh sách phần in GN đã sửa thông tin bên ERP (25/09/2026) — job 5 phút/lần, chỉ cập nhật phần in
    // đang nằm ở *Đơn hàng › Phần in chờ sửa thông tin*. Xem `modules/suathongtin/erpCapNhat.js`.
    dsSuaThongTinUrl: process.env.ERP_DS_PHAN_IN_SUA_THONG_TIN_URL || `${ERP_GOC}/ds-phan-in-sua-thong-tin`,
    dsSuaThongTinEnabled: String(process.env.ERP_DS_PHAN_IN_SUA_THONG_TIN_ENABLED || 'true').toLowerCase() === 'true',

    // Bật/tắt job tự đồng bộ theo chu kỳ (mặc định 5 phút/lần).
    syncEnabled: String(process.env.ERP_SYNC_ENABLED || 'true').toLowerCase() === 'true',
    // Chu kỳ tự đồng bộ (phút). Mặc định 5 phút/lần (sàn tối thiểu 5 — xem jobs/erpSync.job.js).
    syncIntervalMin: parseInt(process.env.ERP_SYNC_INTERVAL_MIN || '5', 10),
    // Cửa sổ lấy dữ liệu: fromDate = hiện tại - N ngày (proc ERP lấy bản ghi tạo TỪ mốc này).
    syncLookbackDays: parseInt(process.env.ERP_SYNC_LOOKBACK_DAYS || '60', 10),
    // Timeout chờ ERP trả về (ms) — ERP chạy proc lâu nên để lớn. Mặc định 10 phút.
    syncTimeoutMs: parseInt(process.env.ERP_SYNC_TIMEOUT_MS || '600000', 10),
    // Header gửi kèm khi gọi ERP (JSON). Mặc định theo quy ước nội bộ X-Internal-Request: WEBAPP.
    apiHeaders: (() => {
      try { return JSON.parse(process.env.ERP_API_HEADERS || '{"X-Internal-Request":"WEBAPP"}'); }
      catch { return { 'X-Internal-Request': 'WEBAPP' }; }
    })(),
    // URL forward proxy để ra mạng nội bộ tới ERP (vd http://10.84.40.x:port). Trống = axios tự đọc HTTP_PROXY env.
    proxyUrl: process.env.ERP_PROXY_URL || null,
    // Số lần thử lại khi ERP lỗi tạm thời (deadlock SQL Server, 5xx, timeout). Mặc định 3.
    retry: parseInt(process.env.ERP_SYNC_RETRY || '3', 10),
  },
};

module.exports = env;
