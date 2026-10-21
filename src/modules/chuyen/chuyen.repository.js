'use strict';

const { query } = require('../../config/db');
const { mauTim } = require('../../utils/timKiem');
const AppError = require('../../utils/AppError');

// TỔ CỦA CHUYỀN (mig 117, 21/10/2026 — `chuyen_san_xuat.to_in_id`, dùng cho thống kê theo tổ ở Theo dõi chuyền in).
// Dò cột trước khi dùng — chưa chạy migration thì mọi câu chạy như cũ (không tổ). Nhớ "đã có" mãi, "chưa có" dò lại.
let _coCotTo = false;
async function chuyenCoCotTo() {
  if (_coCotTo) return true;
  try {
    const { rows } = await query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='chuyen_san_xuat' AND column_name='to_in_id' LIMIT 1`.replace(/\s+/g, ' ')
    );
    _coCotTo = rows.length > 0;
  } catch { _coCotTo = false; }
  return _coCotTo;
}

async function listChuyen({ search = '' }) {
  const coTo = await chuyenCoCotTo();
  const { rows } = await query(
    `SELECT cs.id, cs.ma_chuyen, cs.ten_chuyen, cs.loai_chuyen_id, cs.dinh_muc_gio, cs.so_pass, cs.dang_hoat_dong,
            lc.ma_loai AS loai_ma, lc.ten_loai AS loai_ten,
            ${coTo ? 'cs.to_in_id, ti.ma_to, ti.ten_to' : 'NULL::uuid AS to_in_id, NULL::text AS ma_to, NULL::text AS ten_to'},
            ${coTo} AS co_cot_to
     FROM chuyen_san_xuat cs
     LEFT JOIN loai_chuyen lc ON lc.id = cs.loai_chuyen_id
     ${coTo ? 'LEFT JOIN to_in ti ON ti.id = cs.to_in_id' : ''}
     WHERE ($1 = '' OR cs.ma_chuyen ~* $1 OR cs.ten_chuyen ~* $1 OR lc.ten_loai ~* $1)
     ORDER BY cs.ma_chuyen`.replace(/\s+/g, ' '),
    [mauTim(search)]
  );
  return rows;
}

// `d.toInId`: undefined = không đụng tổ · null/'' = bỏ tổ · uuid = gán. Chưa có cột (mig 117) ⇒ bỏ qua.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function kiemToIn(d) {
  if (d.toInId && !UUID_RE.test(String(d.toInId))) {
    throw new AppError('Tổ không hợp lệ', { status: 422, errorCode: 'TO_IN_SAI' });
  }
}

async function createChuyen(d, actor) {
  kiemToIn(d);
  const themTo = d.toInId !== undefined && (await chuyenCoCotTo());
  const { rows } = await query(
    `INSERT INTO chuyen_san_xuat (ma_chuyen, ten_chuyen, loai_chuyen_id, dinh_muc_gio, so_pass, created_by${themTo ? ', to_in_id' : ''})
     VALUES ($1,$2,$3,$4,$5,$6${themTo ? ',$7' : ''}) RETURNING id`,
    [d.maChuyen, d.tenChuyen, d.loaiChuyenId || null, d.dinhMucGio ?? null, d.soPass ?? 1, actor,
      ...(themTo ? [d.toInId || null] : [])]
  );
  return rows[0].id;
}

async function updateChuyen(id, d, actor) {
  kiemToIn(d);
  const themTo = d.toInId !== undefined && (await chuyenCoCotTo());
  await query(
    `UPDATE chuyen_san_xuat SET ten_chuyen = COALESCE($2, ten_chuyen), loai_chuyen_id = $3, dinh_muc_gio = $4,
       so_pass = COALESCE($6, so_pass)${themTo ? ', to_in_id = $7' : ''}, updated_by = $5, updated_date = CURRENT_TIMESTAMP WHERE id = $1`,
    [id, d.tenChuyen ?? null, d.loaiChuyenId || null, d.dinhMucGio ?? null, actor, d.soPass ?? null,
      ...(themTo ? [d.toInId || null] : [])]
  );
}

async function setChuyenActive(id, active, actor) {
  await query('UPDATE chuyen_san_xuat SET dang_hoat_dong = $2, updated_by = $3, updated_date = CURRENT_TIMESTAMP WHERE id = $1',
    [id, active, actor]);
}

async function listLoai() {
  const { rows } = await query(
    'SELECT id, ma_loai, ten_loai, dang_hoat_dong FROM loai_chuyen ORDER BY ten_loai'
  );
  return rows;
}

async function createLoai(d, actor) {
  const { rows } = await query(
    'INSERT INTO loai_chuyen (ma_loai, ten_loai, ghi_chu, created_by) VALUES ($1,$2,$3,$4) RETURNING id',
    [d.maLoai, d.tenLoai, d.ghiChu || null, actor]
  );
  return rows[0].id;
}

// Danh sách tổ để chọn ở ô "Tổ" của chuyền (mig 117) — danh mục tổ in (đồng bộ tổ phòng CSX), chỉ tổ đang bật.
async function listToChon() {
  const { rows } = await query('SELECT id, ma_to, ten_to FROM to_in WHERE dang_hoat_dong ORDER BY ma_to');
  return rows;
}

module.exports = {
  listChuyen, createChuyen, updateChuyen, setChuyenActive, listLoai, createLoai, chuyenCoCotTo, listToChon,
};
