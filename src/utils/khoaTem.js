'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// KHÓA TEM SAU 2 NGÀY (17/11/2026, người dùng: "sau 2 ngày tự động khóa các tem, chỉ admin mới mở và sửa").
// Tem in quá `GIO_KHOA_TEM` giờ (tính từ `tem.created_date` = lúc bấm In tem lần đầu) ⇒ KHÓA: chỉ tài khoản ADMIN
// (permission '*') còn Sửa tem · sửa Vải hủy/thiếu · Hủy tem · Mở lại tem đã hủy. Không cần migration — khóa SUY
// từ giờ in, không lưu cột.
// ⚠ Khóa chỉ chặn các lệnh SỬA THÔNG TIN TEM ở trên. Luồng sản xuất (phơi · KCS · Sửa · OQC · giao), In lại tờ tem và
//   các trang Hệ thống khác KHÔNG bị chặn — tem chờ KCS quá 2 ngày vẫn phải đi tiếp được.
// ⚠ Trang Quản trị phần in (quyền PHAN_IN_ADMIN) truyền `boQuaKhoa` như đã bỏ qua hạn 2 ngày mở lại phiếu (`boQuaHan`).
// Công tắc `KHOA_TEM_SAU_2_NGAY` ở Hệ thống › Cài đặt tính năng (mặc định BẬT) — tắt thì mọi người sửa như trước.
// ⚠ Giờ khóa tính bằng đồng hồ DB (`CURRENT_TIMESTAMP`) ⇒ FE chỉ HIỆN theo cờ `da_khoa` backend trả, không tự tính.
// ─────────────────────────────────────────────────────────────────────────────

const AppError = require('./AppError');
const { tinhNangBat } = require('./caiDatTinhNang');

const GIO_KHOA_TEM = 48;
const MA_TN_KHOA_TEM = 'KHOA_TEM_SAU_2_NGAY';

// Admin = mang '*' (role ADMIN). Role KHACH cũng mang '*' nhưng bị cờ CHI_XEM chặn mọi lệnh ghi ở middleware auth.
const laAdmin = (user) => ((user && user.permissions) || []).includes('*');

// Cột SQL (bảng tem alias `a`): đã khóa chưa + mốc khóa. Viết 1 dòng, không `--` (câu bị gộp 1 dòng).
const temDaKhoaSql = (a = 't') => `(${a}.created_date < CURRENT_TIMESTAMP - interval '${GIO_KHOA_TEM} hours')`;
const khoaLucSql = (a = 't') => `(${a}.created_date + interval '${GIO_KHOA_TEM} hours')`;

const khoaTemBat = () => tinhNangBat(MA_TN_KHOA_TEM);

// Chặn khi tem đã khóa. `tem` phải có `da_khoa` (từ `temDaKhoaSql`) + `ma_tem`. `viec` = động từ hiện trong câu báo.
async function chanTemKhoa(tem, { boQuaKhoa = false, viec = 'sửa' } = {}) {
  if (boQuaKhoa || !tem || !tem.da_khoa) return;
  if (!(await khoaTemBat())) return;
  throw new AppError(
    `Tem ${tem.ma_tem || ''} in quá ${GIO_KHOA_TEM / 24} ngày nên đã khóa — chỉ admin mới ${viec} được`,
    { status: 403, errorCode: 'TEM_DA_KHOA' }
  );
}

// Danh sách tem trả FE (cột `da_khoa` từ `temDaKhoaSql`): công tắc đang TẮT ⇒ hạ cờ để FE không hiện khóa. Sửa tại chỗ.
async function apCoKhoa(rows) {
  if (Array.isArray(rows) && rows.length && !(await khoaTemBat())) rows.forEach((r) => { r.da_khoa = false; });
  return rows;
}

module.exports = {
  GIO_KHOA_TEM, MA_TN_KHOA_TEM, laAdmin, temDaKhoaSql, khoaLucSql, khoaTemBat, chanTemKhoa, apCoKhoa,
};
