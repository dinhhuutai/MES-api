'use strict';

const prodRepo = require('../modules/production/production.repository');
const sockets = require('../sockets');

// TỰ ĐỘNG chuyển tem PHƠI XONG (tg_kt_phoi <= now) → DA_KHO (chờ KCS), kể cả khi không ai mở màn KCS.
// Best-effort: lỗi thì chỉ cảnh báo, không làm sập server. Có emit socket để màn đang mở tự tải lại.
async function promoteDrying() {
  try {
    const n = await prodRepo.promoteFinishedDrying();
    if (n > 0) {
      sockets.emit('drying:updated', { auto: true, promoted: n });
      sockets.emit('quality:updated', { auto: true, promoted: n });
      sockets.emit('dashboard:refresh', {});
      console.log(`[drying] Tự chuyển ${n} tem phơi xong → chờ KCS`);
    }
  } catch (e) {
    console.warn('[drying] Bỏ qua tự chuyển tem phơi xong:', e.message);
  }
}

function startDryingJob() {
  const SEC = Number(process.env.DRYING_PROMOTE_INTERVAL_SEC) || 60;
  setTimeout(promoteDrying, 10 * 1000);     // lần đầu sau 10s
  setInterval(promoteDrying, SEC * 1000);   // rồi mỗi SEC giây
  console.log(`[drying] Job tự chuyển tem phơi xong → chờ KCS mỗi ${SEC}s`);
}

module.exports = { startDryingJob, promoteDrying };
