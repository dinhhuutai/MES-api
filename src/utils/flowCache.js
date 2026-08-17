'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Cache ngắn `dashboardRepo.flowRows('')` — query NẶNG (quét toàn bộ đợt vải + suy trạm hiện tại
// + SLA). Đây là **cơ chế "càng nhiều người đăng nhập càng chậm"** của hệ:
//   · `flowRows('')` được 5 endpoint dashboard gọi: `/bang-2` · `/dieu-phoi` · `/nghen-map` ·
//     `/sla-tong-quan` · `/flow` (nhánh không lọc trạm).
//   · Hook FE `useNghenMap` chạy trên **7 trang** thao tác và tải lại theo sự kiện socket
//     BROADCAST ⇒ mỗi lượt broadcast là N người cùng bắn 1 query nặng. 20 người = 20 lượt.
// Gộp lại còn **1 lượt chạy thật** trong mỗi cửa sổ TTL, bất kể bao nhiêu người.
//
// ⚠ Đặt ở `utils/` vì nay 2 module dùng chung (`dashboard` + `bao-cao`) — `bao-cao/flowCache.js`
//   chỉ còn là lớp bọc mỏng import lại từ đây, đừng nhân bản logic.
// ⚠ CHỈ cache nhánh `tram = ''`. `/flow?tram=X` lọc theo trạm cụ thể ⇒ gọi thẳng repo.
// ⚠ Lỗi thì XÓA cache ngay (`_promise = null`) để lần sau thử lại, không giữ promise hỏng.
// ─────────────────────────────────────────────────────────────────────────────
const dashboardRepo = require('../modules/dashboard/dashboard.repository');

// 5s: đủ để gộp một đợt broadcast (job phơi khô bắn mỗi 60s, người dùng bấm rải rác) mà số liệu
// vẫn coi như realtime với mắt người.
const TTL_MS = 5000;
let _promise = null;
let _at = 0;

function flowRowsCached() {
  if (_promise && Date.now() - _at < TTL_MS) return _promise;
  _at = Date.now();
  _promise = dashboardRepo.flowRows('').catch((e) => { _promise = null; throw e; });
  return _promise;
}

// Gọi khi cần số liệu tươi ngay (hiện chưa có chỗ dùng — để sẵn cho luồng ghi nếu sau này cần).
function xoaCache() { _promise = null; _at = 0; }

module.exports = { flowRowsCached, xoaCache, TTL_MS };
