'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// BỘ NHỚ CHẶN TOKEN (mig 081) — để middleware `auth` biết token nào đã bị đăng xuất từ xa mà
// KHÔNG phải query DB mỗi request.
//
// Vì sao cần cache: DB đặt ở mạng khác, nút cổ chai của hệ này là ROUND-TRIP mạng × số query mỗi
// trang (§11.5). Thêm 1 query xác thực vào MỌI request là cách nhanh nhất làm cả app chậm đi.
//
// Cách chặn có 2 tầng:
//   1. `jti` — mã phiên nhúng trong JWT. Phiên không còn HOAT_DONG ⇒ chặn.
//   2. `tg_buoc_dang_xuat_truoc` của user — chặn mọi token phát TRƯỚC mốc đó. Đây là đường DUY NHẤT
//      xử được token CŨ (phát trước mig 081, không có `jti`).
//
// ⚠⚠ FAIL-OPEN Ở MỌI NHÁNH LỖI: thiếu migration / DB chớp mạng ⇒ coi như KHÔNG chặn ai. Chặn oan
//   thì cả nhà máy không đăng nhập được — hậu quả nặng hơn nhiều so với 1 phiên đáng lẽ bị đăng
//   xuất mà còn sống thêm ít phút.
// ⚠ Cache có TTL ngắn (`TTL_MS`) và được nạp lại nền; ngoài ra `xoaCache()` được gọi NGAY sau khi
//   đăng xuất từ xa nên thao tác có hiệu lực tức thì trên tiến trình đang xử lý.
// ⚠ Nhiều tiến trình BE (nếu sau này chạy nhiều instance): mỗi tiến trình tự nạp lại trong TTL_MS
//   ⇒ trễ tối đa bằng TTL. Chấp nhận được với mục đích quản lý thiết bị.
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../config/db');

const TTL_MS = 30 * 1000;   // nạp lại tối đa 30 giây/lần

let jtiChan = new Set();          // jti của phiên KHÔNG còn HOAT_DONG
let mocDangXuat = new Map();      // nguoi_dung_id -> mốc (ms) — token phát trước mốc thì chặn
let napLuc = 0;                   // lần nạp gần nhất (Date.now)
let dangNap = null;               // promise đang nạp (gộp các lời gọi song song)

async function napLai() {
  try {
    // 2 query nhẹ, chỉ chạy tối đa 1 lần / TTL_MS.
    const [p, u] = await Promise.all([
      query("SELECT jti FROM phien_dang_nhap WHERE trang_thai <> 'HOAT_DONG'"),
      query('SELECT id, tg_buoc_dang_xuat_truoc FROM nguoi_dung WHERE tg_buoc_dang_xuat_truoc IS NOT NULL'),
    ]);
    jtiChan = new Set(p.rows.map((r) => r.jti));
    mocDangXuat = new Map(u.rows.map((r) => [r.id, new Date(r.tg_buoc_dang_xuat_truoc).getTime()]));
  } catch (e) {
    // Chưa chạy mig 081 (thiếu bảng/cột) hoặc DB lỗi → KHÔNG chặn ai.
    jtiChan = new Set();
    mocDangXuat = new Map();
  } finally {
    napLuc = Date.now();
    dangNap = null;
  }
}

// Bảo đảm cache còn tươi. Trả promise khi đang nạp lần đầu; các lần sau nạp NGẦM để không thêm độ
// trễ vào request (dữ liệu cũ ≤ TTL_MS là chấp nhận được).
function bamCache() {
  const cu = Date.now() - napLuc > TTL_MS;
  if (!cu) return null;
  if (!dangNap) dangNap = napLai();
  return napLuc === 0 ? dangNap : null;   // lần đầu thì CHỜ, sau đó nạp ngầm
}

// Token có bị chặn không? `payload` = nội dung JWT đã verify ({ sub, jti, iat }).
// Trả null = cho đi; trả chuỗi = lý do chặn (để log/thông điệp).
async function lyDoChan(payload) {
  const cho = bamCache();
  if (cho) await cho;

  if (payload.jti && jtiChan.has(payload.jti)) return 'PHIEN_DA_DANG_XUAT';

  const moc = mocDangXuat.get(payload.sub);
  // `iat` (giây) — token cũ không có `jti` chỉ chặn được bằng đường này.
  if (moc && payload.iat && payload.iat * 1000 < moc) return 'DA_DANG_XUAT_MOI_THIET_BI';
  return null;
}

// Gọi NGAY sau khi đăng xuất từ xa / đăng xuất mọi thiết bị ⇒ lần kiểm kế tiếp nạp lại từ DB.
function xoaCache() { napLuc = 0; }

module.exports = { lyDoChan, xoaCache };
