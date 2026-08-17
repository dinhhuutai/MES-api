'use strict';

// ⚠ ĐÃ CHUYỂN sang `src/utils/flowCache.js` (16/08/2026) vì nay **2 module dùng chung**: báo cáo
// (metric nghẽn + khối danh sách) và dashboard (5 endpoint). File này giữ lại làm lớp bọc mỏng để
// các import cũ trong `bao-cao` không phải sửa — ĐỪNG nhân bản logic cache ở đây.
module.exports = require('../../utils/flowCache');
