'use strict';

const { query } = require('../../config/db');
const { lenhPhanInMatch } = require('../../utils/search');

const DON_SUB = (col, alias) => `(SELECT string_agg(DISTINCT ${col}, ', ')
    FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
    JOIN phan_in pin ON pin.id = dv.phan_in_id
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    WHERE lsd.lenh_san_xuat_id = ls.id) AS ${alias}`;

// Tem còn phần CHỜ GIAO (con_giao = sl_oqc_dat − sl_da_giao > 0) — cho giao TỪNG PHẦN nhiều lần.
// filters: { tem, khach, don, maHang, mauVai, kichVai, kichPhim }; ngayTu/ngayDen lọc KHOẢNG ngày in tem (VN).
async function listTemSanSang({ search = '', filters = {}, ngayTu = '', ngayDen = '' } = {}) {
  const f = filters || {};
  const params = [];
  const conds = ['(t.sl_oqc_dat - t.sl_da_giao) > 0'];
  if (search) {
    params.push(search); const i = params.length;
    conds.push(`(t.ma_tem ILIKE '%'||$${i}||'%' OR ls.ma_lenh_san_xuat ILIKE '%'||$${i}||'%' OR ${lenhPhanInMatch('ls.id', `$${i}`)})`);
  }
  const add = (val, col) => { if (!val) return; params.push(val); conds.push(`${col} ILIKE '%'||$${params.length}||'%'`); };
  add(f.tem, 't.ma_tem');
  add(f.khach, 'info.ten_khach_hang');
  add(f.don, 'info.ma_don_hang');
  add(f.maHang, 'info.ma_hang');
  add(f.mauVai, 'info.mau_vai');
  add(f.kichVai, 'info.kich_vai');
  add(f.kichPhim, 'info.kich_phim');
  if (ngayTu) { params.push(ngayTu); conds.push(`(t.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= $${params.length}::date`); }
  if (ngayDen) { params.push(ngayDen); conds.push(`(t.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date <= $${params.length}::date`); }
  const sql =
    `SELECT t.id AS tem_id, t.ma_tem, t.so_luong, t.created_date AS ngay_in_tem, (t.sl_oqc_dat - t.sl_da_giao) AS con_giao,
            t.sl_oqc_dat, t.sl_da_giao, ls.ma_lenh_san_xuat,
            (SELECT string_agg(DISTINCT pin.ma_phan, ', ')
               FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
               JOIN phan_in pin ON pin.id = dv.phan_in_id WHERE lsd.lenh_san_xuat_id = ls.id) AS phan_list,
            ${DON_SUB('dh.ma_don_hang', 'don_list')},
            ${DON_SUB('kh.ten_khach_hang', 'khach_list')},
            sla.tg_vao, sla.sla_phut, sla.canh_bao_truoc_phut,
            info.ma_hang, info.mau_vai, info.kich_vai, info.kich_phim
     FROM tem t
     JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
     JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
     LEFT JOIN LATERAL (
       SELECT mh.ma_hang, pin.mau_vai, pin.kich_vai, pin.kich_phim, kh.ten_khach_hang, dh.ma_don_hang
       FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
       JOIN phan_in pin ON pin.id = dv.phan_in_id JOIN ma_hang mh ON mh.id = pin.ma_hang_id
       JOIN don_hang dh ON dh.id = mh.don_hang_id JOIN khach_hang kh ON kh.id = dh.khach_hang_id
       WHERE lsd.lenh_san_xuat_id = ls.id ORDER BY pin.ma_phan, dv.ma_dot_vai LIMIT 1
     ) info ON true
     LEFT JOIN LATERAL (
       SELECT tt.tg_vao, tr.thoi_gian_quy_dinh_phut AS sla_phut, tr.canh_bao_truoc_phut
       FROM lenh_sx_dot_vai lsd JOIN ton_tram tt ON tt.dot_vai_ve_id = lsd.dot_vai_ve_id
       JOIN tram tr ON tr.id = tt.tram_id
       WHERE lsd.lenh_san_xuat_id = ls.id ORDER BY tt.tg_vao LIMIT 1
     ) sla ON true
     WHERE ${conds.join(' AND ')}
     ORDER BY t.created_date`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), params);
  return rows;
}

async function donHangIdsForTems(temIds) {
  const { rows } = await query(
    `SELECT DISTINCT dh.id
     FROM tem t
     JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
     JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
     JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
     JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
     JOIN phan_in pin ON pin.id = dv.phan_in_id
     JOIN ma_hang mh ON mh.id = pin.ma_hang_id
     JOIN don_hang dh ON dh.id = mh.don_hang_id
     WHERE t.id = ANY($1::uuid[])`,
    [temIds]
  );
  return rows.map((r) => r.id);
}

async function nextMaPhieuGiao() {
  const { rows } = await query(
    `SELECT 'PG' || LPAD((COALESCE(MAX(NULLIF(regexp_replace(ma_phieu_giao,'\\D','','g'),''))::int,0)+1)::text, 4, '0') AS ma
     FROM giao_hang`
  );
  return rows[0].ma;
}

async function createGiaoHang(client, { maPhieu, donHangId, ngayGiao, ghiChu }, actorId) {
  const { rows } = await client.query(
    `INSERT INTO giao_hang (ma_phieu_giao, don_hang_id, ngay_giao, trang_thai, ghi_chu, created_by)
     VALUES ($1,$2,$3,'TAO',$4,$5) RETURNING id`,
    [maPhieu, donHangId, ngayGiao || null, ghiChu || null, actorId]
  );
  return rows[0].id;
}

// Thêm tem vào phiếu giao với SL giao TỪNG PHẦN. soLuong không nhập → mặc định = con_giao còn lại.
async function addTem(client, giaoHangId, temId, soLuong, actorId) {
  await client.query(
    `INSERT INTO giao_hang_tem (giao_hang_id, tem_id, so_luong_giao, created_by)
     SELECT $1, $2, LEAST(COALESCE($4, (t.sl_oqc_dat - t.sl_da_giao)), (t.sl_oqc_dat - t.sl_da_giao)), $3
     FROM tem t WHERE t.id = $2
     ON CONFLICT (giao_hang_id, tem_id) DO UPDATE SET so_luong_giao = EXCLUDED.so_luong_giao`,
    [giaoHangId, temId, actorId, soLuong ?? null]
  );
}

async function getGiaoHang(giaoHangId) {
  const { rows } = await query(
    `SELECT gh.id, gh.ma_phieu_giao, gh.ngay_giao, gh.trang_thai, gh.ghi_chu, gh.created_date,
            dh.ma_don_hang, kh.ten_khach_hang,
            (SELECT count(*) FROM giao_hang_tem gt WHERE gt.giao_hang_id = gh.id)::int AS so_tem,
            (SELECT COALESCE(SUM(gt.so_luong_giao),0)::int FROM giao_hang_tem gt WHERE gt.giao_hang_id = gh.id) AS tong_sl
     FROM giao_hang gh
     LEFT JOIN don_hang dh ON dh.id = gh.don_hang_id
     LEFT JOIN khach_hang kh ON kh.id = dh.khach_hang_id
     WHERE gh.id = $1`,
    [giaoHangId]
  );
  return rows[0] || null;
}

async function listGiaoHang({ search = '' }) {
  const { rows } = await query(
    `SELECT gh.id, gh.ma_phieu_giao, gh.ngay_giao, gh.trang_thai, gh.created_date,
            dh.ma_don_hang, kh.ten_khach_hang,
            (SELECT count(*) FROM giao_hang_tem gt WHERE gt.giao_hang_id = gh.id)::int AS so_tem,
            (SELECT COALESCE(SUM(gt.so_luong_giao),0)::int FROM giao_hang_tem gt WHERE gt.giao_hang_id = gh.id) AS tong_sl
     FROM giao_hang gh
     LEFT JOIN don_hang dh ON dh.id = gh.don_hang_id
     LEFT JOIN khach_hang kh ON kh.id = dh.khach_hang_id
     WHERE ($1 = '' OR gh.ma_phieu_giao ILIKE '%'||$1||'%' OR kh.ten_khach_hang ILIKE '%'||$1||'%'
            OR EXISTS (SELECT 1 FROM giao_hang_tem gt_s
                       JOIN tem t_s ON t_s.id = gt_s.tem_id
                       JOIN phieu_san_xuat ps_s ON ps_s.id = t_s.phieu_san_xuat_id
                       WHERE gt_s.giao_hang_id = gh.id AND ${lenhPhanInMatch('ps_s.lenh_san_xuat_id', '$1')}))
     ORDER BY gh.created_date DESC`,
    [search]
  );
  return rows;
}

async function getGiaoHangTems(giaoHangId) {
  const { rows } = await query(
    `SELECT gt.id, gt.tem_id, gt.so_luong_giao, t.ma_tem, t.trang_thai, ls.ma_lenh_san_xuat
     FROM giao_hang_tem gt
     JOIN tem t ON t.id = gt.tem_id
     LEFT JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
     LEFT JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
     WHERE gt.giao_hang_id = $1
     ORDER BY t.ma_tem`,
    [giaoHangId]
  );
  return rows;
}

// Xác nhận giao: đóng phiếu. (Sổ cái sl_da_giao + recompute trạng thái tem xử lý ở service theo từng tem.)
async function markGiaoDone(client, giaoHangId, actorId) {
  await client.query(
    `UPDATE giao_hang SET trang_thai='DA_GIAO', ngay_giao=COALESCE(ngay_giao, CURRENT_DATE),
       updated_by=$2, updated_date=CURRENT_TIMESTAMP WHERE id=$1`,
    [giaoHangId, actorId]
  );
}

// Ghi audit_log khi xác nhận giao: ai giao, lúc nào, SL bao nhiêu (chi tiết từng tem).
async function insertGiaoAudit(giaoHangId, maPhieu, tems, actorId) {
  const tongSl = tems.reduce((s, t) => s + (Number(t.so_luong_giao) || 0), 0);
  const chiTiet = {
    ma_phieu_giao: maPhieu, so_tem: tems.length, tong_sl: tongSl,
    tems: tems.map((t) => ({ ma_tem: t.ma_tem, so_luong_giao: Number(t.so_luong_giao) || 0 })),
  };
  await query(
    `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ('giao_hang', $1, 'XAC_NHAN_GIAO', $2::jsonb, $3, CURRENT_TIMESTAMP, $3)`,
    [String(giaoHangId), JSON.stringify(chiTiet), actorId]
  );
}

// Cộng dồn đã giao cho tem + cập nhật trạng thái dominant (chỉ DA_GIAO khi đã giao đủ).
async function applyGiaoLedger(client, giaoHangId, actorId) {
  const { rows } = await client.query('SELECT tem_id, so_luong_giao FROM giao_hang_tem WHERE giao_hang_id=$1', [giaoHangId]);
  for (const r of rows) {
    await client.query(
      `UPDATE tem SET sl_da_giao = sl_da_giao + COALESCE($2,0), updated_by=$3, updated_date=CURRENT_TIMESTAMP WHERE id=$1`,
      [r.tem_id, r.so_luong_giao, actorId]
    );
    await client.query(
      `UPDATE tem SET trang_thai = CASE
          WHEN trang_thai IN ('IN','DANG_PHOI','HUY') THEN trang_thai
          WHEN ((so_luong+sl_chenh_lech)-(sl_kcs_dat+sl_kcs_sua+sl_kcs_huy)) > 0 THEN 'DA_KHO'
          WHEN (sl_kcs_sua-(sl_sua_dat+sl_sua_huy)) > 0 THEN 'CHO_SUA'
          WHEN ((sl_kcs_dat+sl_sua_dat)-sl_oqc_dat) > 0 THEN 'CHO_OQC'
          WHEN (sl_oqc_dat-sl_da_giao) > 0 THEN 'OQC_DAT'
          WHEN sl_da_giao > 0 THEN 'DA_GIAO'
          ELSE 'LOAI' END,
         updated_date=CURRENT_TIMESTAMP WHERE id=$1`,
      [r.tem_id]
    );
  }
  return rows.map((r) => r.tem_id);
}

module.exports = {
  listTemSanSang, donHangIdsForTems, nextMaPhieuGiao, createGiaoHang, addTem,
  getGiaoHang, listGiaoHang, getGiaoHangTems, markGiaoDone, applyGiaoLedger, insertGiaoAudit,
};
