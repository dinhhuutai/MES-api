'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// THỬ LẠI KHI GỌI ERP — luật chung cho mọi chiều đẩy (`erpGhiInTem.ghiInTem` + `erpApiChung.goiErp`).
//
// ⚠⚠ VÌ SAO KHÔNG THỬ LẠI NGAY SAU TIMEOUT (25/10/2026 — người dùng báo "ERP có 2 dòng cho 1 tem in"):
//   axios hết giờ chỉ NGẮT phía MES; router ERP vẫn chạy tiếp proc (`MES_spr_MES2SF0`…) tới khi xong.
//   Bản cũ gọi lại sau 1 giây ⇒ lượt 2 (cùng IDMES) chạy CHỒNG lên lượt 1 còn dở bên ERP: proc "xóa phiếu
//   cùng soctcu rồi chèn" chạy song song thì cả hai cùng không thấy phiếu cũ ⇒ 2 phiếu. Prod 09–24/10:
//   20 lượt timeout 10s × 3 lần; cùng phút còn có lỗi deadlock / "DELETE conflicted" của chính proc.
//   ⇒ (1) sau TIMEOUT chờ `choSauTimeoutMs()` (mặc định 30 s) cho lượt cũ bên ERP chạy xong rồi mới gọi
//   lại — gọi lại TUẦN TỰ thì proc ghi đè theo IDMES, không đẻ phiếu 2; (2) các lượt gọi CÙNG kênh (URL)
//   xếp hàng 1 lượt / lúc (`xepHang`) ⇒ in 10 tem không còn bắn 10 proc song song (gốc của deadlock).
//   Lỗi khác (HTTP 500, mạng chưa tới ERP) vẫn thử lại sau 1 s, 2 s… như cũ.
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hết giờ chờ phản hồi (ERP có thể ĐÃ nhận và đang chạy) — khác lỗi "chưa tới được ERP".
function laTimeout(e) {
  if (!e) return false;
  if (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT') return true;
  return /timeout of \d+ms exceeded|timed? ?out/i.test(String(e.message || ''));
}

function choSauTimeoutMs() {
  const v = parseInt(process.env.ERP_CHO_SAU_TIMEOUT_MS || '30000', 10);
  return Number.isFinite(v) && v >= 0 ? v : 30000;
}

// Thời gian chờ trước lượt thử thứ (i + 1) sau lỗi `e` ở lượt i.
function thoiGianCho(i, e) {
  return laTimeout(e) ? choSauTimeoutMs() : 1000 * i;
}

// Hàng đợi theo khóa (URL của kênh): chỉ giữ chỗ trong lúc GỌI HTTP — thời gian chờ thử lại nằm ngoài
// hàng nên 1 tem treo không chặn tem khác quá 1 lần timeout.
const duoiHang = new Map();
function xepHang(khoa, fn) {
  const truoc = duoiHang.get(khoa) || Promise.resolve();
  const chay = truoc.catch(() => {}).then(fn);
  const duoi = chay.catch(() => {});
  duoiHang.set(khoa, duoi);
  duoi.then(() => { if (duoiHang.get(khoa) === duoi) duoiHang.delete(khoa); });
  return chay;
}

module.exports = { sleep, laTimeout, choSauTimeoutMs, thoiGianCho, xepHang };
