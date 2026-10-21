'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CACHE ĐỌC THEO "PHIÊN BẢN DỮ LIỆU" (21/10/2026 — đo prod: 12 người cùng mở 1 màn ⇒ 12 câu nặng 2,5 s chạy
// cùng lúc, Postgres chỉ chạy song song ~4 câu ⇒ người cuối chờ 14,7 s).
//
// Ý tưởng: các danh sách / dải "Theo dõi" KHÔNG phụ thuộc người xem (chỉ phụ thuộc tham số) ⇒ N người hỏi CÙNG
// một thứ thì chỉ tính 1 lần, mọi người dùng chung kết quả (kể cả người tới lúc câu đang chạy — giữ PROMISE).
//
// ⚠⚠ ĐÚNG DỮ LIỆU LÀ TRÊN HẾT — xác nhận ở màn này đổi số của màn khác, nên KHÔNG đoán màn nào bị ảnh hưởng:
//   · Có một số "phiên bản dữ liệu" CHUNG toàn hệ thống. MỌI thao tác ghi làm nó tăng ⇒ MỌI mục cache cũ hết hiệu
//     lực ngay (không phải chờ hết hạn). Tăng ở 2 chỗ:
//       1. `middlewares/danhDauGhi.js` — mọi request POST/PUT/PATCH/DELETE: tăng lúc BẮT ĐẦU và lúc KẾT THÚC
//          (câu đọc chạy xen giữa lúc ghi chưa commit cũng bị bỏ khi ghi xong).
//       2. `sockets.emit` — job nền (đồng bộ ERP, tem phơi xong…) ghi không qua HTTP nhưng luôn bắn socket.
//   · Mục cache ghi nhớ phiên bản LÚC BẮT ĐẦU TÍNH; chỉ dùng lại khi phiên bản hiện tại còn y như vậy.
//   · Thêm hạn `ttlMs` (mặc định 15 s) làm lưới an toàn cho thao tác ghi lọt cả 2 đường trên (và để số phút / SLA
//     tính theo giờ hiện tại không đứng quá lâu).
//   · Lỗi ⇒ XÓA NGAY (giữ promise reject là mọi lượt sau cùng hỏng — bài học `metrics.js`).
// ⚠ CHỈ dùng cho hàm đọc mà kết quả KHÔNG phụ thuộc người gọi (không đọc `req.user`) — quyền kiểm TRƯỚC khi gọi.
// ⚠ Kết quả được NHIỀU request dùng chung ⇒ nơi gọi không được sửa (mutate) object trả về.
// ⚠ Chỉ đúng khi backend chạy 1 TIẾN TRÌNH (PM2 fork — như prod hiện nay). Chạy nhiều tiến trình (cluster) thì
//   ghi ở tiến trình A không xóa cache tiến trình B ⇒ lúc đó phải chuyển phiên bản sang nơi dùng chung (Redis…).
// ─────────────────────────────────────────────────────────────────────────────

let phienBan = 0;
const _nho = new Map(); // khoa → { pb, at, p }
const TTL_MAC_DINH = 15000;
const TOI_DA_MUC = 300;

function tangPhienBan() { phienBan += 1; }
const phienBanHienTai = () => phienBan;

// Khóa ổn định cho object tham số (thứ tự khóa không ảnh hưởng; bỏ giá trị rỗng).
function khoaOn(v) {
  if (v === null || v === undefined || v === '') return '';
  if (Array.isArray(v)) return `[${v.map(khoaOn).join(',')}]`;
  if (typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined && v[k] !== null && v[k] !== '')
      .map((k) => `${k}:${khoaOn(v[k])}`).join(',')}}`;
  }
  return String(v);
}

function don() {
  const now = Date.now();
  for (const [k, m] of _nho) if (m.pb !== phienBan || now - m.at > TTL_MAC_DINH * 4) _nho.delete(k);
  // Vẫn quá nhiều (nhiều ô tìm khác nhau trong cùng 1 phiên bản) ⇒ bỏ mục cũ nhất.
  if (_nho.size > TOI_DA_MUC) [..._nho.keys()].slice(0, _nho.size - TOI_DA_MUC).forEach((k) => _nho.delete(k));
}

// `nhom` = tên nguồn (vd 'siso', 'ready.candidates'); `thamSo` = mọi thứ làm kết quả khác đi.
function nhoDoc(nhom, thamSo, tinh, ttlMs = TTL_MAC_DINH) {
  const khoa = `${nhom}|${khoaOn(thamSo)}`;
  const cu = _nho.get(khoa);
  const now = Date.now();
  if (cu && cu.pb === phienBan && now - cu.at < ttlMs) return cu.p;
  const muc = { pb: phienBan, at: now, p: null };
  muc.p = Promise.resolve().then(tinh).catch((e) => {
    if (_nho.get(khoa) === muc) _nho.delete(khoa);
    throw e;
  });
  _nho.set(khoa, muc);
  if (_nho.size > TOI_DA_MUC) don();
  return muc.p;
}

module.exports = { nhoDoc, tangPhienBan, phienBanHienTai, khoaOn, _nho };
