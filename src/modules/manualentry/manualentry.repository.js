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

async function searchPhanIn(maHangId, q, limit = 30) {
  const { rows } = await query(
    `SELECT id, ma_phan, mau_vai, kich_vai, kich_phim FROM phan_in
     WHERE dang_hoat_dong AND ($1::uuid IS NULL OR ma_hang_id = $1)
       AND ($2='' OR ma_phan ILIKE '%'||$2||'%' OR COALESCE(mau_vai,'') ILIKE '%'||$2||'%'
            OR COALESCE(kich_vai,'') ILIKE '%'||$2||'%' OR COALESCE(kich_phim,'') ILIKE '%'||$2||'%')
     ORDER BY created_date DESC LIMIT $3`,
    [maHangId || null, q || '', limit]
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

// ─── Cập nhật SL nhận vải / SL release (sửa số liệu) ─────────────────────────
// Tìm đợt vải để cập nhật SL — kèm SL đã release + danh sách lệnh release (nếu có).
async function searchVaiVe(q, limit = 40) {
  const lim = Math.max(1, Math.min(Number(limit) || 40, 100));
  const { rows } = await query(
    `SELECT dv.id, dv.ma_dot_vai, dv.so_luong_vai_ve, dv.ngay_vai_ve, dv.han_giao_hang, dv.trang_thai,
            pin.id AS phan_in_id, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim,
            mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang,
            COALESCE((SELECT SUM(COALESCE(lsd.so_luong,0)) FROM lenh_sx_dot_vai lsd JOIN lenh_san_xuat ls ON ls.id=lsd.lenh_san_xuat_id
               WHERE lsd.dot_vai_ve_id=dv.id AND ls.trang_thai<>'HUY'),0)::int AS da_release
     FROM dot_vai_ve dv
     JOIN phan_in pin ON pin.id = dv.phan_in_id AND pin.dang_hoat_dong
     JOIN ma_hang mh ON mh.id = pin.ma_hang_id
     JOIN don_hang dh ON dh.id = mh.don_hang_id
     JOIN khach_hang kh ON kh.id = dh.khach_hang_id
     WHERE dv.trang_thai NOT IN ('DA_GOP','DA_HUY')
       AND ($1='' OR pin.ma_phan ILIKE '%'||$1||'%' OR dv.ma_dot_vai ILIKE '%'||$1||'%' OR mh.ma_hang ILIKE '%'||$1||'%'
            OR dh.ma_don_hang ILIKE '%'||$1||'%' OR COALESCE(pin.mau_vai,'') ILIKE '%'||$1||'%')
     ORDER BY dv.created_date DESC LIMIT ${lim}`.replace(/\s+/g, ' '),
    [q || '']
  );
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const { rows: rels } = await query(
    `SELECT lsd.dot_vai_ve_id, ls.id AS lenh_san_xuat_id, ls.ma_lenh_san_xuat, ls.trang_thai,
            lsd.so_luong, ls.so_luong_release
     FROM lenh_sx_dot_vai lsd JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id
     WHERE lsd.dot_vai_ve_id = ANY($1::uuid[]) AND ls.trang_thai <> 'HUY'
     ORDER BY ls.created_date`.replace(/\s+/g, ' '),
    [ids]
  );
  const byDot = {};
  rels.forEach((r) => { (byDot[r.dot_vai_ve_id] = byDot[r.dot_vai_ve_id] || []).push(r); });
  return rows.map((r) => ({
    ...r,
    con_release: Math.max(0, (r.so_luong_vai_ve || 0) - r.da_release),
    releases: byDot[r.id] || [],
  }));
}

async function auditLog(client, tenBang, id, hanhDong, cu, moi, actorId) {
  await client.query(
    `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_cu, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,CURRENT_TIMESTAMP,$6)`,
    [tenBang, String(id), hanhDong, JSON.stringify(cu), JSON.stringify(moi), actorId]
  );
}

// Cập nhật SL nhận vải của 1 đợt vải.
async function updateVaiVeTx(client, id, val, actorId) {
  const cur = (await client.query(
    "SELECT so_luong_vai_ve FROM dot_vai_ve WHERE id=$1 AND trang_thai NOT IN ('DA_GOP','DA_HUY')", [id]
  )).rows[0];
  if (!cur) throw new AppError('Đợt vải không tồn tại hoặc đã hủy/gộp', { status: 404, errorCode: 'NOT_FOUND' });
  await client.query('UPDATE dot_vai_ve SET so_luong_vai_ve=$1, updated_date=now(), updated_by=$2 WHERE id=$3', [val, actorId, id]);
  await auditLog(client, 'dot_vai_ve', id, 'UPDATE_SL_VAI_VE',
    { so_luong_vai_ve: cur.so_luong_vai_ve }, { so_luong_vai_ve: val }, actorId);
}

// Cập nhật SL release của 1 (lệnh, đợt vải): sửa lenh_sx_dot_vai.so_luong + tính lại lenh_san_xuat.so_luong_release=Σ.
async function updateReleaseTx(client, lenhId, dotId, val, actorId) {
  const link = (await client.query(
    `SELECT lsd.so_luong, ls.trang_thai, ls.so_luong_release, ls.ma_lenh_san_xuat
     FROM lenh_sx_dot_vai lsd JOIN lenh_san_xuat ls ON ls.id=lsd.lenh_san_xuat_id
     WHERE lsd.lenh_san_xuat_id=$1 AND lsd.dot_vai_ve_id=$2`.replace(/\s+/g, ' '), [lenhId, dotId]
  )).rows[0];
  if (!link) throw new AppError('Không tìm thấy lệnh release của đợt vải này', { status: 404, errorCode: 'NOT_FOUND' });
  if (link.trang_thai === 'HUY') throw new AppError('Lệnh đã hủy', { status: 409, errorCode: 'WRONG_STAGE' });
  const printed = (await client.query(
    "SELECT COALESCE(SUM(t.so_luong),0)::int AS v FROM phieu_san_xuat ps JOIN tem t ON t.phieu_san_xuat_id=ps.id WHERE ps.lenh_san_xuat_id=$1 AND t.trang_thai<>'HUY'",
    [lenhId]
  )).rows[0].v;
  const others = (await client.query(
    'SELECT COALESCE(SUM(so_luong),0)::int AS v FROM lenh_sx_dot_vai WHERE lenh_san_xuat_id=$1 AND dot_vai_ve_id<>$2', [lenhId, dotId]
  )).rows[0].v;
  const newRelease = others + val;
  if (newRelease < printed) {
    throw new AppError(`SL release mới (${newRelease}) nhỏ hơn SL đã in (${printed}) của lệnh ${link.ma_lenh_san_xuat} — không cho giảm dưới mức đã in`,
      { status: 409, errorCode: 'BELOW_PRINTED' });
  }
  await client.query('UPDATE lenh_sx_dot_vai SET so_luong=$1, updated_date=now(), updated_by=$2 WHERE lenh_san_xuat_id=$3 AND dot_vai_ve_id=$4',
    [val, actorId, lenhId, dotId]);
  await client.query('UPDATE lenh_san_xuat SET so_luong_release=$1, updated_date=now(), updated_by=$2 WHERE id=$3', [newRelease, actorId, lenhId]);
  await auditLog(client, 'lenh_san_xuat', lenhId, 'UPDATE_SL_RELEASE',
    { so_luong_release: link.so_luong_release, dot_vai_ve_id: dotId, lsd_so_luong: link.so_luong },
    { so_luong_release: newRelease, dot_vai_ve_id: dotId, lsd_so_luong: val }, actorId);
}

module.exports = {
  searchKhach, searchDon, searchMaHang, searchPhanIn, listLoaiDotVai, createChainTx,
  searchVaiVe, updateVaiVeTx, updateReleaseTx,
};
