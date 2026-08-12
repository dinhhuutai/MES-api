'use strict';

// PHIÊN ĐĂNG NHẬP (mig 081) — mỗi lần đăng nhập 1 dòng, có `jti` nhúng trong JWT.
//
// ⚠⚠ MỌI HÀM Ở ĐÂY PHẢI FAIL-OPEN: thiếu bảng (chưa chạy mig 081) thì đăng nhập/đăng xuất vẫn phải
//   chạy bình thường. Vì vậy hàm GHI bọc try/catch trả false, hàm ĐỌC trả mảng rỗng.
//   Tuyệt đối không để thiếu migration làm cả nhà máy không đăng nhập được.

const { query } = require('../../config/db');
const { mauTim } = require('../../utils/timKiem');

// Dò bảng 1 lần (chỉ cache khi ĐÃ có ⇒ chạy migration xong nhận ngay, không cần restart BE).
let _coBang = null;
async function coBangPhien() {
  if (_coBang) return true;
  try {
    const { rows } = await query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name='phien_dang_nhap'`
    );
    if (rows.length) _coBang = true;
    return rows.length > 0;
  } catch { return false; }
}

// Tạo phiên lúc đăng nhập. Trả true nếu ghi được.
async function taoPhien({ userId, jti, thietBi, userAgent, ip }) {
  if (!await coBangPhien()) return false;
  try {
    await query(
      `INSERT INTO phien_dang_nhap (nguoi_dung_id, jti, thiet_bi, user_agent, ip, created_by)
       VALUES ($1,$2,$3,$4,$5,$1)`,
      [userId, jti, thietBi || null, userAgent || null, ip || null]
    );
    return true;
  } catch (e) {
    console.error('[phien] Không ghi được phiên đăng nhập:', e.message);
    return false;
  }
}

// Đóng phiên. `loai`: 'DA_DANG_XUAT' (tự thoát) | 'BUOC_DANG_XUAT' (bị đăng xuất từ xa).
// Chỉ đóng phiên ĐANG HOAT_DONG ⇒ gọi lại lần 2 không ghi đè người/giờ của lần đầu.
async function dongPhienTheoJti(jti, loai = 'DA_DANG_XUAT', actorId = null, lyDo = null) {
  if (!jti || !await coBangPhien()) return false;
  try {
    const { rowCount } = await query(
      `UPDATE phien_dang_nhap SET trang_thai = $2, tg_ket_thuc = now(), nguoi_ket_thuc_id = $3,
         ly_do = $4, updated_by = $3, updated_date = now()
       WHERE jti = $1 AND trang_thai = 'HOAT_DONG'`,
      [jti, loai, actorId, lyDo]
    );
    return rowCount > 0;
  } catch { return false; }
}

async function dongPhienTheoId(id, actorId, lyDo) {
  if (!await coBangPhien()) return null;
  const { rows } = await query(
    `UPDATE phien_dang_nhap SET trang_thai = 'BUOC_DANG_XUAT', tg_ket_thuc = now(),
       nguoi_ket_thuc_id = $2, ly_do = $3, updated_by = $2, updated_date = now()
     WHERE id = $1 AND trang_thai = 'HOAT_DONG'
     RETURNING id, jti, nguoi_dung_id`,
    [id, actorId, lyDo || null]
  );
  return rows[0] || null;
}

// Đóng MỌI phiên đang hoạt động của 1 user, trừ `boQuaJti` (thường là phiên của chính người đang bấm).
async function dongMoiPhienCuaUser(userId, actorId, lyDo, boQuaJti = null) {
  if (!await coBangPhien()) return [];
  const { rows } = await query(
    `UPDATE phien_dang_nhap SET trang_thai = 'BUOC_DANG_XUAT', tg_ket_thuc = now(),
       nguoi_ket_thuc_id = $2, ly_do = $3, updated_by = $2, updated_date = now()
     WHERE nguoi_dung_id = $1 AND trang_thai = 'HOAT_DONG'
       AND ($4::text IS NULL OR jti <> $4)
     RETURNING id, jti`,
    [userId, actorId, lyDo || null, boQuaJti]
  );
  return rows;
}

// Mốc "đăng xuất mọi thiết bị" — đường DUY NHẤT chặn được token CŨ (không có `jti`).
// ⚠ Đặt mốc = now() thì token của CHÍNH người đang bấm cũng bị chặn (nó phát trước now()) ⇒ caller
//   phải cân nhắc; hàm `dangXuatMoiThietBi` ở service dùng cho tài khoản KHÁC.
async function datMocDangXuat(userId, actorId) {
  try {
    const { rowCount } = await query(
      `UPDATE nguoi_dung SET tg_buoc_dang_xuat_truoc = now(), updated_by = $2, updated_date = now()
       WHERE id = $1`,
      [userId, actorId]
    );
    return rowCount > 0;
  } catch { return false; }   // chưa chạy mig 081 → bỏ qua, phần theo `jti` vẫn chạy
}

// Cập nhật "hoạt động cuối" — gọi GIÃN CÁCH (không phải mỗi request), best-effort.
async function chamPhien(jti) {
  if (!jti || !await coBangPhien()) return;
  try {
    await query(
      "UPDATE phien_dang_nhap SET tg_hoat_dong_cuoi = now() WHERE jti = $1 AND trang_thai = 'HOAT_DONG'",
      [jti]
    );
  } catch { /* không chặn request vì lỗi ghi mốc hoạt động */ }
}

// Danh sách phiên. `chiHoatDong` (mặc định true) · `search` tìm theo tên/tên đăng nhập/thiết bị/IP.
// ⚠ Tìm bằng `~*` + `mauTim` (KHÔNG dấu, không phân biệt hoa–thường) — quy ước chung của dự án (§8).
async function listPhien({ search = '', chiHoatDong = true, userId = null, limit = 300 } = {}) {
  if (!await coBangPhien()) return [];
  const dk = ["1=1"];
  const vals = [];
  if (chiHoatDong) dk.push("p.trang_thai = 'HOAT_DONG'");
  if (userId) dk.push(`p.nguoi_dung_id = $${vals.push(userId)}`);
  if (String(search || '').trim()) {
    const i = vals.push(mauTim(search));
    dk.push(`(nd.ho_ten ~* $${i} OR nd.ten_dang_nhap ~* $${i} OR p.thiet_bi ~* $${i} OR p.ip ~* $${i})`);
  }
  const sql = `
    SELECT p.id, p.jti, p.nguoi_dung_id, p.thiet_bi, p.ip, p.user_agent,
           p.tg_dang_nhap, p.tg_hoat_dong_cuoi, p.trang_thai, p.tg_ket_thuc, p.ly_do,
           nd.ho_ten, nd.ten_dang_nhap, nd.chuc_vu, pb.ten_phong_ban,
           nk.ho_ten AS nguoi_ket_thuc,
           count(*) FILTER (WHERE p.trang_thai = 'HOAT_DONG') OVER (PARTITION BY p.nguoi_dung_id)::int AS so_thiet_bi
    FROM phien_dang_nhap p
    JOIN nguoi_dung nd ON nd.id = p.nguoi_dung_id
    LEFT JOIN phong_ban pb ON pb.id = nd.phong_ban_id
    LEFT JOIN nguoi_dung nk ON nk.id = p.nguoi_ket_thuc_id
    WHERE ${dk.join(' AND ')}
    ORDER BY p.tg_hoat_dong_cuoi DESC
    LIMIT ${Math.min(Number(limit) || 300, 500)}`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), vals);
  return rows;
}

const getPhien = async (id) => {
  if (!await coBangPhien()) return null;
  const { rows } = await query(
    `SELECT p.id, p.jti, p.nguoi_dung_id, p.trang_thai, p.thiet_bi, nd.ho_ten, nd.ten_dang_nhap
       FROM phien_dang_nhap p JOIN nguoi_dung nd ON nd.id = p.nguoi_dung_id WHERE p.id = $1`,
    [id]
  );
  return rows[0] || null;
};

module.exports = {
  coBangPhien, taoPhien, dongPhienTheoJti, dongPhienTheoId, dongMoiPhienCuaUser,
  datMocDangXuat, chamPhien, listPhien, getPhien,
};
