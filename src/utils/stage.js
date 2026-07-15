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
const STAGE_ORDER = ['READY_KT', 'READY_QA', 'RELEASE_1', 'TESTRUN_CNSP', 'TESTRUN_QA', 'RELEASE_2',
  'CHO_SAN_XUAT', 'SAN_XUAT', 'CHO_KHO', 'KCS', 'SUA', 'OQC', 'DANG_GIAO', 'DA_GIAO'];
const ORDER_SQL_ARRAY = `ARRAY[${STAGE_ORDER.map((s) => `'${s}'`).join(',')}]`;

// Nhãn hiển thị cho từng stage nội bộ (dùng ở cột "Trạm hiện tại").
const STAGE_LABEL = {
  READY_KT: 'READY (Kỹ thuật)', READY_QA: 'READY (QA)', RELEASE_1: 'Release 1',
  TESTRUN_CNSP: 'Test Run (CNSP)', TESTRUN_QA: 'Test Run (QA)', RELEASE_2: 'Release 2',
  CHO_SAN_XUAT: 'Chờ sản xuất', SAN_XUAT: 'Đang sản xuất', CHO_KHO: 'Chờ khô',
  KCS: 'KCS', SUA: 'Sửa', OQC: 'OQC', DANG_GIAO: 'Đang giao', DA_GIAO: 'Đã giao',
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
  OQC: ['OQC'],
  GIAO: ['DANG_GIAO'],
  DA_GIAO: ['DA_GIAO'],
};

// CASE tính stage cho 1 ĐỢT VẢI, dựa trên rowsource alias `a` có cột:
//   a.phan_in_id, a.lenh_id (lệnh non-HUY mới nhất của đợt, NULL nếu chưa release), a.lenh_tt.
function dotStageCase(a) {
  const temEx = (cond) => `EXISTS(SELECT 1 FROM phieu_san_xuat ps JOIN tem t ON t.phieu_san_xuat_id=ps.id WHERE ps.lenh_san_xuat_id=${a}.lenh_id AND t.trang_thai<>'HUY' AND ${cond})`;
  const kqPin = (ma) => `EXISTS(SELECT 1 FROM ket_qua_checkpoint k JOIN checkpoint c ON c.id=k.checkpoint_id WHERE k.phan_in_id=${a}.phan_in_id AND c.ma_checkpoint='${ma}' AND k.trang_thai='DAT')`;
  const kqLenh = (ma) => `EXISTS(SELECT 1 FROM ket_qua_checkpoint k JOIN checkpoint c ON c.id=k.checkpoint_id WHERE k.lenh_san_xuat_id=${a}.lenh_id AND c.ma_checkpoint='${ma}' AND k.trang_thai='DAT')`;
  const cntPin = (list) => `(SELECT count(*) FROM ket_qua_checkpoint k JOIN checkpoint c ON c.id=k.checkpoint_id WHERE k.phan_in_id=${a}.phan_in_id AND c.ma_checkpoint IN (${list}) AND k.trang_thai='DAT')`;
  return `CASE
      WHEN ${a}.lenh_id IS NULL THEN
        CASE WHEN ${kqPin('QC_XAC_NHAN')} THEN 'RELEASE_1'
             WHEN ${cntPin("'KHUON','FILM','MUC'")}>=3 THEN 'READY_QA'
             ELSE 'READY_KT' END
      WHEN EXISTS(SELECT 1 FROM phieu_san_xuat ps WHERE ps.lenh_san_xuat_id=${a}.lenh_id AND ps.trang_thai='DANG_CHAY') THEN 'SAN_XUAT'
      WHEN ${temEx("t.trang_thai IN ('IN','DANG_PHOI')")} THEN 'CHO_KHO'
      WHEN ${temEx("t.trang_thai='DA_KHO'")} THEN 'KCS'
      WHEN ${temEx("t.trang_thai='CHO_SUA'")} THEN 'SUA'
      WHEN ${temEx("t.trang_thai='CHO_OQC'")} THEN 'OQC'
      WHEN ${temEx("t.trang_thai='OQC_DAT'")} THEN 'DANG_GIAO'
      WHEN ${temEx("t.trang_thai='DA_GIAO'")} THEN 'DA_GIAO'
      WHEN ${a}.lenh_tt='RELEASE_2' THEN 'CHO_SAN_XUAT'
      WHEN ${kqLenh('TEST_CNSP')} AND ${kqLenh('TEST_QA')} THEN 'RELEASE_2'
      WHEN ${kqLenh('TEST_CNSP')} THEN 'TESTRUN_QA'
      ELSE 'TESTRUN_CNSP' END`;
}

// Giai đoạn "dự phòng" cho phần in KHÔNG có đợt vải nào (chưa nhận vải) — LUÔN thuộc READY (chuẩn bị),
// KHÔNG bao giờ RELEASE_1: không có đợt vải nào để release nên màn Release 1 (theo đợt) không hiện chúng
// ⇒ nếu xếp RELEASE_1 sẽ đếm dư so với màn. (RELEASE_1 chỉ dành cho phần in CÓ đợt vải chưa release.)
function readyFallback(pinId) {
  return `CASE WHEN (SELECT count(*) FROM ket_qua_checkpoint k JOIN checkpoint c ON c.id=k.checkpoint_id WHERE k.phan_in_id=${pinId} AND c.ma_checkpoint IN ('KHUON','FILM','MUC') AND k.trang_thai='DAT')>=3 THEN 'READY_QA'
      ELSE 'READY_KT' END`;
}

// Rowsource các đợt vải (không DA_GOP/DA_HUY) của phần in `pinId` + lệnh non-HUY mới nhất mỗi đợt.
function dotSource(pinId) {
  const lenh = (col) => `(SELECT ls.${col} FROM lenh_sx_dot_vai lsd JOIN lenh_san_xuat ls ON ls.id=lsd.lenh_san_xuat_id WHERE lsd.dot_vai_ve_id=d.id AND ls.trang_thai<>'HUY' ORDER BY ls.created_date DESC LIMIT 1)`;
  return `SELECT d.phan_in_id, ${lenh('id')} AS lenh_id, ${lenh('trang_thai')} AS lenh_tt FROM dot_vai_ve d WHERE d.phan_in_id=${pinId} AND d.trang_thai NOT IN ('DA_GOP','DA_HUY')`;
}

// Biểu thức SCALAR: stage dominant của phần in `pinId` (dùng ở orders.stageCondition).
function dominantStageScalar(pinId) {
  return `COALESCE((SELECT z.stage FROM (SELECT (${dotStageCase('s')}) AS stage, array_position(${ORDER_SQL_ARRAY}, (${dotStageCase('s')})) AS rnk FROM (${dotSource(pinId)}) s) z ORDER BY z.rnk LIMIT 1), ${readyFallback(pinId)})`;
}

// Điều kiện WHERE cho 1 chip (orders). stage='' | 'ALL' → null (không lọc giai đoạn).
function chipCondition(chip, pinId = 'pin.id') {
  const stages = CHIP_STAGES[chip];
  if (!stages) return null;
  return `(${dominantStageScalar(pinId)}) IN (${stages.map((s) => `'${s}'`).join(',')})`;
}

module.exports = {
  STAGE_ORDER, ORDER_SQL_ARRAY, CHIP_STAGES, STAGE_LABEL,
  dotStageCase, readyFallback, dotSource, dominantStageScalar, chipCondition,
};
