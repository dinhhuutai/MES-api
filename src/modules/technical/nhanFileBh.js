'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// NHẬN FILE BH — màn Chuẩn bị kỹ thuật — READY (11/11/2026, người dùng chốt).
//   Bán hàng mang hồ sơ CỨNG sang Kỹ thuật ⇒ KT chuột phải dòng READY ⇒ "Đưa vào danh sách đã nhận file" (dòng đã nhận:
//   "Hủy khỏi danh sách đã nhận"). Dòng đã nhận vẫn ở bảng chính, STT khoanh tròn; nút "Đã nhận file (N)" mở danh sách.
//   · Đánh dấu THEO ĐỢT VẢI (đợt mới về phải nhận lại) — khóa = `dot_vai_ve.id`.
//   · CHỈ ĐỂ BIẾT: không chặn xác nhận Khuôn / Film / Mực / QC.
//   · Quyền ghi = quyền xác nhận READY kỹ thuật (Khuôn / Film / Mực).
// LƯU = TRẠNG THÁI TRONG `audit_log` (không migration — như `DAU_CA_IN_TEM`, DATABASE.md §8): `ten_bang` 'nhan_file_bh',
//   `id_ban_ghi` = id đợt vải, `hanh_dong` NHAN_FILE_BH | HUY_NHAN_FILE_BH — dòng MỚI NHẤT của khóa là giá trị.
// ─────────────────────────────────────────────────────────────────────────────

const { query, withTransaction } = require('../../config/db');
const asyncHandler = require('../../utils/asyncHandler');
const AppError = require('../../utils/AppError');
const { ok } = require('../../utils/response');
const sockets = require('../../sockets');

const TEN_BANG = 'nhan_file_bh';
const NHAN = 'NHAN_FILE_BH';
const HUY = 'HUY_NHAN_FILE_BH';
const TOI_DA = 500; // đợt / lần bấm

const laUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
const dsId = (v) => [...new Set((Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(laUuid))];

// Đợt ĐANG ở danh sách đã nhận ⇒ Map(dotId → { nguoi, tg }). Dòng mới nhất của mỗi khóa quyết định.
async function trangThaiTheoDot(dotIds, client = null) {
  const ids = dsId(dotIds);
  const kq = new Map();
  if (!ids.length) return kq;
  const { rows } = await (client || { query }).query(
    `SELECT DISTINCT ON (a.id_ban_ghi) a.id_ban_ghi, a.hanh_dong, a.thoi_gian, nd.ho_ten
       FROM audit_log a LEFT JOIN nguoi_dung nd ON nd.id = a.nguoi_thuc_hien_id
      WHERE a.ten_bang = $1 AND a.id_ban_ghi = ANY($2::text[])
      ORDER BY a.id_ban_ghi, a.thoi_gian DESC`.replace(/\s+/g, ' ').trim(),
    [TEN_BANG, ids]
  );
  rows.forEach((r) => { if (r.hanh_dong === NHAN) kq.set(r.id_ban_ghi, { nguoi: r.ho_ten || null, tg: r.thoi_gian }); });
  return kq;
}

// Gắn `nhan_file` vào các dòng màn READY (mỗi dòng mang `dot_vai_ids`): { da_nhan (mọi đợt của dòng đã nhận), so_dot_nhan,
//   so_dot, nguoi, tg (lần nhận mới nhất) }. Lỗi đọc ⇒ bỏ qua (tính năng phụ, không sập màn READY).
async function ganVaoDong(items) {
  try {
    const ids = [...new Set(items.flatMap((r) => (Array.isArray(r.dot_vai_ids) ? r.dot_vai_ids : [])))];
    const map = await trangThaiTheoDot(ids);
    items.forEach((r) => {
      const ds = Array.isArray(r.dot_vai_ids) ? r.dot_vai_ids : [];
      const nhan = ds.map((id) => map.get(String(id))).filter(Boolean);
      if (!nhan.length) return;
      const moi = nhan.reduce((a, b) => (new Date(b.tg) > new Date(a.tg) ? b : a));
      r.nhan_file = { da_nhan: nhan.length === ds.length, so_dot_nhan: nhan.length, so_dot: ds.length, nguoi: moi.nguoi, tg: moi.tg };
    });
  } catch (e) {
    console.error(`[nhan-file-bh] ✗ Đọc trạng thái lỗi: ${e.message}`);
  }
  return items;
}

// Đưa đợt vào / gỡ khỏi danh sách đã nhận file. Chỉ ghi đợt ĐỔI trạng thái (đợt đã đúng trạng thái ⇒ bỏ qua).
async function datNhanFile(dotVaiIds, nhan, actorId) {
  const ids = dsId(dotVaiIds);
  if (!ids.length) throw new AppError('Chọn ít nhất 1 dòng (đợt vải)', { status: 422, errorCode: 'NO_DOT_VAI' });
  if (ids.length > TOI_DA) throw new AppError(`Tối đa ${TOI_DA} đợt vải mỗi lần`, { status: 422, errorCode: 'QUA_NHIEU' });
  if (typeof nhan !== 'boolean') throw new AppError('Thiếu thao tác (nhận / hủy)', { status: 422, errorCode: 'NO_NHAN' });
  const kq = await withTransaction(async (client) => {
    // 2 người bấm cùng lúc ⇒ xếp hàng, đọc lại trạng thái sau khóa (không ghi 2 dòng cùng trạng thái).
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [TEN_BANG]);
    const { rows: dots } = await client.query(
      `SELECT dv.id::text AS id, dv.ma_dot_vai, dv.phan_in_id, p.ma_phan
         FROM dot_vai_ve dv JOIN phan_in p ON p.id = dv.phan_in_id
        WHERE dv.id = ANY($1::uuid[]) AND dv.trang_thai NOT IN ('DA_HUY','DA_GOP')`.replace(/\s+/g, ' ').trim(),
      [ids]
    );
    if (!dots.length) throw new AppError('Không tìm thấy đợt vải (đã hủy / đã gộp?)', { status: 404, errorCode: 'NOT_FOUND' });
    const hien = await trangThaiTheoDot(dots.map((d) => d.id), client);
    const doi = dots.filter((d) => hien.has(d.id) !== nhan);
    for (const d of doi) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5, CURRENT_TIMESTAMP, $5)`,
        [TEN_BANG, d.id, nhan ? NHAN : HUY,
          JSON.stringify({ phan_in_id: d.phan_in_id, ma_phan: d.ma_phan, ma_dot_vai: d.ma_dot_vai }), actorId]
      );
    }
    return { so_doi: doi.length, so_bo_qua: dots.length - doi.length, khong_thay: ids.length - dots.length };
  });
  // Màn READY / QC READY nghe `ready:confirmed` (tải ngầm) — dùng chung, khỏi thêm sự kiện mới.
  if (kq.so_doi) sockets.emit('ready:confirmed', { nhanFile: true, dotVaiIds: ids });
  return { ...kq, nhan };
}

const ctl = {
  datNhanFile: asyncHandler(async (req, res) => {
    const r = await datNhanFile(req.body.dotVaiIds, req.body.nhan, req.user.id);
    return ok(res, r, r.nhan ? 'Đã đưa vào danh sách đã nhận file' : 'Đã hủy khỏi danh sách đã nhận file');
  }),
};

module.exports = { trangThaiTheoDot, ganVaoDong, datNhanFile, ctl, TEN_BANG };
