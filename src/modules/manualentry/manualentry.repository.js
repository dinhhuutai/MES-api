'use strict';

const { query } = require('../../config/db');
const AppError = require('../../utils/AppError');

// ─── Tra cứu để chọn "có sẵn" ────────────────────────────────────────────────
async function searchKhach(q, limit = 30) {
  const { rows } = await query(
    `SELECT id, ma_khach_hang, ten_khach_hang FROM khach_hang
     WHERE dang_hoat_dong AND ($1='' OR ma_khach_hang ILIKE '%'||$1||'%' OR ten_khach_hang ILIKE '%'||$1||'%')
     ORDER BY ten_khach_hang LIMIT $2`,
    [q || '', limit]
  );
  return rows;
}

async function searchDon(khachId, q, limit = 30) {
  const { rows } = await query(
    `SELECT id, ma_don_hang, so_po, ten_don_hang FROM don_hang
     WHERE ($1::uuid IS NULL OR khach_hang_id = $1)
       AND ($2='' OR ma_don_hang ILIKE '%'||$2||'%' OR COALESCE(so_po,'') ILIKE '%'||$2||'%' OR COALESCE(ten_don_hang,'') ILIKE '%'||$2||'%')
     ORDER BY created_date DESC LIMIT $3`,
    [khachId || null, q || '', limit]
  );
  return rows;
}

async function searchMaHang(donId, q, limit = 30) {
  const { rows } = await query(
    `SELECT id, ma_hang, ten_ma_hang FROM ma_hang
     WHERE ($1::uuid IS NULL OR don_hang_id = $1)
       AND ($2='' OR ma_hang ILIKE '%'||$2||'%' OR COALESCE(ten_ma_hang,'') ILIKE '%'||$2||'%')
     ORDER BY created_date DESC LIMIT $3`,
    [donId || null, q || '', limit]
  );
  return rows;
}

async function listLoaiDotVai() {
  const { rows } = await query(
    "SELECT id, ma_loai, ten_loai FROM loai_dot_vai WHERE dang_hoat_dong ORDER BY ten_loai"
  );
  return rows;
}

// ─── Tạo chuỗi khách → đơn → mã hàng → phần in → đợt vải (transaction) ────────
// Sinh mã tự động khi để trống (đảm bảo UNIQUE). Đợt vải đặt trang_thai='NHAN_VAI'
// để vào dòng chảy như ERP; trigger mig 054 tự quyết READY/Kế hoạch khi INSERT.
const rand = () => Math.random().toString(36).slice(2, 6).toUpperCase();
const genCode = (prefix) => `${prefix}-${Date.now().toString(36).toUpperCase()}${rand()}`;

async function createChainTx(client, p, actorId) {
  let phanInId = p.phanIn?.id || null;
  let maPhan = null;

  if (!phanInId) {
    // 1) Khách hàng
    let khachId = p.khach?.id || null;
    if (!khachId) {
      const ma = (p.khach?.ma_khach_hang || '').trim() || genCode('KH');
      const r = await client.query(
        'INSERT INTO khach_hang (ma_khach_hang, ten_khach_hang, ghi_chu, created_by) VALUES ($1,$2,$3,$4) RETURNING id',
        [ma, (p.khach.ten_khach_hang || '').trim(), p.khach.ghi_chu || null, actorId]
      );
      khachId = r.rows[0].id;
    }
    // 2) Đơn hàng
    let donId = p.don?.id || null;
    if (!donId) {
      const ma = (p.don?.ma_don_hang || '').trim() || genCode('DH');
      const r = await client.query(
        `INSERT INTO don_hang (khach_hang_id, ma_don_hang, so_po, ten_don_hang, ngay_dat_hang, ghi_chu, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [khachId, ma, p.don?.so_po || null, p.don?.ten_don_hang || null, p.don?.ngay_dat_hang || null, p.don?.ghi_chu || null, actorId]
      );
      donId = r.rows[0].id;
    }
    // 3) Mã hàng
    let maHangId = p.maHang?.id || null;
    if (!maHangId) {
      const ma = (p.maHang?.ma_hang || '').trim() || genCode('MH');
      const r = await client.query(
        'INSERT INTO ma_hang (don_hang_id, ma_hang, ten_ma_hang, ghi_chu, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [donId, ma, p.maHang?.ten_ma_hang || null, p.maHang?.ghi_chu || null, actorId]
      );
      maHangId = r.rows[0].id;
    }
    // 4) Phần in (luôn tạo mới)
    const ma = (p.phanIn?.ma_phan || '').trim() || genCode('PIN');
    const r = await client.query(
      `INSERT INTO phan_in (ma_hang_id, ma_phan, mau_vai, kich_vai, kich_phim, tinh_chat_in, do_in, mau_in,
         so_luong_don_hang, la_in_kieng, thoi_gian_cho_kho_phut, ghi_chu, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, ma_phan`,
      [maHangId, ma, p.phanIn?.mau_vai || null, p.phanIn?.kich_vai || null, p.phanIn?.kich_phim || null,
        p.phanIn?.tinh_chat_in || null, p.phanIn?.do_in || null, p.phanIn?.mau_in || null,
        p.phanIn?.so_luong_don_hang ?? null, !!p.phanIn?.la_in_kieng, p.phanIn?.thoi_gian_cho_kho_phut ?? null,
        p.phanIn?.ghi_chu || null, actorId]
    );
    phanInId = r.rows[0].id;
    maPhan = r.rows[0].ma_phan;
  } else {
    const r = await client.query('SELECT ma_phan FROM phan_in WHERE id=$1 AND dang_hoat_dong', [phanInId]);
    if (!r.rows.length) throw new AppError('Phần in không tồn tại hoặc đã bị hủy', { status: 404, errorCode: 'NOT_FOUND' });
    maPhan = r.rows[0].ma_phan;
  }

  // 5) Đợt vải
  const dots = [];
  for (const d of p.dotVai) {
    const ma = (d.ma_dot_vai || '').trim() || genCode('MAN');
    const r = await client.query(
      `INSERT INTO dot_vai_ve (phan_in_id, ma_dot_vai, so_luong_vai_ve, ngay_vai_ve, han_giao_hang, loai_dot_vai_id, ghi_chu, trang_thai, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'NHAN_VAI',$8) RETURNING id, ma_dot_vai, so_luong_vai_ve`,
      [phanInId, ma, d.so_luong_vai_ve ?? 0, d.ngay_vai_ve || null, d.han_giao_hang || null, d.loai_dot_vai_id || null, d.ghi_chu || null, actorId]
    );
    dots.push(r.rows[0]);
  }

  return { phan_in_id: phanInId, ma_phan: maPhan, dot_vai: dots };
}

module.exports = { searchKhach, searchDon, searchMaHang, listLoaiDotVai, createChainTx };
