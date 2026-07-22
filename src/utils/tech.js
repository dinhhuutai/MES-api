'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// MỤC KỸ THUẬT READY THEO KHÁCH HÀNG (dùng chung service + các query build SQL).
// Với khách hàng trong KHUON_OPTIONAL_KH: mục "Khuôn" KHÔNG bắt buộc — READY hoàn tất
// chỉ cần Film + Mực (QC duyệt được dù chưa xác nhận Khuôn).
// Nguyên tắc "đủ mục KT" = Film & Mực đều DAT, VÀ (Khuôn DAT HOẶC khách ∈ danh sách bỏ khuôn).
// ⚠ KHÔNG dùng "đếm ≥ N" (sẽ sai khi khách II/AD có Khuôn+Film mà thiếu Mực).
// SQL trả về gộp 1 dòng được (IPS-safe) — không đặt comment `-- …` trong chuỗi SQL.
// ─────────────────────────────────────────────────────────────────────────────

// Khách hàng KHÔNG bắt buộc Khuôn (khớp theo khach_hang.ten_khach_hang; ERP set ma=ten).
const KHUON_OPTIONAL_KH = ['II', 'AD'];

// Danh sách literal an toàn cho SQL ('II','AD') — hằng code, không phải input người dùng.
const KHUON_OPT_SQL_LIST = KHUON_OPTIONAL_KH.map((k) => `'${k}'`).join(',');

function isKhuonOptional(tenKhach) {
  return KHUON_OPTIONAL_KH.includes(String(tenKhach || '').trim());
}

// Mục kỹ thuật CẦN thiết theo khách (JS side — cho FE/service dựng nhãn "/N").
function requiredTechItems(tenKhach) {
  return isKhuonOptional(tenKhach) ? ['FILM', 'MUC'] : ['KHUON', 'FILM', 'MUC'];
}

// Boolean "đủ mục KT" khi ĐÃ có sẵn trong scope: cột tên khách + 3 biểu thức EXISTS DAT từng mục.
function techDoneSql(khachExpr, existsKhuon, existsFilm, existsMuc) {
  return `(${existsFilm} AND ${existsMuc} AND ((${khachExpr}) IN (${KHUON_OPT_SQL_LIST}) OR ${existsKhuon}))`;
}

// Boolean "đủ mục KT" chỉ từ 1 biểu thức phần in (tự dựng EXISTS + subquery khách).
// pinExpr = biểu thức SQL trỏ phan_in.id (vd 'pin.id', 'a.phan_in_id', 's.phan_in_id').
function techDoneSqlByPin(pinExpr) {
  const dat = (ma) => `EXISTS(SELECT 1 FROM ket_qua_checkpoint k JOIN checkpoint c ON c.id=k.checkpoint_id WHERE k.phan_in_id=${pinExpr} AND c.ma_checkpoint='${ma}' AND k.trang_thai='DAT')`;
  const khach = `(SELECT kh.ten_khach_hang FROM phan_in p2 JOIN ma_hang mh2 ON mh2.id=p2.ma_hang_id JOIN don_hang dh2 ON dh2.id=mh2.don_hang_id JOIN khach_hang kh ON kh.id=dh2.khach_hang_id WHERE p2.id=${pinExpr})`;
  return techDoneSql(khach, dat('KHUON'), dat('FILM'), dat('MUC'));
}

module.exports = {
  KHUON_OPTIONAL_KH, KHUON_OPT_SQL_LIST, isKhuonOptional, requiredTechItems, techDoneSql, techDoneSqlByPin,
};
