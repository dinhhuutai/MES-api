'use strict';

const { query } = require('../config/db');

// Dọn nhật ký ĐIỀU HƯỚNG cũ để bảng không phình vô hạn (chỉ log điều hướng, giữ N ngày gần nhất).
// Best-effort: nếu app user chưa có quyền DELETE (cần GRANT — mig 049) thì bỏ qua, KHÔNG làm sập server.
const RETENTION_DAYS = Number(process.env.NAV_LOG_RETENTION_DAYS) || 7;

async function pruneNavLog() {
  try {
    const { rowCount } = await query(
      `DELETE FROM nhat_ky_dieu_huong WHERE thoi_gian < now() - make_interval(days => $1::int)`,
      [RETENTION_DAYS]
    );
    if (rowCount) console.log(`[cleanup] Đã xóa ${rowCount} dòng nhật ký điều hướng > ${RETENTION_DAYS} ngày`);
  } catch (e) {
    // 42501 = insufficient_privilege (chưa GRANT DELETE). Chỉ cảnh báo, không throw.
    console.warn('[cleanup] Bỏ qua dọn nhật ký điều hướng:', e.message);
  }
}

// Dọn PAYLOAD THÔ của log đồng bộ ERP: `erp_sync_log.du_lieu_tho` phình ~10 MB/ngày và không có
// giới hạn (đo 17 MB / 4.120 dòng). Bảng nặng làm mọi thao tác trên nó chậm dần.
// ⚠ GIỮ NGUYÊN DÒNG LOG (thời gian, kết quả, số dòng…) — chỉ NULL hóa payload thô quá N ngày, vì
//   payload chỉ dùng để soi lại khi ERP gửi sai, quá 7 ngày thì không còn giá trị chẩn đoán.
// ⚠ Là `UPDATE` nên `claude_agent_mes` chạy được (khác `DELETE` phải GRANT riêng).
const ERP_RAW_RETENTION_DAYS = Number(process.env.ERP_RAW_RETENTION_DAYS) || 7;

async function pruneErpRaw() {
  try {
    const { rowCount } = await query(
      `UPDATE erp_sync_log SET du_lieu_tho = NULL
        WHERE du_lieu_tho IS NOT NULL AND tg_bd < now() - make_interval(days => $1::int)`,
      [ERP_RAW_RETENTION_DAYS]
    );
    if (rowCount) console.log(`[cleanup] Đã xóa payload thô của ${rowCount} dòng log ERP > ${ERP_RAW_RETENTION_DAYS} ngày`);
  } catch (e) {
    console.warn('[cleanup] Bỏ qua dọn payload log ERP:', e.message);
  }
}

async function chayDon() {
  await pruneNavLog();
  await pruneErpRaw();
}

function startCleanupJob() {
  const DAY = 24 * 60 * 60 * 1000;
  setTimeout(chayDon, 60 * 1000); // lần đầu sau 1 phút
  setInterval(chayDon, DAY);      // rồi mỗi ngày
  console.log(`[cleanup] Job dọn nhật ký điều hướng (${RETENTION_DAYS} ngày) + payload log ERP (${ERP_RAW_RETENTION_DAYS} ngày) mỗi 24h`);
}

module.exports = { startCleanupJob, pruneNavLog, pruneErpRaw };
