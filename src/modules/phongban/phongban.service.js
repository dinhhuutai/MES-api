'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// PHÒNG BAN & TỔ (mig 104) — xem danh sách + SỬA TÊN phòng / tổ.
//
// ⚠ Mã phòng / mã tổ do phòng nhân sự đặt (CCL, CSX, TO 1…) và được nạp bằng script
//   `database/scripts/gan_phong_ban_to_nhan_vien.sql` ⇒ trang này KHÔNG sửa mã, chỉ sửa TÊN + ghi chú.
// ⚠⚠ DÒ BẢNG `to_phong_ban` TRƯỚC (khuôn `temCoCot` mig 066): thiếu mig 104 thì vẫn liệt kê + sửa tên
//   PHÒNG được, tổ để trống và FE hiện banner nhắc chạy migration. KHÔNG try/catch quanh SQL.
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../../config/db');
const AppError = require('../../utils/AppError');

let _coBang = null;
async function coBangTo() {
  if (_coBang) return true;            // chỉ cache khi ĐÃ có ⇒ chạy migration xong nhận ngay
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE (table_name = 'to_phong_ban' AND column_name = 'ten_to')
         OR (table_name = 'nguoi_dung' AND column_name = 'to_phong_ban_id')`.replace(/\s+/g, ' ')
  );
  _coBang = rows[0].n === 2;
  return _coBang;
}

async function danhSach() {
  const coTo = await coBangTo();
  const { rows: phong } = await query(
    `SELECT pb.id, pb.ma_phong_ban, pb.ten_phong_ban, pb.ghi_chu, pb.dang_hoat_dong,
            (SELECT count(*)::int FROM nguoi_dung n WHERE n.phong_ban_id = pb.id AND n.dang_hoat_dong) AS so_nguoi
       FROM phong_ban pb ORDER BY pb.dang_hoat_dong DESC, pb.ma_phong_ban`.replace(/\s+/g, ' ')
  );
  let to = [];
  if (coTo) {
    ({ rows: to } = await query(
      `SELECT t.id, t.phong_ban_id, t.ma_to, t.ten_to, t.ghi_chu, t.dang_hoat_dong,
              (SELECT count(*)::int FROM nguoi_dung n WHERE n.to_phong_ban_id = t.id AND n.dang_hoat_dong) AS so_nguoi
         FROM to_phong_ban t ORDER BY t.ma_to`.replace(/\s+/g, ' ')
    ));
  }
  return {
    co_bang_to: coTo,
    items: phong.map((p) => ({ ...p, to_list: to.filter((t) => t.phong_ban_id === p.id) })),
  };
}

function chuanTen(v, ten) {
  const s = String(v == null ? '' : v).trim();
  if (!s) throw new AppError(`Nhập ${ten}`, { status: 422, errorCode: 'NO_TEN' });
  if (s.length > 255) throw new AppError(`${ten} quá dài (tối đa 255 ký tự)`, { status: 422, errorCode: 'QUA_DAI' });
  return s;
}
const chuanGhiChu = (v) => { const s = String(v == null ? '' : v).trim(); return s || null; };

async function suaPhong(id, body = {}, actorId) {
  const ten = chuanTen(body.ten, 'tên phòng ban');
  const { rows } = await query(
    `UPDATE phong_ban SET ten_phong_ban = $2, ghi_chu = $3, updated_date = CURRENT_TIMESTAMP, updated_by = $4
      WHERE id = $1 RETURNING id, ma_phong_ban, ten_phong_ban`,
    [id, ten, chuanGhiChu(body.ghiChu), actorId]
  );
  if (!rows.length) throw new AppError('Không tìm thấy phòng ban', { status: 404, errorCode: 'NOT_FOUND' });
  return rows[0];
}

async function suaTo(id, body = {}, actorId) {
  if (!(await coBangTo())) {
    throw new AppError('Chưa chạy migration 104 — chưa có danh mục tổ', { status: 409, errorCode: 'THIEU_MIGRATION' });
  }
  const ten = chuanTen(body.ten, 'tên tổ');
  const { rows } = await query(
    `UPDATE to_phong_ban SET ten_to = $2, ghi_chu = $3, updated_date = CURRENT_TIMESTAMP, updated_by = $4
      WHERE id = $1 RETURNING id, ma_to, ten_to`,
    [id, ten, chuanGhiChu(body.ghiChu), actorId]
  );
  if (!rows.length) throw new AppError('Không tìm thấy tổ', { status: 404, errorCode: 'NOT_FOUND' });
  return rows[0];
}

module.exports = { danhSach, suaPhong, suaTo, coBangTo };
