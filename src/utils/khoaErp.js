'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// KHÓA ĐỒNG BỘ ERP CỦA 1 PHẦN IN (mig 116, 19/10/2026 — người dùng chốt).
//
// LUẬT:
//   · Admin SỬA TAY thông tin phần in / đợt vải ở *Hệ thống › Quản trị phần in* ⇒ phần in TỰ KHÓA (`phan_in.khoa_erp`).
//     (Chỉ trang đó khóa — trang GN "Phần in chờ sửa thông tin" dùng chung hàm sửa nhưng KHÔNG khóa.)
//   · Đang khóa ⇒ MỌI đường ERP ghi đè đều bỏ qua phần in đó + các đợt vải ĐÃ CÓ của nó:
//       job đồng bộ 5 phút (`erpsync.repository.upsertPhanIn` · `capNhatPhanInPhu` · `setPhanInDryMin` ·
//       `upsertDotVai` nhánh cập nhật · `setDotVaiKtCanKiemTra` · `promotePhanInToReady`) ·
//       "Cập nhật theo code phần" (`erpsync.service.ganLaiTheoDong` / `repo.ganLaiPhanIn`) ·
//       GN xác nhận lại trên ERP (`suathongtin/erpCapNhat.capNhatMotPhanIn`).
//     KHÔNG chặn: tạo ĐỢT VẢI MỚI (dòng chảy), luật KTCankiemtra của đợt mới, phần in hiện lại khi có đợt mới,
//       HSKT / phương án in (luật của MES, không phải thông tin ERP), đổi khóa đợt của luồng GN.
//   · Admin bấm "Mở khóa ERP" ⇒ lượt đồng bộ kế tiếp có dòng của phần in này lấy lại thông tin ERP như thường.
// ⚠ Chưa chạy mig 116 ⇒ mọi hàm ở đây coi như KHÔNG khóa (fail-open đúng hướng: đồng bộ chạy như cũ) và
//   `datKhoa` ném 409 `CHUA_MIGRATION_116`.
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../config/db');
const AppError = require('./AppError');

let _coCot = false;
// `runner` = client của transaction đang mở (hoặc bỏ trống ⇒ pool). Nhớ khi ĐÃ có (chạy mig xong nhận ngay).
async function coCotKhoaErp(runner) {
  if (_coCot) return true;
  const r = runner || { query };
  const { rows } = await r.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='phan_in' AND column_name='khoa_erp' LIMIT 1");
  _coCot = rows.length > 0;
  return _coCot;
}

// Điều kiện SQL "phần in `pinExpr` KHÔNG khóa ERP". Gọi khi đã biết có cột (`coCotKhoaErp`), không thì `TRUE`.
const khongKhoaSql = (pinExpr, coCot = true) => (coCot
  ? `NOT COALESCE((SELECT zkh.khoa_erp FROM phan_in zkh WHERE zkh.id = ${pinExpr}), false)`
  : 'TRUE');

async function dangKhoa(phanInId, runner) {
  if (!phanInId || !(await coCotKhoaErp(runner))) return false;
  const r = runner || { query };
  const { rows } = await r.query('SELECT khoa_erp FROM phan_in WHERE id = $1', [phanInId]);
  return !!(rows[0] && rows[0].khoa_erp);
}

// Khóa / mở khóa + audit `KHOA_ERP` / `MO_KHOA_ERP` (ten_bang 'phan_in'). Trả true khi trạng thái THẬT SỰ đổi.
async function datKhoa(phanInId, khoa, actorId, { lyDo = null } = {}) {
  if (!(await coCotKhoaErp())) {
    throw new AppError('Chưa chạy migration 116 — chưa khóa / mở khóa đồng bộ ERP được', { status: 409, errorCode: 'CHUA_MIGRATION_116' });
  }
  const { rows } = await query(
    `UPDATE phan_in SET khoa_erp = $2,
            khoa_erp_tg = CASE WHEN $2 THEN CURRENT_TIMESTAMP ELSE khoa_erp_tg END,
            khoa_erp_boi = CASE WHEN $2 THEN $3::uuid ELSE khoa_erp_boi END,
            updated_by = $3, updated_date = CURRENT_TIMESTAMP
      WHERE id = $1 AND khoa_erp IS DISTINCT FROM $2 RETURNING id, ma_phan`.replace(/\s+/g, ' '),
    [phanInId, !!khoa, actorId || null]
  );
  if (!rows.length) return false;
  await query(
    `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ('phan_in', $1, $2, $3::jsonb, $4, CURRENT_TIMESTAMP, $4)`,
    [String(phanInId), khoa ? 'KHOA_ERP' : 'MO_KHOA_ERP', JSON.stringify({ ma_phan: rows[0].ma_phan, ly_do: lyDo }), actorId || null]
  );
  return true;
}

module.exports = { coCotKhoaErp, khongKhoaSql, dangKhoa, datKhoa };
