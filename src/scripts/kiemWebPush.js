'use strict';

/* eslint-disable no-console */
// ─────────────────────────────────────────────────────────────────────────────
// CHẨN ĐOÁN WEB PUSH (mig 085) — chạy TRÊN MÁY CHỦ khi bấm "Bật trên thiết bị này"
// mà ra toast đỏ "Máy chủ chưa cấu hình khóa VAPID".
//
//   cd <thư-mục-backend> && node src/scripts/kiemWebPush.js
//   (hoặc: npm run kiem:push)
//
// ⚠⚠ PHẢI CHẠY ĐÚNG THƯ MỤC MÀ TIẾN TRÌNH BACKEND ĐANG CHẠY: `dotenv` đọc `.env` theo
//   **process.cwd()**, không phải theo vị trí file này. Chạy sai thư mục thì script báo "thiếu"
//   trong khi server thật lại có (và ngược lại) — đó chính là cái bẫy hay gặp nhất.
//
// Script CHỈ ĐỌC: không sửa file, không gọi mạng, KHÔNG in giá trị khóa bí mật ra màn hình.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

// Độ dài chuẩn của cặp khóa VAPID (P-256, base64url không đệm):
//   public  = 65 byte  → 87 ký tự (luôn bắt đầu bằng 'B')
//   private = 32 byte  → 43 ký tự
const DAI_PUBLIC = 87;
const DAI_PRIVATE = 43;

const che = (v) => (v ? `${String(v).slice(0, 6)}…${String(v).slice(-4)}` : '');
const dong = () => console.log('─'.repeat(78));

let loi = 0;
const bao = (dat, ten, them = '') => {
  if (!dat) loi += 1;
  console.log(`  ${dat ? 'OK  ' : 'LỖI '} ${ten}${them ? ` — ${them}` : ''}`);
};

dong();
console.log('CHẨN ĐOÁN WEB PUSH');
dong();

// ─── 0. Package `web-push` đã CÀI trên máy này chưa ──────────────────────────
// ⚠⚠ ĐẶT TRƯỚC MỌI BƯỚC VAPID — đây là nguyên nhân THẬT của sự cố 19/08/2026: deploy mig 085 mà
//   server chưa `npm install` ⇒ thiếu `web-push` ⇒ `khoiTao()` bắt lỗi require ⇒ khóa trả rỗng ⇒
//   FE hiện "Máy chủ chưa cấu hình khóa VAPID" — GIỐNG HỆT ca thiếu khóa, rất dễ chẩn đoán nhầm.
// ⚠ "Có trong package.json" KHÔNG chứng minh "đã cài" — phải hỏi chính `require.resolve` trên máy này.
console.log('\n[0] PACKAGE web-push');
let coPkg = false;
try {
  const p = require.resolve('web-push');
  coPkg = true;
  let ver = '';
  try { ver = require('web-push/package.json').version; } catch (e) { /* không có cũng không sao */ }
  bao(true, 'Đã cài web-push', `${ver ? `v${ver} · ` : ''}${p}`);
} catch (e) {
  bao(false, 'Đã cài web-push', 'CHƯA CÀI → chạy: npm install   (rồi restart backend)');
}

// ─── 1. Thư mục & file .env ──────────────────────────────────────────────────
const cwd = process.cwd();
const duongDanEnv = path.resolve(cwd, '.env');
console.log('\n[1] THƯ MỤC & FILE .env');
console.log(`  Thư mục đang chạy (process.cwd) : ${cwd}`);
console.log(`  dotenv sẽ đọc file             : ${duongDanEnv}`);
const coFile = fs.existsSync(duongDanEnv);
bao(coFile, 'File .env tồn tại', coFile ? '' : 'chạy script này ở ĐÚNG thư mục backend đang chạy');

// ─── 2. Soi nội dung thô của .env (bắt lỗi dán sai định dạng) ────────────────
// ⚠ Đây là bước quan trọng nhất: khóa public dài 87 ký tự nên khi dán qua SSH/nano rất dễ bị
//   NGẮT DÒNG giữa chừng — lúc đó `dotenv` chỉ lấy được nửa đầu và `setVapidDetails` sẽ ném.
console.log('\n[2] NỘI DUNG .env (chỉ soi 3 dòng VAPID, không in giá trị đầy đủ)');
if (coFile) {
  let tho = '';
  try { tho = fs.readFileSync(duongDanEnv, 'utf8'); } catch (e) {
    console.log(`  Không đọc được file: ${e.message}`);
  }
  const dsDong = tho.split(/\r?\n/);
  ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'].forEach((ten) => {
    const idx = dsDong.findIndex((d) => d.trimStart().startsWith(`${ten}=`));
    if (idx < 0) { bao(false, `Có dòng ${ten}=`, 'KHÔNG tìm thấy trong file này'); return; }
    const d = dsDong[idx];
    const giaTri = d.slice(d.indexOf('=') + 1);
    const canhBao = [];
    if (/^\s*#/.test(d)) canhBao.push('DÒNG ĐANG BỊ COMMENT bằng #');
    if (/^["']|["']$/.test(giaTri.trim())) canhBao.push('có dấu nháy bao quanh — bỏ nháy đi');
    if (giaTri !== giaTri.trim()) canhBao.push('có khoảng trắng thừa ở đầu/cuối');
    if (!giaTri.trim()) canhBao.push('ĐỂ TRỐNG');
    bao(canhBao.length === 0, `Dòng ${ten} (dòng ${idx + 1})`,
      canhBao.length ? canhBao.join(' · ') : `${giaTri.trim().length} ký tự`);
    // Dòng KẾ TIẾP trông như phần đuôi bị ngắt của khóa? (không có dấu '=' và không rỗng)
    const ke = dsDong[idx + 1];
    if (ten !== 'VAPID_SUBJECT' && ke && ke.trim() && !ke.includes('=') && !/^\s*#/.test(ke)) {
      bao(false, `  ↳ dòng ${idx + 2} nghi bị NGẮT DÒNG từ ${ten}`,
        `"${ke.trim().slice(0, 20)}…" — dán lại thành MỘT dòng duy nhất`);
    }
  });
}

// ─── 3. Sau khi dotenv nạp ───────────────────────────────────────────────────
require('dotenv').config();
console.log('\n[3] BIẾN MÔI TRƯỜNG SAU KHI dotenv NẠP');
const pub = process.env.VAPID_PUBLIC_KEY || '';
const priv = process.env.VAPID_PRIVATE_KEY || '';
console.log(`  VAPID_SUBJECT     : ${process.env.VAPID_SUBJECT || '(trống — code sẽ dùng mặc định)'}`);
bao(!!pub, 'VAPID_PUBLIC_KEY có giá trị', pub ? `${pub.length} ký tự, ${che(pub)}` : '');
bao(!!priv, 'VAPID_PRIVATE_KEY có giá trị', priv ? `${priv.length} ký tự, ${che(priv)}` : '');
if (pub) {
  bao(pub.length === DAI_PUBLIC, `Độ dài public key = ${DAI_PUBLIC}`,
    pub.length === DAI_PUBLIC ? '' : `đang là ${pub.length} — khóa bị cắt/thừa ký tự`);
  bao(pub.startsWith('B'), 'Public key bắt đầu bằng "B"', pub.startsWith('B') ? '' : 'sai định dạng');
  bao(!/[^A-Za-z0-9_-]/.test(pub), 'Public key chỉ gồm ký tự base64url',
    /[^A-Za-z0-9_-]/.test(pub) ? 'có ký tự lạ (khoảng trắng? xuống dòng? dấu nháy?)' : '');
}
if (priv) {
  bao(priv.length === DAI_PRIVATE, `Độ dài private key = ${DAI_PRIVATE}`,
    priv.length === DAI_PRIVATE ? '' : `đang là ${priv.length} — khóa bị cắt/thừa ký tự`);
  bao(!/[^A-Za-z0-9_-]/.test(priv), 'Private key chỉ gồm ký tự base64url',
    /[^A-Za-z0-9_-]/.test(priv) ? 'có ký tự lạ' : '');
}

// ─── 4. Kết quả khởi tạo thật của webPush ────────────────────────────────────
// ⚠ Nạp SAU dotenv, đúng như tiến trình thật: `utils/webPush.js` đọc process.env ở mức module.
console.log('\n[4] KẾT QUẢ KHỞI TẠO (đúng thứ tự như lúc server chạy)');
let tt = null;
try {
  const webPush = require('../utils/webPush');
  tt = webPush.trangThai();
  bao(tt.san_sang, 'webPush sẵn sàng', tt.san_sang ? '' : tt.ly_do);
  bao(!!webPush.khoaCongKhai(), 'API /thong-bao/push/khoa sẽ trả khóa cho trình duyệt',
    webPush.khoaCongKhai() ? '' : 'đang trả RỖNG ⇒ FE báo "Máy chủ chưa cấu hình khóa VAPID"');
} catch (e) {
  bao(false, 'Nạp được utils/webPush', e.message);
}

// ─── 5. Kết luận ─────────────────────────────────────────────────────────────
dong();
if (loi === 0 && tt && tt.san_sang) {
  console.log('KẾT LUẬN: cấu hình ĐÚNG ở thư mục này.');
  console.log('  → Nếu giao diện VẪN báo lỗi thì tiến trình backend đang chạy CHƯA nạp lại .env.');
  console.log('    · PM2   : pm2 restart <tên-app> --update-env    ⚠ thiếu --update-env là KHÔNG nạp lại .env');
  console.log('              (chắc ăn hơn: pm2 delete <tên-app> && pm2 start src/index.js --name <tên-app>)');
  console.log('    · systemd: sudo systemctl restart <tên-service>');
  console.log('    · Kiểm  : log khởi động phải có dòng  [push] Web Push : sẵn sàng');
  console.log('    · Coi chừng còn tiến trình CŨ chưa chết: ps aux | grep "src/index.js"');
} else if (!coPkg) {
  // Thiếu package thì mọi thứ về VAPID bên dưới đều vô nghĩa — nói thẳng việc phải làm.
  console.log('KẾT LUẬN: THIẾU PACKAGE web-push — đây là nguyên nhân, không phải chuyện khóa VAPID.');
  console.log('  → cd <thư-mục-backend> && npm install');
  console.log('  → rồi restart backend (PM2: pm2 restart <app> --update-env)');
  console.log('  → kiểm lại log, phải ra:  [push] Web Push : sẵn sàng');
} else {
  console.log(`KẾT LUẬN: còn ${loi} vấn đề ở trên — sửa .env tại ${duongDanEnv} rồi chạy lại script này.`);
  console.log('  Sinh cặp khóa mới:');
  console.log('    node -e "const k=require(\'web-push\').generateVAPIDKeys();console.log(\'VAPID_PUBLIC_KEY=\'+k.publicKey);console.log(\'VAPID_PRIVATE_KEY=\'+k.privateKey)"');
  console.log('  ⚠ Mỗi biến phải nằm trên MỘT dòng, không nháy, không khoảng trắng quanh dấu "=".');
}
dong();
process.exit(loi === 0 && tt && tt.san_sang ? 0 : 1);
