'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CHỜ KÝ TÊN — màn READY Kỹ thuật + QC READY (26/11/2026, người dùng chốt).
//   Kỹ thuật xác nhận xong Khuôn / Film / Mực thì mới đem hồ sơ đi KÝ TÊN ⇒ chuột phải dòng (hoặc tích dòng trong modal Quét /
//   tích của READY Kỹ thuật) ⇒ "Chờ ký tên"; ký xong ⇒ "Bỏ chờ ký tên". QC READY cũng đánh dấu được (KT quên đánh dấu mà đã
//   xác nhận xong — đợt đã nằm ở hàng đợi QC).
//   · Đánh dấu THEO ĐỢT VẢI (cùng khóa với Nhận file BH — `dot_vai_ve.id`).
//   · Ô STT khoanh Ô VUÔNG ĐỎ ở cả 2 màn (FE `ChoKyTen.js`).
//   · ⚠ SLA QC READY: đợt KT đã xong mà ĐANG chờ ký tên ⇒ CHƯA đếm (sla NULL — không đỏ, không vào Nghẽn, không hỏi lý do
//     nghẽn); bỏ chờ ký tên ⇒ đếm từ lúc bỏ (mốc QC = max(mốc cũ, lúc bỏ gần nhất)). Áp ở `technical.service listCandidates`.
//   · CHỈ ĐÁNH DẤU: KHÔNG chặn xác nhận Khuôn / Film / Mực / QC (người dùng chưa yêu cầu chặn).
//   · Quyền ghi = quyền xác nhận READY kỹ thuật (Khuôn / Film / Mực) HOẶC QC READY.
// LƯU = TRẠNG THÁI TRONG `audit_log` (không migration — như Nhận file BH, DATABASE.md §8): `ten_bang` 'cho_ky_ten',
//   `id_ban_ghi` = id đợt vải, `hanh_dong` CHO_KY_TEN | HUY_CHO_KY_TEN — dòng MỚI NHẤT của khóa là giá trị.
// ─────────────────────────────────────────────────────────────────────────────

const { query, withTransaction } = require('../../config/db');
const asyncHandler = require('../../utils/asyncHandler');
const AppError = require('../../utils/AppError');
const { ok } = require('../../utils/response');
const sockets = require('../../sockets');

const TEN_BANG = 'cho_ky_ten';
const CHO = 'CHO_KY_TEN';
const HUY = 'HUY_CHO_KY_TEN';
const TOI_DA = 500; // đợt / lần bấm

const laUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
const dsId = (v) => [...new Set((Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(laUuid))];

// Trạng thái theo đợt ⇒ Map(dotId → { dang, nguoi, tg }): `dang` = đang chờ ký tên (dòng mới nhất là CHO_KY_TEN); `tg` = lúc
//   của dòng mới nhất (đang chờ: lúc đánh dấu · đã bỏ: lúc BỎ — mốc bắt đầu đếm SLA QC). Đợt chưa từng đánh dấu ⇒ không có khóa.
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
  rows.forEach((r) => kq.set(r.id_ban_ghi, { dang: r.hanh_dong === CHO, nguoi: r.ho_ten || null, tg: r.thoi_gian }));
  return kq;
}

// Gắn `cho_ky_ten` vào các dòng READY / QC READY (mỗi dòng mang `dot_vai_ids`):
//   { dang (MỌI đợt của dòng đang chờ), so_dot_cho, so_dot, nguoi, tg (lần đánh dấu mới nhất) } khi có đợt đang chờ;
//   `bo_ky_ten_tg` = lần BỎ chờ ký tên gần nhất của các đợt trên dòng (mốc SLA QC — xem `apSlaQc`). Lỗi đọc ⇒ bỏ qua.
async function ganVaoDong(items) {
  try {
    const ids = [...new Set(items.flatMap((r) => (Array.isArray(r.dot_vai_ids) ? r.dot_vai_ids : [])))];
    const map = await trangThaiTheoDot(ids);
    if (!map.size) return items;
    items.forEach((r) => {
      const ds = Array.isArray(r.dot_vai_ids) ? r.dot_vai_ids : [];
      const tt = ds.map((id) => map.get(String(id))).filter(Boolean);
      const cho = tt.filter((x) => x.dang);
      const bo = tt.filter((x) => !x.dang);
      if (bo.length) r.bo_ky_ten_tg = bo.reduce((a, b) => (new Date(b.tg) > new Date(a.tg) ? b : a)).tg;
      if (!cho.length) return;
      const moi = cho.reduce((a, b) => (new Date(b.tg) > new Date(a.tg) ? b : a));
      r.cho_ky_ten = { dang: cho.length === ds.length, so_dot_cho: cho.length, so_dot: ds.length, nguoi: moi.nguoi, tg: moi.tg };
    });
  } catch (e) {
    console.error(`[cho-ky-ten] ✗ Đọc trạng thái lỗi: ${e.message}`);
  }
  return items;
}

// SLA QC READY theo chờ ký tên — gọi SAU `ganVaoDong`, chỉ màn QC. `slaTu(moc)` = SLA (phút) tính lại từ mốc mới.
//   · Dòng KT đã xong + ĐANG chờ ký tên (bất kỳ đợt nào trên dòng) ⇒ `sla_phut` NULL (chưa đếm), `sla_cho_ky_ten` = true.
//   · Đã bỏ chờ ký tên SAU mốc QC hiện tại ⇒ mốc = lúc bỏ, SLA tính lại (ký tên xong mới bắt đầu tính giờ QC).
function apSlaQc(items, slaTu) {
  items.forEach((r) => {
    if (!r.tech_done || !r.tg_vao) return;
    if (r.cho_ky_ten && r.cho_ky_ten.so_dot_cho > 0) {
      r.sla_phut = null;
      r.sla_cho_ky_ten = true;
      return;
    }
    if (r.bo_ky_ten_tg && new Date(r.bo_ky_ten_tg) > new Date(r.tg_vao)) {
      r.tg_vao = new Date(r.bo_ky_ten_tg).toISOString();
      r.sla_phut = slaTu(new Date(r.bo_ky_ten_tg));
    }
  });
  return items;
}

// Đánh dấu / bỏ chờ ký tên các đợt. Chỉ ghi đợt ĐỔI trạng thái (đợt đã đúng trạng thái ⇒ bỏ qua).
async function datChoKyTen(dotVaiIds, dang, actorId, nguon = null) {
  const ids = dsId(dotVaiIds);
  if (!ids.length) throw new AppError('Chọn ít nhất 1 dòng (đợt vải)', { status: 422, errorCode: 'NO_DOT_VAI' });
  if (ids.length > TOI_DA) throw new AppError(`Tối đa ${TOI_DA} đợt vải mỗi lần`, { status: 422, errorCode: 'QUA_NHIEU' });
  if (typeof dang !== 'boolean') throw new AppError('Thiếu thao tác (chờ ký tên / bỏ)', { status: 422, errorCode: 'NO_DANG' });
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
    const doi = dots.filter((d) => !!(hien.get(d.id) && hien.get(d.id).dang) !== dang);
    for (const d of doi) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5, CURRENT_TIMESTAMP, $5)`,
        [TEN_BANG, d.id, dang ? CHO : HUY,
          JSON.stringify({ phan_in_id: d.phan_in_id, ma_phan: d.ma_phan, ma_dot_vai: d.ma_dot_vai, nguon: nguon || null }), actorId]
      );
    }
    return { so_doi: doi.length, so_bo_qua: dots.length - doi.length, khong_thay: ids.length - dots.length };
  });
  // Màn READY / QC READY nghe `ready:confirmed` (tải ngầm) — dùng chung, khỏi thêm sự kiện mới.
  if (kq.so_doi) sockets.emit('ready:confirmed', { choKyTen: true, dotVaiIds: ids });
  return { ...kq, dang };
}

const NGUON = new Set(['KT', 'QC']);
const ctl = {
  datChoKyTen: asyncHandler(async (req, res) => {
    const nguon = NGUON.has(String(req.body.nguon || '').toUpperCase()) ? String(req.body.nguon).toUpperCase() : null;
    const r = await datChoKyTen(req.body.dotVaiIds, req.body.dang, req.user.id, nguon);
    return ok(res, r, r.dang ? 'Đã đánh dấu chờ ký tên' : 'Đã bỏ chờ ký tên');
  }),
};

module.exports = { trangThaiTheoDot, ganVaoDong, apSlaQc, datChoKyTen, ctl, TEN_BANG };
