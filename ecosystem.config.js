'use strict';

// Cấu hình PM2 cho production. Chạy trong thư mục backend:  pm2 start ecosystem.config.js --update-env  rồi  pm2 save
// ⚠ GIỮ 1 TIẾN TRÌNH (fork). Đừng đổi sang cluster khi chưa làm lại kiến trúc: cache đọc + phiên bản dữ liệu (utils/cacheDoc.js),
//   danh sách online (sockets/presence.js) nằm trong RAM của tiến trình; job đồng bộ ERP / phơi khô / dọn dẹp sẽ chạy N lần;
//   socket.io polling cần sticky session. Đo prod: Node không phải nút cổ chai, phần tốn CPU là truy vấn Postgres.
module.exports = {
  apps: [{
    name: 'thla-mes-api',
    script: 'src/index.js',
    exec_mode: 'fork',
    instances: 1,
    node_args: '--max-old-space-size=1536',
    max_memory_restart: '1800M',
    restart_delay: 3000,
    max_restarts: 20,
    min_uptime: '30s',
    time: true,
    merge_logs: true,
    env: {
      NODE_ENV: 'production',
      // Nén gzip chạy ở threadpool của Node (mặc định 4 luồng). Danh sách lớn nhiều người tải cùng lúc thì 8 luồng đỡ xếp hàng.
      UV_THREADPOOL_SIZE: '8',
    },
  }],
};
