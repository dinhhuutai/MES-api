'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// THÔNG BÁO HỆ THỐNG (chuông) — họ thứ 3 của `utils/thongBao.LOAI_TB` (nguồn `HE_THONG`, 19/11/2026).
// Nội dung KHÔNG có bảng gốc (khác họ Trả về / Duyệt) ⇒ lưu ở `audit_log`: `ten_bang='thong_bao'`, MỖI NGƯỜI NHẬN 1 DÒNG
//   (`id_ban_ghi` = id người nhận ⇒ đọc theo index `idx_audit_log_bang`), `hanh_dong` = mã loại, `gia_tri_moi` =
//   { tieu_de, noi_dung, nhan, trang, ...du_lieu }. Đã đọc = `thong_bao_da_doc` nguồn 'HE_THONG' (nguon_id = audit.id).
// Gửi ĐÍCH DANH (`userIds`) — vẫn qua 2 tầng lọc: hệ thống bật loại · người nhận không tắt loại đó (`thongBao.nguoiNhan`).
// ⚠ KHÔNG BAO GIỜ NÉM LỖI — gọi sau khi nghiệp vụ đã xong; thông báo hỏng không được kéo theo lỗi.
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../config/db');
const tb = require('./thongBao');

const TEN_BANG = 'thong_bao';

// Tài khoản QUẢN TRỊ = vai trò ADMIN còn hoạt động (không lấy theo quyền '*': vai trò KHACH cũng mang '*').
async function idQuanTri() {
  try {
    const { rows } = await query(
      `SELECT DISTINCT u.id FROM nguoi_dung u JOIN user_role ur ON ur.user_id = u.id
         JOIN vai_tro v ON v.id = ur.role_id AND v.ma_role = 'ADMIN' WHERE u.dang_hoat_dong`.replace(/\s+/g, ' '));
    return rows.map((r) => r.id);
  } catch (e) { return []; }
}

/**
 * @param {{ maLoai: string, userIds: string[], tieuDe: string, noiDung?: string, trang?: string, duLieu?: object }} o
 * @returns {Promise<number>} số người đã nhận
 */
async function gui({ maLoai, userIds, tieuDe, noiDung = '', trang = null, duLieu = {} }) {
  try {
    const cfg = tb.LOAI_TB[maLoai];
    if (!cfg || cfg.nguon !== 'HE_THONG') return 0;
    if (!(await tb.heThongBat(maLoai))) return 0;
    const ids = await tb.nguoiNhan(maLoai, { userIds: [...new Set((userIds || []).filter(Boolean).map(String))] });
    if (!ids.length) return 0;
    const moi = {
      ...duLieu, tieu_de: String(tieuDe || cfg.ten).slice(0, 200), noi_dung: String(noiDung || '').slice(0, 4000),
      nhan: tb.nhanLuong(cfg), trang: trang || cfg.trang || null,
    };
    await query(
      `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, thoi_gian)
       SELECT '${TEN_BANG}', x::text, $2, $3::jsonb, clock_timestamp() FROM unnest($1::uuid[]) x`.replace(/\s+/g, ' '),
      [ids, maLoai, JSON.stringify(moi)]);
    const sockets = require('../sockets'); // nạp lười — sockets ↔ utils
    sockets.emit('thong-bao:moi', { ma_loai: maLoai, user_ids: ids });
    guiPush(ids, moi, maLoai).catch(() => {});
    return ids.length;
  } catch (e) {
    console.error(`[thong-bao-he-thong] ✗ ${maLoai}: ${e.message}`);
    return 0;
  }
}

// Web Push cho máy đã đóng app — chỉ khi cờ hệ thống PUSH_NEN bật (cùng luật `thongbao.service banThongBao`).
async function guiPush(ids, moi, maLoai) {
  const webPush = require('./webPush');
  if (!(await tb.heThongBat('PUSH_NEN')) || !webPush.dungDuoc()) return;
  const repo = require('../modules/thongbao/thongbao.repository');
  const subs = await repo.dsPushTheoUser(ids);
  if (!subs.length) return;
  const kq = await webPush.guiNhieu(subs, {
    tieu_de: moi.tieu_de, than: String(moi.noi_dung || '').slice(0, 300), duong_dan: moi.trang || '/thong-bao', the: `ht-${maLoai}-${Date.now()}`,
  });
  if (kq.endpoint_chet.length) await Promise.all(kq.endpoint_chet.map((e) => repo.xoaPush(e).catch(() => {})));
}

module.exports = { gui, idQuanTri, TEN_BANG };
