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
    // API ERP lấy phiếu nhận vải (60 ngày). Có thể override qua .env.
    phieuNhanVaiUrl: process.env.ERP_PHIEU_NHAN_VAI_URL
      || 'http://10.84.40.34:5000/api/server/backup/mes/phieu-nhan-vai-60',
    // Bật/tắt job tự đồng bộ mỗi giờ.
    syncEnabled: String(process.env.ERP_SYNC_ENABLED || 'true').toLowerCase() === 'true',
    // Chu kỳ tự đồng bộ (phút).
    syncIntervalMin: parseInt(process.env.ERP_SYNC_INTERVAL_MIN || '60', 10),
    // Cửa sổ lấy dữ liệu: fromDate = hiện tại - N ngày (proc ERP lấy bản ghi tạo TỪ mốc này).
    syncLookbackDays: parseInt(process.env.ERP_SYNC_LOOKBACK_DAYS || '60', 10),
  },
};

module.exports = env;
