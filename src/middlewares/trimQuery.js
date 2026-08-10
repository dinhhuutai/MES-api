'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CẮT KHOẢNG TRẮNG THỪA cho MỌI tham số trên query string — lưới an toàn chung cho cả app:
// người dùng copy–dán mã hay gõ lỡ dấu cách ở đầu/cuối thì tìm vẫn ra.
//
// ⚠⚠ EXPRESS 5: `req.query` là GETTER dựng lại object mỗi lần đọc ⇒ sửa tại chỗ
//    (`req.query[k] = ...`) **KHÔNG ăn** — đã đo thật: giá trị trả về vẫn còn nguyên khoảng trắng.
//    Phải `Object.defineProperty` đè hẳn một object mới lên request.
//
// ⚠ CHỈ đụng `req.query`, KHÔNG đụng `req.body`: body chứa lý do / ghi chú / mô tả — người dùng có
//   thể cố ý xuống dòng, thụt đầu dòng; tự ý cắt là sửa dữ liệu nghiệp vụ của họ.
// ─────────────────────────────────────────────────────────────────────────────

const catGon = (v) => (typeof v === 'string' ? v.trim() : v);

module.exports = function trimQuery(req, _res, next) {
  try {
    const q = req.query;
    if (!q || typeof q !== 'object') return next();
    const moi = {};
    for (const k of Object.keys(q)) {
      const v = q[k];
      moi[k] = Array.isArray(v) ? v.map(catGon) : catGon(v);
    }
    Object.defineProperty(req, 'query', { value: moi, writable: false, configurable: true });
  } catch {
    // Không bao giờ để việc cắt khoảng trắng chặn request.
  }
  next();
};
