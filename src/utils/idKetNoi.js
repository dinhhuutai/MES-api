'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// ID KẾT NỐI — khóa truy vết cho MỌI lượt MES ↔ ERP (27/09/2026, người dùng yêu cầu: "tất cả những
// cái lấy từ ERP hay gửi sang ERP đều phải có ID").
//
// Nguồn của ID theo từng loại lượt gọi (lưu ở `audit_log.gia_tri_moi.id_mes`, cột "ID kết nối"
// ở *Hệ thống › Cài đặt API › Lịch sử*):
//   · Chiều ĐẨY  → ID mà ERP LƯU làm `Soctcu` của phiếu: `IDMES` (ghi-in-tem · kiểm phẩm · sửa đạt ·
//                  tem gia công) · `IDMes` (phân loại lỗi) · `IDPhieuGiao` (phiếu giao).
//   · Chiều XIN SỐ → chính mã ERP cấp (mã tem 15/17/13 · ID phiếu giao). Lượt lỗi không có mã ⇒ ID sinh ở đây.
//   · Chiều KÉO danh sách (đồng bộ đợt vải · phần in đã sửa thông tin) → ID sinh ở đây, GỬI KÈM lên ERP
//     trong query `IDKetNoi` để log truy cập bên ERP cũng có (router bỏ qua khóa lạ, vô hại).
//
// ⚠ KHÔNG dùng dãy `IDMES` (utils/idMes.js) cho chiều kéo: dãy đó trần 9999 lượt/ngày và ERP đọc nó làm
//   số chứng từ — 2 job kéo chạy 5 phút/lần sẽ ăn ~576 số/ngày vô ích.
// Dạng: `<TIỀN TỐ>-YYMMDDHHmmss-<3 số ngẫu nhiên>` theo giờ VN, vd `KN-260927142501-042`.
// ─────────────────────────────────────────────────────────────────────────────

function taoIdKetNoi(tienTo = 'KN') {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh', year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const g = (t) => (p.find((x) => x.type === t) || {}).value || '00';
  const gio = g('hour') === '24' ? '00' : g('hour');
  const r = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  return `${tienTo}-${g('year')}${g('month')}${g('day')}${gio}${g('minute')}${g('second')}-${r}`;
}

// Rút ID kết nối từ thân gửi đi (các tên khóa khác nhau giữa các proc ERP).
function idTuBody(body) {
  if (!body || typeof body !== 'object') return null;
  const v = body.IDMES ?? body.IDMes ?? body.IDPhieuGiao ?? body.IDKetNoi ?? null;
  return v == null || v === '' ? null : String(v);
}

module.exports = { taoIdKetNoi, idTuBody };
