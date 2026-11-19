'use strict';

// ═════════════════════════════════════════════════════════════════════════════
// DANH MỤC API ĐỌC mà MCP `mes-web` được gọi (19/11/2026). CHỈ GET, chỉ các đường ở đây (danh sách TRẮNG).
// Gọi bằng chính JWT của người hỏi ⇒ rbac của từng route vẫn áp: người hỏi không xem được màn nào thì AI
// cũng không đọc được màn đó (403).
// ⚠ CỐ Ý KHÔNG mở: người dùng / phiên / quyền / cài đặt API / ERP / tài chính / lợi nhuận — gói Gemini miễn phí
//   cho Google dùng dữ liệu gửi lên, đừng thêm các nhóm này nếu chưa hỏi người dùng.
// Thêm API: thêm 1 dòng { duong_dan, mo_ta, truy_van } — `:x` là tham số đường dẫn.
// ═════════════════════════════════════════════════════════════════════════════

const NGAY = 'YYYY-MM-DD';

const DANH_MUC_API = [
  // Tổng quan / nghẽn
  { duong_dan: '/dashboard/sla-tong-quan', mo_ta: 'Tổng quan nghẽn theo trạm: số đợt vải đang chạy, nghẽn (quá SLA), sắp nghẽn — từng trạm' },
  { duong_dan: '/dashboard/tinh-trang/summary', mo_ta: 'Số phần in đang chạy chưa giao + danh sách phần in nghẽn / sắp nghẽn (trạm, khách, mã hàng)' },
  { duong_dan: '/dashboard/flow', mo_ta: 'Danh sách đợt vải đang nằm ở các trạm, số phút đã ở, SLA, owner', truy_van: 'tram=<mã trạm vd READY, TEST_RUN>, filter=all|NGHEN|SAP_NGHEN' },
  { duong_dan: '/dashboard/lich-su-nghen', mo_ta: 'Lịch sử nghẽn (đã vượt SLA) theo trạm / checklist trong khoảng ngày', truy_van: `from=${NGAY}, to=${NGAY}, tram=<mã trạm>, level=all|TRAM|CHECKLIST` },
  { duong_dan: '/dashboard/stage-counts', mo_ta: 'Đếm phần in / đợt vải ở từng giai đoạn của dòng chảy' },
  { duong_dan: '/dashboard/summary', mo_ta: 'Số liệu tổng quan của Dashboard' },
  { duong_dan: '/dashboard/hoan-thanh-hom-nay', mo_ta: 'Các xác nhận đã hoàn thành hôm nay' },
  { duong_dan: '/ly-do-nghen/lich-su', mo_ta: 'Lịch sử lý do nghẽn người dùng đã ghi khi xác nhận quá SLA' },
  { duong_dan: '/thoi-gian-tram', mo_ta: 'Thời gian phần in / đợt vải nằm ở từng trạm (Dashboard › Thời gian trạm)' },
  // Sĩ số trạm (dải Theo dõi)
  { duong_dan: '/si-so/danh-muc', mo_ta: 'Danh mục các trang có dải Theo dõi (sĩ số trạm) và mã trang dùng cho /si-so/:maTrang' },
  { duong_dan: '/si-so/:maTrang', mo_ta: 'Sĩ số 1 trang: tồn đầu, nhận, làm được, tồn cuối, quá SLA', truy_van: `tu=${NGAY}, den=${NGAY}` },
  { duong_dan: '/si-so/bang-theo-doi', mo_ta: 'Bảng theo dõi tổng hợp mọi trạm (tồn, nghẽn)', truy_van: `tu=${NGAY}, den=${NGAY}` },
  // Phần in / mã quét
  { duong_dan: '/dashboard/tinh-trang/resolve', mo_ta: 'Giải mã 1 mã quét (QR code phần, mã tem, barcode đợt vải, barcode HSKT) ra loại + code phần', truy_van: 'code=<mã>' },
  { duong_dan: '/dashboard/tinh-trang/phan-in', mo_ta: 'Tìm phần in theo code phần / mã hàng / khách', truy_van: 'search=<chuỗi>, limit=<≤100>' },
  { duong_dan: '/dashboard/tinh-trang/phan-in/:id', mo_ta: 'Tình trạng 1 phần in (id) theo từng đợt vải: đang ở trạm nào, đã ở bao lâu, SLA' },
  { duong_dan: '/lich-su-phan-in/tim', mo_ta: 'Tìm phần in để xem lịch sử thao tác', truy_van: 'q=<code phần / barcode>' },
  { duong_dan: '/lich-su-phan-in/:phanInId', mo_ta: 'Lịch sử mọi thao tác + thay đổi tự động của 1 phần in' },
  { duong_dan: '/phan-in', mo_ta: 'Danh sách phần in vải về (Đơn hàng)', truy_van: 'search=<chuỗi>, page, limit' },
  { duong_dan: '/phan-in/:id', mo_ta: 'Chi tiết 1 phần in: đợt vải, lệnh, tem' },
  // Sản xuất
  { duong_dan: '/production/bao-cao-ngay', mo_ta: 'Báo cáo sản xuất 1 ngày (theo chuyền, tổ, ca)', truy_van: `ngay=${NGAY}` },
  { duong_dan: '/production/theo-doi-to', mo_ta: 'Theo dõi sản xuất theo tổ in trong 1 ngày', truy_van: `ngay=${NGAY}` },
  { duong_dan: '/production/bao-cao-dung-chuyen', mo_ta: 'Báo cáo bất thường dừng chuyền (ngưng chuyền, lý do)', truy_van: `tuNgay=${NGAY}, denNgay=${NGAY}` },
  { duong_dan: '/production/bao-cao-kiem-hang', mo_ta: 'Báo cáo kiểm hàng (KCS): đạt, hư theo tem / chuyền', truy_van: `tuNgay=${NGAY}, denNgay=${NGAY}` },
  { duong_dan: '/production/bao-cao-sua-hang', mo_ta: 'Báo cáo sửa hàng', truy_van: `tuNgay=${NGAY}, denNgay=${NGAY}` },
  { duong_dan: '/production/bao-cao-phan-loai-loi', mo_ta: 'Báo cáo phân loại lỗi theo mã lỗi', truy_van: `tuNgay=${NGAY}, denNgay=${NGAY}` },
  { duong_dan: '/production/ds-release', mo_ta: 'Danh sách release của sản xuất theo ngày in tem', truy_van: `tuNgay=${NGAY}, denNgay=${NGAY} (≤ 62 ngày)` },
  { duong_dan: '/production/monitor', mo_ta: 'Giám sát sản xuất: lệnh đang chạy trên các chuyền' },
  { duong_dan: '/production/lich-su-hoan-tat', mo_ta: 'Lịch sử lượt chạy hoàn tất', truy_van: `tuNgay=${NGAY}, denNgay=${NGAY}, search, page, limit` },
  { duong_dan: '/production/tem/danh-sach', mo_ta: 'Danh sách tem đã in', truy_van: `search, ngayCaTu=${NGAY}, ngayCaDen=${NGAY}, chuyen, codePhan, maTem, page, limit` },
  { duong_dan: '/chuyen', mo_ta: 'Danh sách chuyền sản xuất', truy_van: 'search' },
  // Chất lượng
  { duong_dan: '/quality/kcs/candidates', mo_ta: 'Tem đang chờ KCS kiểm', truy_van: 'search, page, limit' },
  { duong_dan: '/quality/sua/candidates', mo_ta: 'Tem đang ở màn Sửa', truy_van: 'search, page, limit' },
  { duong_dan: '/quality/sua/cho-nhan', mo_ta: 'Tem hư đã phân loại, chờ nhận sửa' },
  { duong_dan: '/quality/oqc/candidates', mo_ta: 'Tem đang chờ OQC', truy_van: 'search, page, limit' },
  { duong_dan: '/quality/oqc/finish-list', mo_ta: 'Danh sách phần in finish (7 điều kiện)' },
  { duong_dan: '/quality/tra-ve/danh-sach', mo_ta: 'Danh sách trả về (READY, Release 1, Test Run, OQC…) chưa xử lý' },
  { duong_dan: '/quality/tem/:temId/hanh-trinh', mo_ta: 'Hành trình 1 tem: in, KCS, sửa, OQC, giao' },
  // Kỹ thuật / kế hoạch
  { duong_dan: '/ready/candidates', mo_ta: 'Danh sách đợt vải ở READY (chờ Khuôn / Film / Mực / HSKT)', truy_van: 'search, page, limit' },
  { duong_dan: '/ready/qc-candidates', mo_ta: 'Danh sách chờ QC xác nhận READY', truy_van: 'search, page, limit' },
  { duong_dan: '/ready/item-counts', mo_ta: 'Đếm số mục READY còn chờ theo từng checklist' },
  { duong_dan: '/planning/release1/candidates', mo_ta: 'Danh sách chờ Release 1', truy_van: 'search, page, limit' },
  { duong_dan: '/planning/test-run/candidates', mo_ta: 'Hàng đợi Test Run của QA', truy_van: 'search, page, limit' },
  { duong_dan: '/planning/release2/candidates', mo_ta: 'Danh sách chờ chạy (Release 2)', truy_van: 'search, page, limit' },
  { duong_dan: '/planning/ke-hoach-tam/danh-sach', mo_ta: 'Danh sách kế hoạch tạm' },
  { duong_dan: '/planning/gia-cong', mo_ta: 'Lệnh đang gia công' },
  { duong_dan: '/planning/release-list', mo_ta: 'Danh sách release (doanh thu theo SL release)', truy_van: `tuNgay=${NGAY}, denNgay=${NGAY}` },
  // Giao hàng
  { duong_dan: '/giao-hang/tem-san-sang', mo_ta: 'Tem đã tích, sẵn sàng giao' },
  { duong_dan: '/giao-hang/history', mo_ta: 'Lịch sử phiếu giao', truy_van: `tuNgay=${NGAY}, denNgay=${NGAY}, search` },
  { duong_dan: '/giao-hang/done-delivery', mo_ta: 'Danh sách DONE DELIVERY' },
  // Báo cáo đã thiết kế + KPI
  { duong_dan: '/bao-cao', mo_ta: 'Danh sách báo cáo đã thiết kế trong module Báo cáo' },
  { duong_dan: '/bao-cao/:id', mo_ta: 'Định nghĩa 1 báo cáo đã thiết kế' },
  { duong_dan: '/kpi-ready', mo_ta: 'KPI READY (5 KPI + bảng theo dõi phần in qua các cột checklist)' },
];

const MAU = DANH_MUC_API.map((a) => ({
  ...a,
  re: new RegExp(`^${a.duong_dan.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z]+/g, '[A-Za-z0-9_.%-]+')}$`),
}));

/** Đường dẫn có trong danh sách trắng không (đã cắt query string, không có `..`). */
function duocPhep(duongDan) {
  const p = String(duongDan || '').split('?')[0].replace(/\/+$/, '') || '/';
  if (!p.startsWith('/') || p.includes('..') || p.includes('//')) return null;
  return MAU.find((m) => m.re.test(p)) ? p : null;
}

module.exports = { DANH_MUC_API, duocPhep };
