'use strict';

const { tangPhienBan } = require('../utils/cacheDoc');

// Mọi request GHI (POST/PUT/PATCH/DELETE) ⇒ tăng "phiên bản dữ liệu" của cache đọc (`utils/cacheDoc.js`) lúc BẮT ĐẦU
// và lúc KẾT THÚC — xác nhận ở màn nào thì mọi danh sách / dải "Theo dõi" của mọi màn đều tính lại ở lượt đọc kế.
// Tăng cả khi request lỗi (thà tính lại thừa còn hơn giữ số cũ).
// Bỏ qua vài đường ghi KHÔNG đổi dữ liệu dòng chảy, gọi rất dày (đăng nhập, thông báo, online, xem báo cáo).
const BO_QUA = /^\/api\/(auth|thong-bao|presence)(\/|$)|^\/api\/bao-cao\/[^/]+\/render$/;

module.exports = function danhDauGhi(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || BO_QUA.test(req.path)) return next();
  tangPhienBan();
  let xong = false;
  const ket = () => { if (!xong) { xong = true; tangPhienBan(); } };
  res.on('finish', ket);
  res.on('close', ket);
  return next();
};
