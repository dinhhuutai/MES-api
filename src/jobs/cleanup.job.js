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

// XÓA HẲN dữ liệu đồng bộ ERP quá N ngày (18/10/2026, người dùng yêu cầu "tự động xóa sau 10 ngày, xóa các log
// luôn"): dòng lượt đồng bộ `erp_sync_log` + payload từng dòng ERP `erp_phieu_nhan_vai_raw` (đo prod 18/10: 26.264
// lượt / 25 MB + 10.407 dòng raw / 16 MB, giữ từ 31/07 — tài liệu ghi "raw giữ 7 ngày" nhưng chưa từng có code dọn).
// ⚠ Raw là UPSERT theo `ma_dot_vai` ⇒ dòng còn nằm trong feed ERP được `updated_date` làm mới mỗi lượt — chỉ xóa
//   dòng không được chạm tới quá N ngày; ERP gửi lại thì upsert chèn lại như thường. Không bảng nào FK tới 2 bảng này;
//   không luật nghiệp vụ nào đọc lại (chỉ màn Đồng bộ ERP xem lịch sử + soi payload).
// ⚠ Lượt `DANG_CHAY` KHÔNG xóa (job đang ghi vào nó). Cần GRANT DELETE (mig 115) — thiếu quyền ⇒ chỉ cảnh báo.
const ERP_SYNC_RETENTION_DAYS = Number(process.env.ERP_SYNC_RETENTION_DAYS) || 10;

async function pruneErpSync() {
  try {
    const raw = await query(
      `DELETE FROM erp_phieu_nhan_vai_raw
        WHERE COALESCE(updated_date, created_date) < now() - make_interval(days => $1::int)`,
      [ERP_SYNC_RETENTION_DAYS]
    );
    const log = await query(
      `DELETE FROM erp_sync_log
        WHERE COALESCE(tg_bd, created_date) < now() - make_interval(days => $1::int)
          AND trang_thai IS DISTINCT FROM 'DANG_CHAY'`,
      [ERP_SYNC_RETENTION_DAYS]
    );
    if (raw.rowCount || log.rowCount) {
      console.log(`[cleanup] Đã xóa ${log.rowCount} lượt đồng bộ ERP + ${raw.rowCount} dòng ERP thô > ${ERP_SYNC_RETENTION_DAYS} ngày`);
    }
  } catch (e) {
    // 42501 = chưa GRANT DELETE (mig 115). Không throw.
    console.warn('[cleanup] Bỏ qua xóa dữ liệu đồng bộ ERP cũ:', e.message);
  }
}

async function chayDon() {
  await pruneNavLog();
  await pruneErpRaw();
  await pruneErpSync();
}

function startCleanupJob() {
  const DAY = 24 * 60 * 60 * 1000;
  setTimeout(chayDon, 60 * 1000); // lần đầu sau 1 phút
  setInterval(chayDon, DAY);      // rồi mỗi ngày
  console.log(`[cleanup] Job dọn nhật ký điều hướng (${RETENTION_DAYS} ngày) + payload log ERP (${ERP_RAW_RETENTION_DAYS} ngày)`
    + ` + xóa đồng bộ ERP (${ERP_SYNC_RETENTION_DAYS} ngày) mỗi 24h`);
}

module.exports = { startCleanupJob, pruneNavLog, pruneErpRaw, pruneErpSync };
