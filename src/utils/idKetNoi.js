'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// ID KẾT NỐI — khóa truy vết cho MỌI lượt MES ↔ ERP (27/09/2026, người dùng yêu cầu: "tất cả những
// cái lấy từ ERP hay gửi sang ERP đều phải có ID").
//
// ⚠⚠ LUẬT (người dùng chốt lại 30/09/2026): ID KẾT NỐI LÀ MÃ DUY NHẤT DO **MES** TẠO RA — KHÔNG BAO GIỜ
//   lấy mã do ERP cấp (số phiếu giao, mã tem 15/17/13). Mã ERP cấp vẫn được lưu riêng để tra.
// Nguồn của ID theo từng loại lượt gọi (lưu ở `audit_log.gia_tri_moi.id_mes`, cột "ID kết nối"
// ở *Hệ thống › Cài đặt API › Lịch sử*):
//   · Chiều ĐẨY (API có tham số `pIDMES`) → `IDMES` cấp từ dãy `utils/idMes.js`: ghi-in-tem · kiểm phẩm ·
//                  sửa đạt · tem gia công (`IDMES`) · phân loại lỗi (`IDMes`) · **phiếu giao (`IDMES` → router ERP
//                  bổ sung `@pIDMES`, 30/09; `@pID` vẫn là mã phiếu giao — không phải ID kết nối)**.
//   · Chiều XIN SỐ (mã tem 15/17/13 · ID phiếu giao) → ID sinh ở đây, gửi kèm query `IDKetNoi`.
//   · Chiều KÉO danh sách (đồng bộ đợt vải · phần in đã sửa thông tin) · hủy vải → ID sinh ở đây, GỬI
//     KÈM lên ERP (`IDKetNoi`) để log truy cập bên ERP cũng có (router bỏ qua khóa lạ, vô hại).
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
  // ⚠ KHÔNG còn đọc `IDPhieuGiao` — đó là mã ERP cấp, không phải ID kết nối (30/09/2026).
  const v = body.IDMES ?? body.IDMes ?? body.IDKetNoi ?? null;
  return v == null || v === '' ? null : String(v);
}

module.exports = { taoIdKetNoi, idTuBody };
