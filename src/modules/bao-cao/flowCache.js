'use strict';

// Cache ngắn `dashboardRepo.flowRows()` — query NẶNG (quét toàn bộ đợt vải + suy trạm hiện tại + SLA).
// 1 báo cáo có thể vừa có metric nghẽn vừa có khối danh sách "Phần in / đợt vải" và "Tổng hợp theo trạm"
// ⇒ không cache thì chạy 3 lần cùng 1 query. TTL ngắn để số liệu vẫn realtime theo từng lượt render.
const dashboardRepo = require('../dashboard/dashboard.repository');

const TTL_MS = 3000;
let _promise = null;
let _at = 0;

function flowRowsCached() {
  if (_promise && Date.now() - _at < TTL_MS) return _promise;
  _at = Date.now();
  _promise = dashboardRepo.flowRows('').catch((e) => { _promise = null; throw e; });
  return _promise;
}

module.exports = { flowRowsCached };
