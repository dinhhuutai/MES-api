'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// WEB PUSH — gửi thông báo xuống thiết bị KỂ CẢ KHI ĐÃ ĐÓNG APP (mig 085).
//
// ⚠⚠ CHỈ CHẠY KHI CỜ HỆ THỐNG `PUSH_NEN` ĐANG BẬT (trang *Hệ thống > Cài đặt thông báo*).
//   Tắt ⇒ bỏ qua hoàn toàn ở đây; người dùng vẫn nhận popup khi app đang mở (Notification API ở FE
//   nghe socket). Đây là yêu cầu của người dùng 18/08/2026, không phải mặc định của thư viện.
//
// ⚠⚠ KHÔNG BAO GIỜ NÉM LỖI RA NGOÀI — cùng luật với `erpGhiInTem`: lúc gọi thì việc nghiệp vụ
//   (trả về phần in) ĐÃ commit xong. Push hỏng thì cùng lắm mất một popup, không được phép làm
//   hỏng thao tác trả về hay chặn response.
//
// ⚠ Thiếu VAPID key ⇒ TỰ TẮT (log 1 lần lúc khởi động, không spam). Không có key mà vẫn gửi thì
//   `web-push` ném ngay ở lời gọi đầu tiên.
//
// ⚠ Thiếu package `web-push` (chưa `npm install`) ⇒ cũng tự tắt, KHÔNG làm sập server lúc require.
//   Cần thiết vì backend deploy trước khi cài dep là chuyện xảy ra thật.
//
// Sinh cặp khóa VAPID: `npx web-push generate-vapid-keys`
//   → đặt vào .env: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT (mailto: hoặc https:)
// ─────────────────────────────────────────────────────────────────────────────

let webpush = null;
let sanSang = false;
let lyDoTat = 'chưa khởi tạo';

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@thuanhunglongan.com';

function khoiTao() {
  if (!PUBLIC_KEY || !PRIVATE_KEY) {
    lyDoTat = 'chưa đặt VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY trong .env';
    return;
  }
  try {
    // eslint-disable-next-line global-require
    webpush = require('web-push');
  } catch (e) {
    lyDoTat = 'chưa cài package "web-push" (chạy: npm install web-push)';
    return;
  }
  try {
    webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
    sanSang = true;
    lyDoTat = '';
  } catch (e) {
    lyDoTat = `VAPID key không hợp lệ: ${e.message}`;
  }
}
khoiTao();

const dungDuoc = () => sanSang;
const khoaCongKhai = () => (sanSang ? PUBLIC_KEY : '');
const trangThai = () => ({ san_sang: sanSang, ly_do: lyDoTat || null });

// ⚠⚠ 404/410 = endpoint CHẾT (người dùng gỡ app / thu hồi quyền / đổi trình duyệt) ⇒ bên gọi PHẢI
//   xóa khỏi DB. Giữ lại thì mỗi lần gửi đều thất bại và log rác mãi mãi.
const CHET = new Set([404, 410]);

// Gửi cho 1 đăng ký. Trả `{ ok, chet, loi }` — KHÔNG ném.
async function guiMot(sub, payload) {
  if (!sanSang) return { ok: false, chet: false, loi: lyDoTat };
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 24 * 3600 }
    );
    return { ok: true, chet: false, loi: null };
  } catch (e) {
    const sc = e && e.statusCode;
    return { ok: false, chet: CHET.has(sc), loi: `${sc || ''} ${e.message || e}`.trim() };
  }
}

// Gửi hàng loạt. Trả `{ da_gui, that_bai, endpoint_chet[] }`.
// ⚠ Gửi SONG SONG nhưng `allSettled` — 1 thiết bị lỗi không được kéo sập cả lượt.
async function guiNhieu(subs, payload) {
  if (!sanSang || !subs || !subs.length) return { da_gui: 0, that_bai: 0, endpoint_chet: [] };
  const kq = await Promise.allSettled(subs.map((s) => guiMot(s, payload)));
  const chet = [];
  let daGui = 0; let thatBai = 0;
  kq.forEach((r, i) => {
    const v = r.status === 'fulfilled' ? r.value : { ok: false, chet: false };
    if (v.ok) daGui += 1; else thatBai += 1;
    if (v.chet) chet.push(subs[i].endpoint);
  });
  return { da_gui: daGui, that_bai: thatBai, endpoint_chet: chet };
}

module.exports = { dungDuoc, khoaCongKhai, trangThai, guiMot, guiNhieu };
