'use strict';

// Khoảng ngày `?tuNgay=&denNgay=` (YYYY-MM-DD) của các báo cáo / danh sách theo ngày.
// Thiếu/sai ⇒ hôm nay (giờ VN); đảo ngược ⇒ tự đổi chỗ; dài quá `toiDa` ngày ⇒ cắt bớt ĐẦU (giữ đúng ngày cuối).
// Dùng chung: Báo cáo dừng chuyền · Báo cáo kiểm hàng (production) · Danh sách finish (quality).

const ngayHomNayVN = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const laNgay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const congNgay = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function khoangNgayTuQuery(q = {}, toiDa = 93) {
  const homNay = ngayHomNayVN();
  const a = String(q.tuNgay || '').trim();
  const b = String(q.denNgay || '').trim();
  let tu = laNgay(a) ? a : (laNgay(b) ? b : homNay);
  let den = laNgay(b) ? b : tu;
  if (tu > den) [tu, den] = [den, tu];
  if (congNgay(tu, toiDa - 1) < den) tu = congNgay(den, -(toiDa - 1));
  return { tu, den };
}

module.exports = { ngayHomNayVN, laNgay, congNgay, khoangNgayTuQuery };
