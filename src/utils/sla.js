'use strict';

// Trạng thái SLA của 1 đối tượng đang ở trạm — DÙNG CHUNG dashboard + báo cáo (metric)
// để 2 nơi không bao giờ ra số khác nhau. Khớp `frontend/src/utils/sla.js` (evalSla).
//   'NGHEN'     : đã quá SLA
//   'SAP_NGHEN' : còn trong ngưỡng cảnh báo trước
//   'OK'        : đúng hạn (hoặc trạm không cấu hình SLA)
function slaStatus(phutDaO, slaPhut, canhBao) {
  const sla = Number(slaPhut) || 0;
  const cb = Number(canhBao) || 0;
  const p = Number(phutDaO) || 0;
  if (sla <= 0) return 'OK';
  if (p > sla) return 'NGHEN';
  if (p >= sla - cb) return 'SAP_NGHEN';
  return 'OK';
}

module.exports = { slaStatus };
