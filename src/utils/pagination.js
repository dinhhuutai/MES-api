'use strict';

// Trần mặc định — LƯỚI AN TOÀN chống query nặng bất ngờ. Giữ nguyên 200 cho MỌI endpoint chưa khai
// gì, để không endpoint nào tự dưng đổi hành vi.
const TRAN_MAC_DINH = 200;

// Chuẩn hóa tham số phân trang từ query string.
//
// ⚠⚠ `tranToiDa` là OPT-IN (19/08/2026): endpoint mà FE tải-hết bằng `utils/taiHetTrang.js` được nới
//   để lấy trọn danh sách trong MỘT lượt. Lý do — đo thật trên prod màn Test Run - QA:
//     · SQL lấy 200 dòng  : 161-222 ms
//     · SQL lấy 663 dòng  : 156-205 ms  ← BẰNG lấy 200 dòng
//   ⇒ phân trang KHÔNG làm câu truy vấn nhẹ đi, nó chỉ nhân số round-trip lên 4 lần (kèm 4 câu đếm,
//   4 câu gắn phần in). Một lần mở màn tốn ~40 lượt gọi DB thay vì 4.
// ⚠ CHỈ nới cho endpoint ĐÃ ĐO là nhẹ. Đừng nâng `TRAN_MAC_DINH` — trần đó đang che cho những
//   endpoint chưa ai đo bao giờ.
function getPaging(query, { tranToiDa = TRAN_MAC_DINH } = {}) {
  let page = parseInt(query.page, 10);
  let limit = parseInt(query.limit, 10);
  if (!Number.isInteger(page) || page < 1) page = 1;
  if (!Number.isInteger(limit) || limit < 1) limit = 20;
  const tran = Number.isInteger(tranToiDa) && tranToiDa > 0 ? tranToiDa : TRAN_MAC_DINH;
  if (limit > tran) limit = tran;
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

// Trần cho các endpoint phục vụ màn TẢI-HẾT (FE dùng `taiHetTrang`). Khai một chỗ để mọi controller
// dùng chung con số, khỏi rải hằng số khắp nơi.
//
// ⚠ Chọn 2000 vì màn LỚN NHẤT hiện nay là *Lập kế hoạch lại* với 1185 lệnh (đo prod 19/08/2026).
//   Đo thật: lấy 1185 dòng tốn **209-265 ms**, còn NHANH HƠN lấy 1000 dòng — kích thước tập không
//   phải yếu tố quyết định, độ trễ nằm ở số round-trip.
// ⚠ Vượt trần KHÔNG hỏng gì: vòng lặp trong `taiHetTrang` tự lấy tiếp trang sau, chỉ tốn thêm lượt.
//   Nên đừng nâng con số này vô tội vạ — nó là lưới chặn một lượt tải quá lớn.
const TRAN_TAI_HET = 2000;

function buildMeta(page, limit, total) {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

module.exports = { getPaging, buildMeta, TRAN_MAC_DINH, TRAN_TAI_HET };
