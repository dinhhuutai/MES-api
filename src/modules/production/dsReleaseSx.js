'use strict';

// ─── DANH SÁCH RELEASE CỦA SẢN XUẤT (26/10/2026, người dùng gửi mẫu "DANH SÁCH RELEASE BÀN 10/26/2026") ───────────
// Nút ở màn *Sản xuất › Xác nhận chạy*. Tập dòng = CHÍNH Danh sách release của Kế hoạch theo ngày SX kế hoạch
//   (`planning.service.releaseList` — 1 dòng / lệnh × phần in), bỏ lệnh trên chuyền GIA CÔNG (không in ở xưởng) và lệnh
//   CHƯA xác nhận chạy (chưa có phiếu sản xuất — người dùng chốt 26/10/2026); thêm
//   các số của mẫu xưởng:
//   · SL ĐÃ IN   = Σ tem (gốc, sống) của phần in ở các lệnh KHÁC (lệnh sống) — "đã in trước" lệnh này.
//   · SL ĐÃ GIAO = Σ `sl_da_giao` mọi tem của phần in.
//   · SL IN      = Σ tem (gốc, sống) của CHÍNH lệnh (lệnh gom set cũ: ghi ở dòng phần in đầu — như Danh sách release).
//   · Vải hư / Vải thiếu = sổ `vai_huy` của lệnh (loai HUY / THIEU); có `phan_in_id` thì đúng phần in đó.
//   · DM + TEST · Ghi chú = NHẬP TAY, lưu theo (lệnh × phần in) — nơi lưu `audit_log` `ten_bang='ds_release_sx'`,
//     `id_ban_ghi` = `<lenh_id>|<phan_in_id>`, `hanh_dong='GHI_DS_RELEASE_SX'`, dòng mới nhất là giá trị (không migration,
//     cùng khuôn "nhớ đầu ca" / "vải chờ tem").
//   Tổng = SL IN + vải hư + vải thiếu + DM+TEST · CL = Tổng − SL release (FE tính, cả Excel).
// CHUYỀN THÊM VÀO KHU: mỗi NGƯỜI lưu riêng danh sách mã chuyền thêm cho từng chip khu (vd khu Máy thêm Bàn 10A) —
//   `audit_log` `ten_bang='ds_release_sx_chuyen'`, `id_ban_ghi` = `<user_id>|<khu>`, dòng mới nhất là giá trị.

const { query, withTransaction } = require('../../config/db');
const planningService = require('../planning/planning.service');

const KHOA_DONG = 'ds_release_sx';
const KHOA_CHUYEN = 'ds_release_sx_chuyen';

async function dsReleaseSx(ngay) {
  const { items } = await planningService.releaseList(ngay, 'KE_HOACH');
  // ⚠ 26/10/2026 (người dùng: "chỉ lấy những phần đã xác nhận chạy"): giữ lệnh ĐÃ CÓ phiếu Xác nhận chạy (phiếu ≠ HUY —
  //   đang chạy hoặc đã chạy hoàn tất; bỏ phiếu script hệ thống `PHIEU_THAT`, cùng luật Báo cáo sản xuất).
  const { PHIEU_THAT } = require('./baoCaoSanXuat');
  const ungVien = items.filter((r) => String(r.ma_loai_chuyen || '').toUpperCase() !== 'GIA_CONG');
  if (!ungVien.length) return { ngay, items: [] };
  const { rows: daChay } = await query(
    `SELECT DISTINCT ps.lenh_san_xuat_id AS id FROM phieu_san_xuat ps
      WHERE ps.lenh_san_xuat_id = ANY($1::uuid[]) AND ps.trang_thai <> 'HUY' AND ${PHIEU_THAT}`.replace(/\s+/g, ' '),
    [[...new Set(ungVien.map((r) => r.lenh_id))]]
  );
  const setChay = new Set(daChay.map((x) => x.id));
  const rows = ungVien.filter((r) => setChay.has(r.lenh_id));
  if (!rows.length) return { ngay, items: [] };
  const lenhIds = [...new Set(rows.map((r) => r.lenh_id))];
  const pinIds = [...new Set(rows.map((r) => r.phan_in_id))];
  const khoa = rows.map((r) => `${r.lenh_id}|${r.phan_in_id}`);
  // TRẠNG THÁI của CHÍNH LỆNH (26/10/2026 — người dùng: "M4 đã xác nhận chạy sao lại Release 1"): `releaseList` trả
  //   giai đoạn CHẬM NHẤT của cả PHẦN IN — phần in còn 1 đợt chưa release thì lệnh đang chạy cũng ghi "Release 1". Ở đây
  //   tính lại bằng CHÍNH `dotStageCase` trên các đợt của ĐÚNG lệnh × phần in (lấy giai đoạn chậm nhất trong các đợt đó).
  const { dotStageCase, ORDER_SQL_ARRAY, STAGE_LABEL } = require('../../utils/stage');
  const [inTruoc, inLenh, vai, ghi, ttLenh] = await Promise.all([
    // Theo cặp (lệnh × phần in): đã in ở lệnh KHÁC + đã giao của phần in.
    query(
      `WITH p AS (SELECT DISTINCT dv.phan_in_id, ls.id AS lenh_id
                    FROM lenh_san_xuat ls JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
                    JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
                   WHERE ls.trang_thai <> 'HUY' AND dv.phan_in_id = ANY($1::uuid[])),
            t AS (SELECT p.phan_in_id, p.lenh_id, COALESCE(SUM(tm.so_luong) FILTER (WHERE tm.tem_goc_id IS NULL), 0) AS da_in,
                         COALESCE(SUM(tm.sl_da_giao), 0) AS da_giao
                    FROM p JOIN phieu_san_xuat ps ON ps.lenh_san_xuat_id = p.lenh_id
                    JOIN tem tm ON tm.phieu_san_xuat_id = ps.id AND tm.trang_thai <> 'HUY'
                   GROUP BY p.phan_in_id, p.lenh_id)
       SELECT phan_in_id, lenh_id, da_in::int, da_giao::int FROM t`.replace(/\s+/g, ' '),
      [pinIds]
    ),
    query(
      `SELECT ps.lenh_san_xuat_id AS lenh_id, COALESCE(SUM(tm.so_luong), 0)::int AS sl_in
         FROM phieu_san_xuat ps JOIN tem tm ON tm.phieu_san_xuat_id = ps.id AND tm.trang_thai <> 'HUY' AND tm.tem_goc_id IS NULL
        WHERE ps.lenh_san_xuat_id = ANY($1::uuid[]) GROUP BY 1`.replace(/\s+/g, ' '),
      [lenhIds]
    ),
    query(
      `SELECT COALESCE(vh.lenh_san_xuat_id, ps.lenh_san_xuat_id) AS lenh_id, vh.phan_in_id,
              COALESCE(SUM(vh.so_luong) FILTER (WHERE COALESCE(vh.loai, 'HUY') = 'HUY'), 0)::int AS hu,
              COALESCE(SUM(vh.so_luong) FILTER (WHERE vh.loai = 'THIEU'), 0)::int AS thieu
         FROM vai_huy vh LEFT JOIN phieu_san_xuat ps ON ps.id = vh.phieu_san_xuat_id
        WHERE COALESCE(vh.lenh_san_xuat_id, ps.lenh_san_xuat_id) = ANY($1::uuid[]) GROUP BY 1, 2`.replace(/\s+/g, ' '),
      [lenhIds]
    ),
    query(
      `SELECT DISTINCT ON (a.id_ban_ghi) a.id_ban_ghi, a.gia_tri_moi
         FROM audit_log a WHERE a.ten_bang = $1 AND a.id_ban_ghi = ANY($2::text[])
        ORDER BY a.id_ban_ghi, a.thoi_gian DESC, a.id DESC`.replace(/\s+/g, ' '),
      [KHOA_DONG, khoa]
    ),
    query(
      `SELECT DISTINCT ON (z.lenh_id, z.phan_in_id) z.lenh_id, z.phan_in_id, z.stage
         FROM (SELECT s.lenh_id, s.phan_in_id, (${dotStageCase('s')}) AS stage
                 FROM (SELECT dv.id, dv.phan_in_id, dv.tg_chuyen_ready, dv.created_date, ls.id AS lenh_id, ls.trang_thai AS lenh_tt
                         FROM lenh_san_xuat ls JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
                         JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
                        WHERE ls.id = ANY($1::uuid[])) s) z
        ORDER BY z.lenh_id, z.phan_in_id, array_position(${ORDER_SQL_ARRAY}, z.stage)`.replace(/\s+/g, ' '),
      [lenhIds]
    ),
  ]);
  const ttMap = new Map(ttLenh.rows.map((x) => [`${x.lenh_id}|${x.phan_in_id}`, x.stage]));
  // Đã in / đã giao của phần in: cộng mọi lệnh; "đã in trước" = trừ lệnh của dòng.
  const theoPin = new Map();
  inTruoc.rows.forEach((x) => {
    const o = theoPin.get(x.phan_in_id) || { in: 0, giao: 0, lenh: new Map() };
    o.in += x.da_in; o.giao += x.da_giao; o.lenh.set(x.lenh_id, x.da_in);
    theoPin.set(x.phan_in_id, o);
  });
  const slInLenh = new Map(inLenh.rows.map((x) => [x.lenh_id, x.sl_in]));
  const ghiMap = new Map(ghi.rows.map((x) => [x.id_ban_ghi, x.gia_tri_moi || {}]));
  const daGhiSlLenh = new Set();
  const out = rows.map((r) => {
    const p = theoPin.get(r.phan_in_id) || { in: 0, giao: 0, lenh: new Map() };
    // Vải: dòng gắn đúng phần in thì lấy dòng đó; dòng không ghi phần in (sổ cũ) tính cho dòng đầu của lệnh.
    const vaiPin = vai.rows.filter((v) => v.lenh_id === r.lenh_id && v.phan_in_id === r.phan_in_id);
    const vaiChung = daGhiSlLenh.has(r.lenh_id) ? [] : vai.rows.filter((v) => v.lenh_id === r.lenh_id && !v.phan_in_id);
    const dau = !daGhiSlLenh.has(r.lenh_id);
    daGhiSlLenh.add(r.lenh_id);
    const g = ghiMap.get(`${r.lenh_id}|${r.phan_in_id}`) || {};
    const stage = ttMap.get(`${r.lenh_id}|${r.phan_in_id}`);
    return {
      ...r,
      // Trạng thái của LỆNH (thay giai đoạn của cả phần in); giữ bản phần in ở `giai_doan_phan_in`.
      giai_doan_phan_in: r.giai_doan_ten,
      giai_doan_ten: stage ? (STAGE_LABEL[stage] || stage) : r.giai_doan_ten,
      sl_da_in_truoc: Math.max(0, p.in - (p.lenh.get(r.lenh_id) || 0)),
      sl_da_giao_pin: p.giao,
      sl_in: dau ? (slInLenh.get(r.lenh_id) || 0) : null,
      vai_hu: [...vaiPin, ...vaiChung].reduce((a, v) => a + v.hu, 0),
      vai_thieu: [...vaiPin, ...vaiChung].reduce((a, v) => a + v.thieu, 0),
      dm_test: g.dm_test ?? null,
      ghi_chu_sx: g.ghi_chu ?? null,
    };
  });
  return { ngay, items: out };
}

// Lưu DM+TEST / ghi chú của 1 dòng (lệnh × phần in). Chỉ trường có trong `d` bị đổi (giữ trường kia từ bản cũ).
// ⚠ KHÓA theo dòng (`pg_advisory_xact_lock`) rồi mới đọc–ghi: gõ DM+TEST rồi Tab sang Ghi chú bắn 2 lượt lưu gần như
//   cùng lúc — không khóa thì lượt sau đọc bản CŨ và ghi đè mất DM+TEST (bấm thử 26/10/2026 gặp đúng ca này).
async function luuDong({ lenhId, phanInId, dmTest, ghiChu }, actorId) {
  const k = `${lenhId}|${phanInId}`;
  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${KHOA_DONG}|${k}`]);
    const { rows } = await client.query(
      'SELECT gia_tri_moi FROM audit_log WHERE ten_bang = $1 AND id_ban_ghi = $2 ORDER BY thoi_gian DESC, id DESC LIMIT 1',
      [KHOA_DONG, k]
    );
    const cu = (rows[0] && rows[0].gia_tri_moi) || {};
    const moi = {
      dm_test: dmTest === undefined ? (cu.dm_test ?? null) : dmTest,
      ghi_chu: ghiChu === undefined ? (cu.ghi_chu ?? null) : ghiChu,
    };
    if (moi.dm_test === (cu.dm_test ?? null) && moi.ghi_chu === (cu.ghi_chu ?? null)) return moi;
    await client.query(
      `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_cu, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
       VALUES ($1, $2, 'GHI_DS_RELEASE_SX', $3::jsonb, $4::jsonb, $5, clock_timestamp(), $5)`.replace(/\s+/g, ' '),
      [KHOA_DONG, k, JSON.stringify(cu), JSON.stringify(moi), actorId]
    );
    return moi;
  });
}

async function docChuyenThem(userId, khu) {
  const { rows } = await query(
    'SELECT gia_tri_moi FROM audit_log WHERE ten_bang = $1 AND id_ban_ghi = $2 ORDER BY thoi_gian DESC, id DESC LIMIT 1',
    [KHOA_CHUYEN, `${userId}|${khu || ''}`]
  );
  return (rows[0] && Array.isArray(rows[0].gia_tri_moi?.ma_chuyen)) ? rows[0].gia_tri_moi.ma_chuyen : [];
}

async function luuChuyenThem(userId, khu, maChuyen) {
  const ds = [...new Set((maChuyen || []).map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 100);
  await query(
    `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ($1, $2, 'LUU_CHUYEN_DS_RELEASE_SX', $3::jsonb, $4, CURRENT_TIMESTAMP, $4)`.replace(/\s+/g, ' '),
    [KHOA_CHUYEN, `${userId}|${khu || ''}`, JSON.stringify({ ma_chuyen: ds }), userId]
  );
  return ds;
}

module.exports = { dsReleaseSx, luuDong, docChuyenThem, luuChuyenThem };
