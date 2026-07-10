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

function startCleanupJob() {
  const DAY = 24 * 60 * 60 * 1000;
  setTimeout(pruneNavLog, 60 * 1000); // lần đầu sau 1 phút
  setInterval(pruneNavLog, DAY);      // rồi mỗi ngày
  console.log(`[cleanup] Job dọn nhật ký điều hướng (giữ ${RETENTION_DAYS} ngày) mỗi 24h`);
}

module.exports = { startCleanupJob, pruneNavLog };
