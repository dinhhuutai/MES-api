'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// KHÓA TEM — THEO TỪNG TEM (17/11/2026 khóa tự động sau 2 ngày; 18/11/2026 người dùng: "muốn khóa theo từng tem, và mở
//   khóa lại theo từng tem").
// Tem ĐÃ KHÓA ⇒ chỉ tài khoản ADMIN (permission '*') còn Sửa tem · sửa Vải hủy/thiếu · Hủy tem · Mở lại tem đã hủy.
// Trạng thái khóa của 1 tem (nguồn DUY NHẤT `temDaKhoaSql`):
//   1. KHÓA / MỞ KHÓA TAY (admin bấm ở Danh sách tem in) — dòng `audit_log` MỚI NHẤT của khóa
//      `ten_bang='tem_khoa'`, `id_ban_ghi` = tem id: `KHOA_TEM` ⇒ khóa · `MO_KHOA_TEM` ⇒ mở, giữ tới khi admin khóa lại
//      (không tự khóa lại sau 48 giờ). Không cần migration — vết + giá trị cùng 1 chỗ.
//   2. Chưa ai bấm ⇒ TỰ ĐỘNG: in quá `GIO_KHOA_TEM` giờ (từ `tem.created_date`) thì khóa — khi công tắc
//      `KHOA_TEM_SAU_2_NGAY` (Hệ thống › Cài đặt tính năng, mặc định BẬT) đang bật. Công tắc CHỈ tắt phần tự động;
//      tem admin khóa tay vẫn khóa.
// ⚠ Khóa chỉ chặn các lệnh SỬA THÔNG TIN TEM ở trên. Luồng sản xuất (phơi · KCS · Sửa · OQC · giao), In lại tờ tem và
//   các trang Hệ thống khác KHÔNG bị chặn — tem chờ KCS quá 2 ngày vẫn phải đi tiếp được.
// ⚠ Trang Quản trị phần in (quyền PHAN_IN_ADMIN) truyền `boQuaKhoa` như đã bỏ qua hạn 2 ngày mở lại phiếu (`boQuaHan`).
// ⚠ Giờ khóa tính bằng đồng hồ DB (`CURRENT_TIMESTAMP`) + công tắc đọc thẳng bảng ⇒ FE chỉ HIỆN theo cờ `da_khoa`.
// ─────────────────────────────────────────────────────────────────────────────

const AppError = require('./AppError');

const GIO_KHOA_TEM = 48;
const MA_TN_KHOA_TEM = 'KHOA_TEM_SAU_2_NGAY';
const BANG_KHOA = 'tem_khoa';
const HD_KHOA = 'KHOA_TEM';
const HD_MO = 'MO_KHOA_TEM';

// Admin = mang '*' (role ADMIN). Role KHACH cũng mang '*' nhưng bị cờ CHI_XEM chặn mọi lệnh ghi ở middleware auth.
const laAdmin = (user) => ((user && user.permissions) || []).includes('*');

// Các biểu thức SQL (bảng tem alias `a`) — viết 1 dòng, không `--` (câu bị gộp 1 dòng).
const tuDongBatSql = `NOT EXISTS (SELECT 1 FROM cai_dat_tinh_nang zkt WHERE zkt.ma_tinh_nang = '${MA_TN_KHOA_TEM}' AND zkt.bat = false)`;
const khoaTayHdSql = (a = 't') => `(SELECT zk.hanh_dong FROM audit_log zk WHERE zk.ten_bang = '${BANG_KHOA}' AND zk.id_ban_ghi = ${a}.id::text ORDER BY zk.thoi_gian DESC LIMIT 1)`;
const temDaKhoaSql = (a = 't') => `(CASE ${khoaTayHdSql(a)} WHEN '${HD_KHOA}' THEN true WHEN '${HD_MO}' THEN false ELSE (${a}.created_date < CURRENT_TIMESTAMP - interval '${GIO_KHOA_TEM} hours' AND ${tuDongBatSql}) END)`;
const khoaLucSql = (a = 't') => `(${a}.created_date + interval '${GIO_KHOA_TEM} hours')`;
// Lần khóa / mở khóa tay MỚI NHẤT (để hiện "admin X khóa / mở lúc Y") — jsonb { hd, luc, boi, ly_do } hoặc NULL.
const khoaTaySql = (a = 't') => `(SELECT jsonb_build_object('hd', zk.hanh_dong, 'luc', zk.thoi_gian, 'boi', znd.ho_ten, 'ly_do', zk.gia_tri_moi->>'ly_do') FROM audit_log zk LEFT JOIN nguoi_dung znd ON znd.id = zk.nguoi_thuc_hien_id WHERE zk.ten_bang = '${BANG_KHOA}' AND zk.id_ban_ghi = ${a}.id::text ORDER BY zk.thoi_gian DESC LIMIT 1)`;

// Chặn khi tem đã khóa. `tem` phải có `da_khoa` (từ `temDaKhoaSql`) + `ma_tem`. `viec` = động từ hiện trong câu báo.
async function chanTemKhoa(tem, { boQuaKhoa = false, viec = 'sửa' } = {}) {
  if (boQuaKhoa || !tem || !tem.da_khoa) return;
  throw new AppError(
    `Tem ${tem.ma_tem || ''} đã khóa — chỉ admin mới ${viec} được (nhờ admin mở khóa tem ở Danh sách tem in)`,
    { status: 403, errorCode: 'TEM_DA_KHOA' }
  );
}

module.exports = {
  GIO_KHOA_TEM, MA_TN_KHOA_TEM, BANG_KHOA, HD_KHOA, HD_MO,
  laAdmin, temDaKhoaSql, khoaLucSql, khoaTaySql, khoaTayHdSql, chanTemKhoa,
};
