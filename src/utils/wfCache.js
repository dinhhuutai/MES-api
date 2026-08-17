'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CACHE CẤU HÌNH WORKFLOW TRONG RAM (workflow version + trạm + checkpoint).
//
// Vì sao cần: nút cổ chai của hệ là **round-trip mạng tới DB × số query mỗi request** (~25 ms/lượt,
// BE và DB ở 2 nơi — DATABASE.md §7). Mà cấu hình workflow bị đọc lại ở MỌI request của 2 module:
//   · `technical.service.loadConfig()`      — 12 chỗ gọi, 1 query
//   · `planning.service.loadTestConfig()`   — 8 chỗ gọi, **3 query TUẦN TỰ** (version → trạm →
//     checkpoint) = ~75 ms chỉ riêng độ trễ mạng.
// Cấu hình này đổi RẤT HIẾM (chỉ khi sửa workflow ở trang Hệ thống) ⇒ cache là đúng chỗ.
//
// ⚠⚠ FAIL-OPEN: hàm nạp ném lỗi thì **KHÔNG cache**, ném thẳng ra như trước (vd "Chưa cấu hình
//   workflow đang hiệu lực" vẫn phải tới được người dùng). Không bao giờ cache một kết quả lỗi.
// ⚠ `xoaCache()` được gọi NGAY trong các hàm GHI của module `wfconfig` ⇒ sửa workflow có hiệu lực
//   tức thì, không phải chờ hết TTL.
// ⚠ Gộp lời gọi song song bằng `dangNap`: N request đến cùng lúc lúc cache nguội chỉ chạy 1 lượt.
// ⚠ Nhiều tiến trình BE (nếu sau này chạy nhiều instance): mỗi tiến trình có cache riêng ⇒ sau khi
//   sửa workflow, tiến trình khác trễ tối đa `TTL_MS`. Chấp nhận được với dữ liệu cấu hình.
// ─────────────────────────────────────────────────────────────────────────────

const TTL_MS = 60 * 1000;

const kho = new Map();   // khoa -> { gt, luc }
const dangNap = new Map(); // khoa -> promise (gộp lời gọi song song)

// Bọc 1 hàm nạp bất đồng bộ bằng cache theo `khoa`.
async function nho(khoa, nap) {
  const c = kho.get(khoa);
  if (c && Date.now() - c.luc < TTL_MS) return c.gt;
  if (dangNap.has(khoa)) return dangNap.get(khoa);
  const p = (async () => {
    try {
      const gt = await nap();
      kho.set(khoa, { gt, luc: Date.now() });
      return gt;
    } finally {
      dangNap.delete(khoa);
    }
  })();
  dangNap.set(khoa, p);
  return p;
}

// Xóa toàn bộ (mặc định) hoặc 1 khóa. Gọi sau MỌI thao tác ghi cấu hình workflow.
function xoaCache(khoa) {
  if (khoa) { kho.delete(khoa); dangNap.delete(khoa); return; }
  kho.clear(); dangNap.clear();
}

module.exports = { nho, xoaCache, TTL_MS };
