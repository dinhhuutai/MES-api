'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// LOGIC GIAI ĐOẠN DÙNG CHUNG (dashboard.stageCounts ↔ orders.stageCondition).
// Nguyên tắc (đã chốt với người dùng): "Mỗi phần in chỉ ở 1 trạm" — giai đoạn của
// phần in = giai đoạn KÉM TIẾN ĐỘ NHẤT (dominant) trong các đợt vải của nó, để:
//   Σ(phần in ở mỗi checkpoint) = tổng phần in (không đếm lặp), khớp mọi danh sách.
// Suy trực tiếp từ trạng thái runtime (lệnh/phiếu/tem/ket_qua_checkpoint) — KHÔNG
// dùng ton_tram. Query gộp 1 dòng khi gửi (IPS-safe) — tránh comment `-- …`.
// ─────────────────────────────────────────────────────────────────────────────

// Thứ tự tiến độ (đầu mảng = kém tiến độ nhất). Dominant = stage có array_position NHỎ nhất.
// CHO_CHUYEN = đợt vải lấy từ ERP -new nhưng CHƯA qua API chính thức (chưa vào READY) — đứng trước READY.
const STAGE_ORDER = ['CHO_CHUYEN', 'READY_KT', 'READY_QA', 'RELEASE_1', 'TESTRUN_CNSP', 'TESTRUN_QA', 'RELEASE_2',
  'CHO_SAN_XUAT', 'SAN_XUAT', 'CHO_KHO', 'KCS', 'SUA', 'GIA_CONG', 'OQC', 'DANG_GIAO', 'DA_GIAO'];
const ORDER_SQL_ARRAY = `ARRAY[${STAGE_ORDER.map((s) => `'${s}'`).join(',')}]`;

// Nhãn hiển thị cho từng stage nội bộ (dùng ở cột "Trạm hiện tại").
const STAGE_LABEL = {
  CHO_CHUYEN: 'Chờ chuyển READY',
  READY_KT: 'READY (Kỹ thuật)', READY_QA: 'READY (QA)', RELEASE_1: 'Release 1',
  TESTRUN_CNSP: 'Test Run (CNSP)', TESTRUN_QA: 'Test Run (QA)', RELEASE_2: 'Release 2',
  CHO_SAN_XUAT: 'Chờ sản xuất', SAN_XUAT: 'Đang sản xuất', CHO_KHO: 'Chờ khô',
  KCS: 'KCS', SUA: 'Sửa', GIA_CONG: 'Gia công (chờ chuyển OQC)', OQC: 'OQC', DANG_GIAO: 'Đang giao', DA_GIAO: 'Đã giao',
};

// Chip ở màn "Danh sách phần in vải về" → danh sách stage nội bộ tương ứng.
const CHIP_STAGES = {
  READY: ['READY_KT', 'READY_QA'],
  RELEASE_1: ['RELEASE_1'],
  TEST_RUN: ['TESTRUN_CNSP', 'TESTRUN_QA'],
  RELEASE_2: ['RELEASE_2'],
  CHO_SAN_XUAT: ['CHO_SAN_XUAT'],
  SAN_XUAT: ['SAN_XUAT'],
  CHO_KHO: ['CHO_KHO'],
  KCS: ['KCS'],
  SUA: ['SUA'],
  GIA_CONG: ['GIA_CONG'],
  OQC: ['OQC'],
  GIAO: ['DANG_GIAO'],
  DA_GIAO: ['DA_GIAO'],
};

const { techDoneSqlByPin, qcDotSql } = require('./tech');

// CASE tính stage cho 1 ĐỢT VẢI, dựa trên rowsource alias `a` có cột:
//   a.phan_in_id, a.lenh_id (lệnh non-HUY mới nhất của đợt, NULL nếu chưa release), a.lenh_tt,
//   a.tg_chuyen_ready, a.created_date  ← 2 cột sau THÊM 16/09/2026 cho `qcDotSql` (xem ngay dưới).
// ⚠⚠ THÊM CỘT VÀO ĐÂY PHẢI SỬA KÈM 3 ROWSOURCE: `dotSource()` bên dưới · `dvs` trong
//   `dashboard.repository.stageCounts` · `NGUON_DOT` của `phaninadmin.repository` (nguồn này dùng
//   `d.*` nên đã có sẵn). Thiếu là `column a.tg_chuyen_ready does not exist`.
function dotStageCase(a) {
  const temEx = (cond) => `EXISTS(SELECT 1 FROM phieu_san_xuat ps JOIN tem t ON t.phieu_san_xuat_id=ps.id WHERE ps.lenh_san_xuat_id=${a}.lenh_id AND t.trang_thai<>'HUY' AND ${cond})`;
  const kqLenh = (ma) => `EXISTS(SELECT 1 FROM ket_qua_checkpoint k JOIN checkpoint c ON c.id=k.checkpoint_id WHERE k.lenh_san_xuat_id=${a}.lenh_id AND c.ma_checkpoint='${ma}' AND k.trang_thai='DAT')`;
  // ⚠ Nhánh 2 (RELEASE_1 + chưa có phiếu + phần in CHƯA QC) = TEST RUN KHÔNG ĐẠT, QA trả về Kỹ thuật:
  // lệnh được GIỮ NGUYÊN (để QC xong nhảy lại Test Run) nên đợt vẫn có lenh_id — nếu không có nhánh này,
  // dashboard/chip sẽ đếm phần in ở Test Run trong khi thực tế nó đang nằm ở READY chờ làm lại.
  // Bất biến: release luôn đòi QC xong ⇒ QC bị hủy + chưa in tem = đang làm lại READY.
  // ⚠ THỨ TỰ TRÌNH TỰ (chốt 15/09/2026): READY → Release 1 → Test Run → Release 2 → Chờ SX → SX → Chờ khô
  //   → KCS → Sửa → OQC → Giao. Lệnh `RELEASE_2` được xét TRƯỚC các nhánh tem: lệnh "Ngừng lệnh chạy"
  //   quay về RELEASE_2 mà đã có tem vẫn là CHỜ SẢN XUẤT (còn phải in tiếp) — kém tiến độ hơn tem đã in.
  //   Lệnh đã có phiếu (SAN_XUAT/HOAN_TAT) nhưng không còn tem sống ⇒ vẫn Chờ SX, KHÔNG rơi về Test Run.
  // ⚠⚠ QC XÉT THEO **ĐỢT VẢI** (`qcDotSql`), KHÔNG theo phần in (đổi 16/09/2026 — xem `utils/tech.js`).
  //   Trước đây `kqPin('QC_XAC_NHAN')` làm ĐỢT VẢI VỪA VỀ **thừa hưởng** READY của đợt trước ⇒ nhảy
  //   thẳng 'RELEASE_1' dù chưa ai đụng tới nó. Nay đợt về SAU mốc QC vẫn ở READY_KT/READY_QA, còn đợt
  //   cũ (về trước mốc) giữ nguyên 'RELEASE_1' ⇒ 1 phần in có thể vừa ở READY vừa ở Release 1 — đúng
  //   như nghiệp vụ đi theo đợt vải. `kqPin` GIỮ cho các nhánh khác (TEST_CNSP/TEST_QA mức lệnh).
  const qcDot = qcDotSql(a, `${a}.phan_in_id`);
  return `CASE
      WHEN ${a}.lenh_id IS NULL THEN
        CASE WHEN ${qcDot} THEN 'RELEASE_1'
             WHEN ${techDoneSqlByPin(`${a}.phan_in_id`)} THEN 'READY_QA'
             ELSE 'READY_KT' END
      WHEN ${a}.lenh_tt='RELEASE_1'
           AND NOT EXISTS(SELECT 1 FROM phieu_san_xuat ps WHERE ps.lenh_san_xuat_id=${a}.lenh_id)
           AND NOT ${qcDot} THEN
        CASE WHEN ${techDoneSqlByPin(`${a}.phan_in_id`)} THEN 'READY_QA' ELSE 'READY_KT' END
      WHEN ${a}.lenh_tt='GIA_CONG' THEN 'GIA_CONG'
      WHEN EXISTS(SELECT 1 FROM phieu_san_xuat ps WHERE ps.lenh_san_xuat_id=${a}.lenh_id AND ps.trang_thai='DANG_CHAY') THEN 'SAN_XUAT'
      WHEN ${a}.lenh_tt='RELEASE_2' THEN 'CHO_SAN_XUAT'
      WHEN ${temEx("t.trang_thai IN ('IN','DANG_PHOI')")} THEN 'CHO_KHO'
      WHEN ${temEx("t.trang_thai='DA_KHO'")} THEN 'KCS'
      WHEN ${temEx("t.trang_thai='CHO_SUA'")} THEN 'SUA'
      WHEN ${temEx("t.trang_thai='CHO_OQC'")} THEN 'OQC'
      WHEN ${temEx("t.trang_thai='OQC_DAT'")} THEN 'DANG_GIAO'
      WHEN ${temEx("t.trang_thai='DA_GIAO'")} THEN 'DA_GIAO'
      WHEN ${a}.lenh_tt IN ('SAN_XUAT','HOAN_TAT') THEN 'CHO_SAN_XUAT'
      WHEN ${kqLenh('TEST_CNSP')} AND ${kqLenh('TEST_QA')} THEN 'RELEASE_2'
      WHEN ${kqLenh('TEST_CNSP')} THEN 'TESTRUN_QA'
      ELSE 'TESTRUN_CNSP' END`;
}

// Giai đoạn "dự phòng" khi phần in KHÔNG có đợt vải sống nào (dotSource rỗng).
//
// ⚠⚠ ĐỔI 15/09/2026 — HỆ THỐNG ĐI THEO ĐỢT VẢI: phần in KHÔNG còn đợt vải sống thì KHÔNG thuộc giai
//   đoạn nào (trả NULL ⇒ không lọt vào chip/ô READY nào). Bỏ luôn nhánh CHO_CHUYEN (API ERP "-new" đã gỡ
//   từ 27/07, đo prod 15/09: 0 đợt tg_chuyen_ready NULL). Tham số giữ để không đổi chữ ký hàm.
// eslint-disable-next-line no-unused-vars
function readyFallback(pinId) {
  return 'NULL::text';
}

// Rowsource các đợt vải (không DA_GOP/DA_HUY, ĐÃ vào READY — tg_chuyen_ready ≠ null) của phần in + lệnh non-HUY mới nhất.
// Đợt CHỜ chuyển (pending) bị loại ⇒ dominant chỉ tính đợt đã vào dòng chảy; pending → readyFallback ('CHO_CHUYEN').
function dotSource(pinId) {
  const lenh = (col) => `(SELECT ls.${col} FROM lenh_sx_dot_vai lsd JOIN lenh_san_xuat ls ON ls.id=lsd.lenh_san_xuat_id WHERE lsd.dot_vai_ve_id=d.id AND ls.trang_thai<>'HUY' ORDER BY ls.created_date DESC LIMIT 1)`;
  return `SELECT d.phan_in_id, d.tg_chuyen_ready, d.created_date, ${lenh('id')} AS lenh_id, ${lenh('trang_thai')} AS lenh_tt FROM dot_vai_ve d WHERE d.phan_in_id=${pinId} AND d.trang_thai NOT IN ('DA_GOP','DA_HUY') AND d.tg_chuyen_ready IS NOT NULL`;
}

// Biểu thức SCALAR: stage dominant của phần in `pinId` (dùng ở orders.stageCondition).
function dominantStageScalar(pinId) {
  return `COALESCE((SELECT z.stage FROM (SELECT (${dotStageCase('s')}) AS stage, array_position(${ORDER_SQL_ARRAY}, (${dotStageCase('s')})) AS rnk FROM (${dotSource(pinId)}) s) z ORDER BY z.rnk LIMIT 1), ${readyFallback(pinId)})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// GIAI ĐOẠN HIỆN TẠI CỦA MỘT **LỆNH CHƯA VÀO SẢN XUẤT** (chưa có `phieu_san_xuat`).
// Dùng ở cột "Giai đoạn" màn *Lập kế hoạch lại* — trước 04/09/2026 màn đó suy từ mỗi
// `lenh_san_xuat.trang_thai` (`RELEASE_1` → luôn ghi "Test Run") nên hiện **trạm đã đi qua gần nhất**
// chứ không phải trạm ĐANG Ở: lệnh đã test xong vẫn ghi "Test Run", lệnh bị Test Run trả về Kỹ thuật
// (còn `RELEASE_1` nhưng phần in đã bị hủy QC) cũng ghi "Test Run" trong khi nó đang nằm ở READY.
//
// ⚠⚠ ĐÂY LÀ BẢN RÚT GỌN CỦA `dotStageCase`, CHỈ ĐÚNG KHI LỆNH CHƯA CÓ PHIẾU SẢN XUẤT — mọi nhánh
//   tem/phiếu của `dotStageCase` khi đó không bao giờ đúng nên lược bỏ được, và query nhẹ hơn hẳn
//   (màn replan gửi SQL gộp 1 dòng, IPS-safe). **Đừng dùng cho màn có lệnh đã in tem.**
// ⚠ Thứ tự nhánh GIỮ Y HỆT `dotStageCase` để 2 hàm không bao giờ ra 2 kết quả khác nhau trên cùng
//   một lệnh; sửa luật ở `dotStageCase` thì soát lại hàm này.
// ⚠ Lệnh GOM SET: "còn phần in nào chưa QC" ⇒ cả lệnh coi như đang ở READY (đúng với `cho_ky_thuat`
//   mà màn Test Run đang dùng để khóa thao tác) — không thể vẽ 1 lệnh ở 2 trạm cùng lúc.
function lenhStageCase(lenhCol, trangThaiCol) {
  const kqLenh = (ma) => `EXISTS(SELECT 1 FROM ket_qua_checkpoint k JOIN checkpoint c ON c.id=k.checkpoint_id WHERE k.lenh_san_xuat_id=${lenhCol} AND c.ma_checkpoint='${ma}' AND k.trang_thai='DAT')`;
  // ⚠ QC theo ĐỢT VẢI (`qcDotSql`) y như `dotStageCase` — đợt của lệnh này đã release nên luôn về
  //   TRƯỚC mốc QC ⇒ đợt vải MỚI của phần in KHÔNG kéo lệnh đã release ngược về READY. Chỉ ca QC bị
  //   HỦY thật (Test Run trả về Kỹ thuật) mới cho ra READY, đúng như trước.
  const conPinChuaQc = `EXISTS(SELECT 1 FROM lenh_sx_dot_vai lg JOIN dot_vai_ve dg ON dg.id=lg.dot_vai_ve_id WHERE lg.lenh_san_xuat_id=${lenhCol} AND NOT ${qcDotSql('dg', 'dg.phan_in_id')})`;
  const duMucKt = `EXISTS(SELECT 1 FROM lenh_sx_dot_vai lt JOIN dot_vai_ve dt ON dt.id=lt.dot_vai_ve_id WHERE lt.lenh_san_xuat_id=${lenhCol} AND ${techDoneSqlByPin('dt.phan_in_id')})`;
  return `CASE
      WHEN ${trangThaiCol}='GIA_CONG' THEN 'GIA_CONG'
      WHEN ${trangThaiCol}='RELEASE_1' AND ${conPinChuaQc} THEN
        CASE WHEN ${duMucKt} THEN 'READY_QA' ELSE 'READY_KT' END
      WHEN ${trangThaiCol}='RELEASE_2' THEN 'CHO_SAN_XUAT'
      WHEN ${kqLenh('TEST_CNSP')} AND ${kqLenh('TEST_QA')} THEN 'RELEASE_2'
      WHEN ${kqLenh('TEST_CNSP')} THEN 'TESTRUN_QA'
      ELSE 'TESTRUN_CNSP' END`;
}

// Điều kiện WHERE cho 1 chip (orders). stage='' | 'ALL' → null (không lọc giai đoạn).
function chipCondition(chip, pinId = 'pin.id') {
  const stages = CHIP_STAGES[chip];
  if (!stages) return null;
  return `(${dominantStageScalar(pinId)}) IN (${stages.map((s) => `'${s}'`).join(',')})`;
}

module.exports = {
  STAGE_ORDER, ORDER_SQL_ARRAY, CHIP_STAGES, STAGE_LABEL,
  dotStageCase, readyFallback, dotSource, dominantStageScalar, chipCondition, lenhStageCase,
};
