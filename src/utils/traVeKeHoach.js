'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// TEST RUN TRẢ VỀ KẾ HOẠCH (RELEASE 1) — GIỮ LỆNH (07/10/2026, người dùng chốt: "trả về lại Release 1 là
// vẫn giữ lệnh sản xuất, chỉ thông báo và badge Test Run trả về").
//
// Luồng: QA ở màn Test Run bấm "Trả về Kế hoạch" (lý do bắt buộc) → ghi `qc_tra_ve` loai `TEST_RUN_KH`
// (1 dòng / đợt vải của lệnh, mang cả `lenh_san_xuat_id` + `phan_in_id` để thông báo/Danh sách trả về đọc
// được) → lệnh KHÔNG đổi trạng thái (vẫn `RELEASE_1`, giữ kết quả test cũ) nhưng TẠM RỜI màn Test Run /
// Release 2 và hiện ở khối "Test Run trả về" đầu màn Release 1 kèm badge + chuông cho Kế hoạch → Kế hoạch
// "Xác nhận Release 1" (đổi chuyền / ngày / giờ / thợ in được — đổi thì đi qua `planning.replan`) ⇒ cờ
// `da_xu_ly` ⇒ lệnh quay lại Test Run.
//
// ⚠ Cờ ở MỨC LỆNH (khác Trả về GN — mức phần in). Lệnh đã HỦY / đã có phiếu thì cờ còn sót là vô hại: mọi
//   chỗ đọc đều kèm điều kiện lệnh `RELEASE_1` chưa phiếu.
// ⚠ Gương ở: `planning.repository lenhWhere` (ẩn khỏi Test Run/Release 2) · `lenhChoKyThuat` (khóa thao tác
//   test, 409 `CHO_KE_HOACH`) · `utils/stage.js dotStageCase/lenhStageCase` + `dashboard.flowRows` (giai
//   đoạn = Release 1). Dải "Theo dõi" (`siSoTram`) CHƯA gương — như Trả về GN.
// ─────────────────────────────────────────────────────────────────────────────

const LOAI_TRA_VE_KH = 'TEST_RUN_KH';

// Lệnh `lenhCol` đang chờ Kế hoạch xác nhận lại (còn cờ TEST_RUN_KH chưa xử lý).
const LENH_CHO_KH_SQL = (lenhCol) => `EXISTS (SELECT 1 FROM qc_tra_ve zkh WHERE zkh.lenh_san_xuat_id = ${lenhCol} AND zkh.loai = '${LOAI_TRA_VE_KH}' AND zkh.da_xu_ly = false)`;

// Mốc bị trả về gần nhất còn hiệu lực (NULL nếu không) — mốc vào lại Release 1 cho đồng hồ nghẽn.
const MOC_TRA_VE_KH_SQL = (lenhCol) => `(SELECT max(zkm.created_date) FROM qc_tra_ve zkm WHERE zkm.lenh_san_xuat_id = ${lenhCol} AND zkm.loai = '${LOAI_TRA_VE_KH}' AND zkm.da_xu_ly = false)`;

module.exports = { LOAI_TRA_VE_KH, LENH_CHO_KH_SQL, MOC_TRA_VE_KH_SQL };
