'use strict';

require('dotenv').config();

function required(name, fallback) {
  const val = process.env[name] ?? fallback;
  if (val === undefined) {
    throw new Error(`Thiếu biến môi trường bắt buộc: ${name}`);
  }
  return val;
}

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
    phieuNhanVaiUrl: process.env.ERP_PHIEU_NHAN_VAI_URL
      || 'http://10.84.40.34:5000/api/server/backup/mes/phieu-nhan-vai-60',
    // API ERP lấy phiếu nhận vải TRƯỚC (khai báo, CHƯA qua READY). Mặc định = URL chính thức + '-new'.
    phieuNhanVaiNewUrl: process.env.ERP_PHIEU_NHAN_VAI_NEW_URL
      || (process.env.ERP_PHIEU_NHAN_VAI_URL
        ? `${process.env.ERP_PHIEU_NHAN_VAI_URL}-new`
        : 'http://10.84.40.34:5000/api/server/backup/mes/phieu-nhan-vai-60-new'),
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
