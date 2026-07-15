'use strict';

const { query } = require('../../config/db');
const { chipCondition, dominantStageScalar } = require('../../utils/stage');

const BASE_JOINS = `
  FROM phan_in pin
  JOIN ma_hang mh ON mh.id = pin.ma_hang_id
  JOIN don_hang dh ON dh.id = mh.don_hang_id
  JOIN khach_hang kh ON kh.id = dh.khach_hang_id`;

function buildWhere(search, missingProfit) {
  let cond = `($1 = '' OR pin.ma_phan ILIKE '%'||$1||'%' OR kh.ten_khach_hang ILIKE '%'||$1||'%'
              OR dh.ma_don_hang ILIKE '%'||$1||'%' OR mh.ma_hang ILIKE '%'||$1||'%'
              OR pin.mau_vai ILIKE '%'||$1||'%' OR pin.kich_vai ILIKE '%'||$1||'%'
              OR pin.kich_phim ILIKE '%'||$1||'%')`;
  if (missingProfit) cond += ' AND pin.loi_nhuan IS NULL';
  return cond;
}

async function list({ search = '', missingProfit = false, offset = 0, limit = 20 }) {
  const where = `${buildWhere(search, missingProfit)} AND pin.dang_hoat_dong`; // ẩn phần in đã xóa mềm
  const dataSql = `
    SELECT pin.id, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim,
           pin.tinh_chat_in, pin.do_in, pin.mau_in, pin.so_luong_don_hang, pin.loi_nhuan,
           mh.ma_hang, mh.ten_ma_hang,
           dh.ma_don_hang, dh.so_po,
           kh.ma_khach_hang, kh.ten_khach_hang,
           COALESCE(SUM(dv.so_luong_vai_ve), 0)::int AS tong_vai_ve,
           MIN(dv.han_giao_hang) AS han_giao_hang,
           MAX(dv.ngay_vai_ve) AS ngay_vai_ve,
           COUNT(dv.id)::int AS so_dot_vai
    ${BASE_JOINS}
    LEFT JOIN dot_vai_ve dv ON dv.phan_in_id = pin.id AND dv.trang_thai <> 'DA_GOP'
    WHERE ${where}
    GROUP BY pin.id, mh.ma_hang, mh.ten_ma_hang, dh.ma_don_hang, dh.so_po, kh.ma_khach_hang, kh.ten_khach_hang
    ORDER BY pin.created_date DESC
    LIMIT $2 OFFSET $3`;
  const countSql = `SELECT count(*)::int AS total ${BASE_JOINS} WHERE ${where}`;

  const [data, count] = await Promise.all([
    query(dataSql, [search, limit, offset]),
    query(countSql, [search]),
  ]);
  return { rows: data.rows, total: count.rows[0].total };
}

// Điều kiện lọc theo GIAI ĐOẠN (chip) của phần in — DÙNG CHUNG với dashboard.stageCounts.
// "Mỗi phần in chỉ ở 1 trạm" = giai đoạn KÉM TIẾN ĐỘ NHẤT (dominant) trong các đợt vải của nó
// (utils/stage.js). Nhờ vậy: Σ(phần in mỗi chip) = tổng phần in, khớp dashboard + mọi danh sách.
function stageCondition(stage) {
  return chipCondition(stage, 'pin.id'); // null nếu stage rỗng/'ALL' → không lọc giai đoạn
}

// Danh sách "phần in vải về": GỘP theo phần in (mỗi dòng = 1 phần in), kèm mảng đợt vải về.
// Hỗ trợ: tìm nhanh (search), lọc nhiều trường cùng lúc (filters, AND), lọc theo giai đoạn (stage).
// Cột cho phép sắp xếp (whitelist) ở màn "Tất cả" — map key FE → biểu thức SQL.
const VAIVE_SORT = {
  khach: 'kh.ten_khach_hang', don: 'dh.ma_don_hang', maHang: 'mh.ma_hang',
  mauVai: 'pin.mau_vai', kichVai: 'pin.kich_vai', kichPhim: 'pin.kich_phim',
  slDon: 'pin.so_luong_don_hang', slVai: 'dvj.tong_vai',
  ngayVai: 'dvj.ngay_vai_min', hanGiao: 'dvj.han_min',
  slIn: 'ts.pcs_in', kiemDat: 'ts.sl_dat', sua: 'ts.sl_sua', suaDat: 'ts.sl_sua_dat',
};

async function listVaiVe({ search = '', filters = {}, stage = '', offset = 0, limit = 20, sortKey = '', sortDir = '' }) {
  const params = [];
  const add = (v) => { params.push(v); return `$${params.length}`; };
  const cond = [];

  if (search) {
    const p = add(search);
    cond.push(`(pin.ma_phan ILIKE '%'||${p}||'%' OR kh.ten_khach_hang ILIKE '%'||${p}||'%'
      OR dh.ma_don_hang ILIKE '%'||${p}||'%' OR mh.ma_hang ILIKE '%'||${p}||'%'
      OR pin.mau_vai ILIKE '%'||${p}||'%' OR pin.kich_vai ILIKE '%'||${p}||'%' OR pin.kich_phim ILIKE '%'||${p}||'%'
      OR EXISTS (SELECT 1 FROM dot_vai_ve dvs WHERE dvs.phan_in_id=pin.id AND dvs.ma_dot_vai ILIKE '%'||${p}||'%'))`);
  }
  // Lọc từng trường (AND với nhau).
  const FIELD = { khach: 'kh.ten_khach_hang', don: 'dh.ma_don_hang', maHang: 'mh.ma_hang',
    codePhan: 'pin.ma_phan', mauVai: 'pin.mau_vai', kichVai: 'pin.kich_vai', kichPhim: 'pin.kich_phim' };
  for (const [k, col] of Object.entries(FIELD)) {
    if (filters[k]) { const p = add(filters[k]); cond.push(`${col} ILIKE '%'||${p}||'%'`); }
  }
  // Lọc theo NGÀY VẢI VỀ (khoảng): phần in có ≥1 đợt vải với ngay_vai_ve trong khoảng.
  if (filters.ngayVaiTu || filters.ngayVaiDen) {
    const parts = ['dvd.phan_in_id = pin.id'];
    if (filters.ngayVaiTu) parts.push(`dvd.ngay_vai_ve >= ${add(filters.ngayVaiTu)}::date`);
    if (filters.ngayVaiDen) parts.push(`dvd.ngay_vai_ve <= ${add(filters.ngayVaiDen)}::date`);
    cond.push(`EXISTS (SELECT 1 FROM dot_vai_ve dvd WHERE ${parts.join(' AND ')})`);
  }
  const sc = stageCondition(stage);
  if (sc) cond.push(`(${sc})`);
  cond.push("dh.trang_thai IS DISTINCT FROM 'CLOSED_FINANCE'");
  cond.push('pin.dang_hoat_dong'); // ẩn phần in đã xóa mềm

  const limitP = add(limit); const offsetP = add(offset);
  // Sắp xếp động (whitelist cột + hướng) — mặc định theo khách/đơn/mã/phần.
  const DEFAULT_ORDER = 'kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang, pin.ma_phan';
  const orderBy = (sortKey && VAIVE_SORT[sortKey])
    ? `${VAIVE_SORT[sortKey]} ${sortDir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, ${DEFAULT_ORDER}`
    : DEFAULT_ORDER;
  // 1 query duy nhất: tổng số phần in qua COUNT(*) OVER(). Gửi SQL 1 dòng (IPS-safe).
  const sql = `
    SELECT pin.id AS phan_in_id, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim,
           pin.so_luong_don_hang, pin.loi_nhuan,
           mh.ma_hang, mh.ten_ma_hang, dh.ma_don_hang, dh.so_po,
           kh.ma_khach_hang, kh.ten_khach_hang,
           dvj.so_dot, dvj.dot_vai,
           ts.pcs_in, ts.so_tem, ts.sl_dat, ts.sl_sua, ts.sl_sua_dat, ts.tems,
           COUNT(*) OVER()::int AS total_count
    ${BASE_JOINS}
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS so_dot,
             COALESCE(SUM(dv.so_luong_vai_ve),0)::int AS tong_vai,
             min(dv.ngay_vai_ve) AS ngay_vai_min, min(dv.han_giao_hang) AS han_min,
             COALESCE(json_agg(json_build_object(
               'dot_vai_id', dv.id, 'ma_dot_vai', dv.ma_dot_vai, 'so_luong_vai_ve', dv.so_luong_vai_ve,
               'ngay_vai_ve', dv.ngay_vai_ve, 'han_giao_hang', dv.han_giao_hang
             ) ORDER BY dv.ngay_vai_ve NULLS LAST, dv.ma_dot_vai), '[]') AS dot_vai
      FROM dot_vai_ve dv WHERE dv.phan_in_id = pin.id AND dv.trang_thai <> 'DA_GOP'
    ) dvj ON true
    LEFT JOIN LATERAL (
      WITH tp AS (
        SELECT tm.id, tm.ma_tem, tm.so_luong, tm.trang_thai, tm.created_date,
               tm.sl_kcs_sua, tm.sl_kcs_dat, tm.sl_sua_dat, tm.sl_oqc_dat, tm.sl_oqc_dat_sua, tm.sl_da_giao
        FROM tem tm
        JOIN phieu_san_xuat ps ON ps.id=tm.phieu_san_xuat_id
        JOIN lenh_san_xuat ls ON ls.id=ps.lenh_san_xuat_id AND ls.trang_thai<>'HUY'
        JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id=ls.id
        JOIN dot_vai_ve dv2 ON dv2.id=lsd.dot_vai_ve_id AND dv2.phan_in_id=pin.id
      )
      SELECT
        COALESCE(SUM(so_luong) FILTER (WHERE trang_thai<>'HUY'),0)::int AS pcs_in,
        count(*) FILTER (WHERE trang_thai<>'HUY')::int AS so_tem,
        (SELECT COALESCE(SUM(so_luong_dat),0)::int FROM kcs k WHERE k.tem_id IN (SELECT id FROM tp)) AS sl_dat,
        (SELECT COALESCE(SUM(GREATEST(so_luong_loi-COALESCE(so_luong_huy,0),0)),0)::int FROM kcs k WHERE k.tem_id IN (SELECT id FROM tp)) AS sl_sua,
        (SELECT COALESCE(SUM(so_luong_sua_dat),0)::int FROM sua s WHERE s.tem_id IN (SELECT id FROM tp)) AS sl_sua_dat,
        COALESCE((
          SELECT json_agg(json_build_object(
            'tem_id', tp2.id, 'ma_tem', tp2.ma_tem, 'so_luong', tp2.so_luong, 'trang_thai', tp2.trang_thai,
            'kcs_dat', k.so_luong_dat, 'kcs_loi', k.so_luong_loi, 'sua_dat', s.so_luong_sua_dat, 'oqc_ket_qua', o.ket_qua,
            'sl_sua', tp2.sl_kcs_sua,
            'con_oqc_kcs', (tp2.sl_kcs_dat - (tp2.sl_oqc_dat - tp2.sl_oqc_dat_sua)),
            'con_oqc_sua', (tp2.sl_sua_dat - tp2.sl_oqc_dat_sua),
            'giao_kcs', (tp2.sl_oqc_dat - tp2.sl_oqc_dat_sua),
            'giao_sua', tp2.sl_oqc_dat_sua
          ) ORDER BY tp2.created_date, tp2.ma_tem)
          FROM tp tp2
          LEFT JOIN LATERAL (SELECT so_luong_dat, so_luong_loi FROM kcs WHERE tem_id=tp2.id ORDER BY created_date DESC LIMIT 1) k ON true
          LEFT JOIN LATERAL (SELECT so_luong_sua_dat FROM sua WHERE tem_id=tp2.id ORDER BY created_date DESC LIMIT 1) s ON true
          LEFT JOIN LATERAL (SELECT ket_qua FROM oqc WHERE tem_id=tp2.id ORDER BY created_date DESC LIMIT 1) o ON true
          WHERE tp2.trang_thai<>'HUY'
        ), '[]') AS tems
      FROM tp
    ) ts ON true
    WHERE ${cond.join(' AND ')}
    ORDER BY ${orderBy}
    LIMIT ${limitP} OFFSET ${offsetP}`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), params);
  const total = rows.length ? rows[0].total_count : 0;
  return { rows, total };
}

// Ledger theo TỪNG ĐỢT SẢN XUẤT (lệnh non-HUY) của các phần in trong 1 trang "Tất cả" — query RIÊNG (IPS-safe).
// 1 lệnh gom set nhiều phần in → xuất hiện dưới mỗi phần in (ledger ở mức lệnh, không tách — theo giới hạn đã ghi).
async function dotSanXuatLedger(phanInIds) {
  if (!phanInIds || phanInIds.length === 0) return {};
  const sql = `
    SELECT sub.phan_in_id::text AS phan_in_id, sub.lenh_id::text AS lenh_id, sub.ma_lenh_san_xuat, sub.giai_doan,
           sub.ma_dot_vai, sub.so_dot_vai, sub.dot_vai_list, sub.ngay_vai_ve, sub.han_giao_hang,
           COALESCE((SELECT SUM(tm.so_luong) FROM tem tm JOIN phieu_san_xuat ps ON ps.id=tm.phieu_san_xuat_id WHERE ps.lenh_san_xuat_id=sub.lenh_id AND tm.trang_thai<>'HUY'),0)::int AS sl_in,
           COALESCE((SELECT SUM(tm.sl_kcs_dat) FROM tem tm JOIN phieu_san_xuat ps ON ps.id=tm.phieu_san_xuat_id WHERE ps.lenh_san_xuat_id=sub.lenh_id AND tm.trang_thai<>'HUY'),0)::int AS sl_kcs_dat,
           COALESCE((SELECT SUM(tm.sl_kcs_sua) FROM tem tm JOIN phieu_san_xuat ps ON ps.id=tm.phieu_san_xuat_id WHERE ps.lenh_san_xuat_id=sub.lenh_id AND tm.trang_thai<>'HUY'),0)::int AS sl_sua,
           COALESCE((SELECT SUM(tm.sl_sua_dat) FROM tem tm JOIN phieu_san_xuat ps ON ps.id=tm.phieu_san_xuat_id WHERE ps.lenh_san_xuat_id=sub.lenh_id AND tm.trang_thai<>'HUY'),0)::int AS sl_sua_dat,
           COALESCE((SELECT SUM(tm.sl_kcs_huy) FROM tem tm JOIN phieu_san_xuat ps ON ps.id=tm.phieu_san_xuat_id WHERE ps.lenh_san_xuat_id=sub.lenh_id AND tm.trang_thai<>'HUY'),0)::int AS sl_kcs_huy,
           COALESCE((SELECT SUM(tm.sl_sua_huy) FROM tem tm JOIN phieu_san_xuat ps ON ps.id=tm.phieu_san_xuat_id WHERE ps.lenh_san_xuat_id=sub.lenh_id AND tm.trang_thai<>'HUY'),0)::int AS sl_sua_huy,
           (SELECT max(o.created_date) FROM oqc o JOIN tem tm ON tm.id=o.tem_id JOIN phieu_san_xuat ps ON ps.id=tm.phieu_san_xuat_id WHERE ps.lenh_san_xuat_id=sub.lenh_id) AS tg_oqc,
           (SELECT o.ket_qua FROM oqc o JOIN tem tm ON tm.id=o.tem_id JOIN phieu_san_xuat ps ON ps.id=tm.phieu_san_xuat_id WHERE ps.lenh_san_xuat_id=sub.lenh_id ORDER BY o.created_date DESC LIMIT 1) AS tt_oqc,
           COALESCE((SELECT SUM(tm.sl_da_giao) FROM tem tm JOIN phieu_san_xuat ps ON ps.id=tm.phieu_san_xuat_id WHERE ps.lenh_san_xuat_id=sub.lenh_id AND tm.trang_thai<>'HUY'),0)::int AS sl_giao
    FROM (
      SELECT dvx.phan_in_id, ls.id AS lenh_id, ls.ma_lenh_san_xuat, ls.giai_doan, ls.created_date,
             string_agg(DISTINCT dvx.ma_dot_vai, ', ') AS ma_dot_vai,
             count(DISTINCT dvx.id)::int AS so_dot_vai,
             json_agg(json_build_object('ma_dot_vai', dvx.ma_dot_vai, 'so_luong', lx.so_luong,
                      'so_luong_vai_ve', dvx.so_luong_vai_ve, 'ngay_vai_ve', dvx.ngay_vai_ve,
                      'han_giao_hang', dvx.han_giao_hang) ORDER BY dvx.ma_dot_vai) AS dot_vai_list,
             min(dvx.ngay_vai_ve) AS ngay_vai_ve, min(dvx.han_giao_hang) AS han_giao_hang
      FROM lenh_san_xuat ls
      JOIN lenh_sx_dot_vai lx ON lx.lenh_san_xuat_id = ls.id
      JOIN dot_vai_ve dvx ON dvx.id = lx.dot_vai_ve_id
      WHERE ls.trang_thai <> 'HUY' AND dvx.phan_in_id = ANY($1::uuid[])
      GROUP BY dvx.phan_in_id, ls.id, ls.ma_lenh_san_xuat, ls.giai_doan, ls.created_date
    ) sub
    ORDER BY sub.phan_in_id, sub.created_date`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [phanInIds]);
  const byPin = {};
  rows.forEach((r) => { (byPin[r.phan_in_id] = byPin[r.phan_in_id] || []).push(r); });
  return byPin;
}

async function findById(id) {
  const sql = `
    SELECT pin.id, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.tinh_chat_in,
           pin.do_in, pin.mau_in, pin.so_luong_don_hang, pin.loi_nhuan, pin.ghi_chu,
           mh.ma_hang, mh.ten_ma_hang,
           dh.ma_don_hang, dh.so_po, dh.ten_don_hang,
           kh.ma_khach_hang, kh.ten_khach_hang
    ${BASE_JOINS}
    WHERE pin.id = $1`;
  const { rows } = await query(sql, [id]);
  return rows[0] || null;
}

async function listDotVai(phanInId) {
  const sql = `
    SELECT dv.id, dv.ma_dot_vai, dv.ngay_vai_ve, dv.han_giao_hang, dv.so_luong_vai_ve,
           dv.so_luong_thieu, dv.so_luong_hu, dv.trang_thai, ldv.ten_loai AS loai_dot_vai
    FROM dot_vai_ve dv
    LEFT JOIN loai_dot_vai ldv ON ldv.id = dv.loai_dot_vai_id
    WHERE dv.phan_in_id = $1
    ORDER BY dv.ngay_vai_ve NULLS LAST, dv.ma_dot_vai`;
  const { rows } = await query(sql, [phanInId]);
  return rows;
}

// Hành trình phần in — THEO ĐỢT SẢN XUẤT (cấu trúc mới): mỗi đợt SX (lệnh ≠ HUY) là 1 hành trình riêng.
//  - READY (mức phần in) tách riêng vì DÙNG CHUNG cho mọi đợt SX (khuôn/film/mực dùng chung).
//  - Mỗi hành trình (journey): RELEASE_1 → RELEASE_2 → SẢN XUẤT → CHỜ KHÔ → KIỂM → SỬA → OQC → GIAO,
//    checklist mức lệnh (Test Run) + mốc thời gian suy từ phiếu/tem/kcs/sua/oqc/giao của CHÍNH lệnh đó.
// Trả về { ready: {ma_tram,ten_tram,thu_tu,checklists[]}|null, journeys: [{lenh_id,ma_lenh_san_xuat,giai_doan,dot_vai[],trams[]}] }.
async function getPhanInTimeline(phanInId) {
  const tramSql = `SELECT t.ma_tram, t.ten_tram, t.thu_tu
    FROM tram t JOIN workflow_version wv ON wv.id=t.workflow_version_id
    WHERE wv.la_hien_hanh=true ORDER BY t.thu_tu`;

  // READY (mức phần in) — checklist chung
  const readyCklSql = `
    SELECT cp.ma_checkpoint, cp.ten_checkpoint, cp.thu_tu AS cp_thu_tu,
           kq.gia_tri_text, kq.tg_xac_nhan AS tg, nd.ho_ten AS nguoi
    FROM ket_qua_checkpoint kq
    JOIN checkpoint cp ON cp.id = kq.checkpoint_id
    JOIN tram t ON t.id = cp.tram_id
    JOIN workflow_version wv ON wv.id = t.workflow_version_id AND wv.la_hien_hanh = true
    LEFT JOIN nguoi_dung nd ON nd.id = kq.nguoi_xac_nhan_id
    WHERE kq.trang_thai='DAT' AND kq.phan_in_id = $1 AND t.ma_tram = 'READY'
    ORDER BY cp.thu_tu, kq.tg_xac_nhan`;

  // LỊCH SỬ xác nhận READY (mọi lần DAT, kể cả các CHU KỲ đã bị mở lại) — để dựng READY RIÊNG cho từng đợt SX.
  const readyEventsSql = `
    SELECT cp.ma_checkpoint, cp.ten_checkpoint, cp.thu_tu AS cp_thu_tu, lst.tg_thuc_hien AS tg, nd.ho_ten AS nguoi
    FROM lich_su_trang_thai lst
    JOIN trang_thai tt ON tt.id = lst.trang_thai_moi_id AND tt.ma_trang_thai = 'DAT'
    JOIN ket_qua_checkpoint kq ON kq.id = lst.ket_qua_checkpoint_id AND kq.phan_in_id = $1
    JOIN checkpoint cp ON cp.id = kq.checkpoint_id
    JOIN tram t ON t.id = cp.tram_id
    JOIN workflow_version wv ON wv.id = t.workflow_version_id AND wv.la_hien_hanh = true
    LEFT JOIN nguoi_dung nd ON nd.id = lst.nguoi_thuc_hien_id
    WHERE t.ma_tram = 'READY'
    ORDER BY lst.tg_thuc_hien`;

  // Danh sách đợt SX (lệnh ≠ HUY) + đợt vải của mỗi lệnh
  const lenhSql = `
    SELECT ls.id, ls.ma_lenh_san_xuat, ls.giai_doan, ls.created_date,
           COALESCE(json_agg(json_build_object('ma_dot_vai', dv.ma_dot_vai, 'so_luong', lsd.so_luong, 'so_luong_vai_ve', dv.so_luong_vai_ve)
                    ORDER BY dv.ma_dot_vai), '[]') AS dot_vai
    FROM lenh_san_xuat ls
    JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
    JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
    WHERE dv.phan_in_id = $1 AND ls.trang_thai <> 'HUY'
    GROUP BY ls.id, ls.ma_lenh_san_xuat, ls.giai_doan, ls.created_date
    ORDER BY ls.created_date`;

  // Checklist mức lệnh (Test Run: TEST_CNSP/TEST_QA) theo từng lệnh
  const lenhCklSql = `
    SELECT kq.lenh_san_xuat_id AS lenh_id, t.ma_tram, cp.ma_checkpoint, cp.ten_checkpoint, cp.thu_tu AS cp_thu_tu,
           kq.gia_tri_text, kq.tg_xac_nhan AS tg, nd.ho_ten AS nguoi
    FROM ket_qua_checkpoint kq
    JOIN checkpoint cp ON cp.id = kq.checkpoint_id
    JOIN tram t ON t.id = cp.tram_id
    JOIN workflow_version wv ON wv.id = t.workflow_version_id AND wv.la_hien_hanh = true
    LEFT JOIN nguoi_dung nd ON nd.id = kq.nguoi_xac_nhan_id
    WHERE kq.trang_thai='DAT' AND kq.lenh_san_xuat_id IN (
      SELECT DISTINCT lsd.lenh_san_xuat_id FROM lenh_sx_dot_vai lsd
      JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
      JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id
      WHERE dv.phan_in_id = $1 AND ls.trang_thai <> 'HUY')
    ORDER BY t.thu_tu, cp.thu_tu, kq.tg_xac_nhan`;

  // Mốc thời gian per LỆNH per trạm (RELEASE_1..GIAO)
  const mocSql = `
    WITH l_pin AS (
      SELECT DISTINCT ls.id AS lenh_id, ls.created_date, ls.created_by
      FROM lenh_san_xuat ls
      JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
      JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
      WHERE dv.phan_in_id = $1 AND ls.trang_thai <> 'HUY'
    ),
    p_pin AS (
      SELECT DISTINCT l.lenh_id, ps.id AS phieu_id, ps.tg_bd, ps.created_by
      FROM l_pin l JOIN phieu_san_xuat ps ON ps.lenh_san_xuat_id = l.lenh_id
    ),
    t_pin AS (
      SELECT p.lenh_id, tm.id AS tem_id, tm.created_date, tm.created_by
      FROM p_pin p JOIN tem tm ON tm.phieu_san_xuat_id = p.phieu_id
    )
    SELECT lenh_id, ma_tram, min(tg) AS tg, (array_agg(nguoi ORDER BY tg NULLS LAST))[1] AS nguoi, count(*)::int AS so_luong
    FROM (
      SELECT l.lenh_id, 'RELEASE_1' AS ma_tram, l.created_date AS tg, nd.ho_ten AS nguoi FROM l_pin l LEFT JOIN nguoi_dung nd ON nd.id=l.created_by
      UNION ALL
      SELECT l.lenh_id, 'RELEASE_2', a.thoi_gian, nd.ho_ten FROM l_pin l JOIN audit_log a ON a.id_ban_ghi = l.lenh_id::text
        AND a.ten_bang='lenh_san_xuat' AND a.hanh_dong='RELEASE_2' LEFT JOIN nguoi_dung nd ON nd.id = a.nguoi_thuc_hien_id
      UNION ALL
      SELECT p.lenh_id, 'SAN_XUAT', p.tg_bd, nd.ho_ten FROM p_pin p LEFT JOIN nguoi_dung nd ON nd.id=p.created_by
      UNION ALL
      SELECT tp.lenh_id, 'CHO_KHO', tp.created_date, nd.ho_ten FROM t_pin tp LEFT JOIN nguoi_dung nd ON nd.id=tp.created_by
      UNION ALL
      SELECT tp.lenh_id, 'KIEM', k.created_date, nd.ho_ten FROM kcs k JOIN t_pin tp ON tp.tem_id=k.tem_id LEFT JOIN nguoi_dung nd ON nd.id=k.created_by
      UNION ALL
      SELECT tp.lenh_id, 'SUA', s.created_date, nd.ho_ten FROM sua s JOIN t_pin tp ON tp.tem_id=s.tem_id LEFT JOIN nguoi_dung nd ON nd.id=s.created_by
      UNION ALL
      SELECT tp.lenh_id, 'OQC', o.created_date, nd.ho_ten FROM oqc o JOIN t_pin tp ON tp.tem_id=o.tem_id LEFT JOIN nguoi_dung nd ON nd.id=o.created_by
      UNION ALL
      SELECT tp.lenh_id, 'DONE_DELIVERY', COALESCE(gh.ngay_giao::timestamptz, gh.updated_date), nd.ho_ten
        FROM giao_hang gh JOIN giao_hang_tem ght ON ght.giao_hang_id=gh.id JOIN t_pin tp ON tp.tem_id=ght.tem_id
        LEFT JOIN nguoi_dung nd ON nd.id=gh.updated_by WHERE gh.trang_thai='DA_GIAO'
    ) m
    WHERE tg IS NOT NULL
    GROUP BY lenh_id, ma_tram`;

  // SỐ LƯỢNG per LỆNH per trạm (để hiện ở node hành trình: SL release/in, KCS đạt/sửa/hủy, sửa đạt, OQC đạt, giao).
  const qtySql = `
    WITH l AS (
      SELECT DISTINCT ls.id AS lenh_id, ls.so_luong_release
      FROM lenh_san_xuat ls JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
      JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
      WHERE dv.phan_in_id = $1 AND ls.trang_thai <> 'HUY'
    ),
    tp AS (
      SELECT l.lenh_id, tm.id AS tem_id, tm.so_luong, tm.trang_thai
      FROM l JOIN phieu_san_xuat ps ON ps.lenh_san_xuat_id = l.lenh_id
      JOIN tem tm ON tm.phieu_san_xuat_id = ps.id
    )
    SELECT l.lenh_id, l.so_luong_release,
      COALESCE((SELECT SUM(so_luong) FROM tp WHERE tp.lenh_id=l.lenh_id AND tp.trang_thai<>'HUY'),0)::int AS pcs_in,
      COALESCE((SELECT SUM(k.so_luong_dat) FROM kcs k WHERE k.tem_id IN (SELECT tem_id FROM tp WHERE tp.lenh_id=l.lenh_id)),0)::int AS kcs_dat,
      COALESCE((SELECT SUM(GREATEST(k.so_luong_loi-COALESCE(k.so_luong_huy,0),0)) FROM kcs k WHERE k.tem_id IN (SELECT tem_id FROM tp WHERE tp.lenh_id=l.lenh_id)),0)::int AS kcs_sua,
      COALESCE((SELECT SUM(COALESCE(k.so_luong_huy,0)) FROM kcs k WHERE k.tem_id IN (SELECT tem_id FROM tp WHERE tp.lenh_id=l.lenh_id)),0)::int AS kcs_huy,
      COALESCE((SELECT SUM(s.so_luong_sua_dat) FROM sua s WHERE s.tem_id IN (SELECT tem_id FROM tp WHERE tp.lenh_id=l.lenh_id)),0)::int AS sua_dat,
      COALESCE((SELECT SUM(s.so_luong_sua_huy) FROM sua s WHERE s.tem_id IN (SELECT tem_id FROM tp WHERE tp.lenh_id=l.lenh_id)),0)::int AS sua_huy,
      COALESCE((SELECT SUM(o.so_luong_dat) FROM oqc o WHERE o.tem_id IN (SELECT tem_id FROM tp WHERE tp.lenh_id=l.lenh_id)),0)::int AS oqc_dat,
      COALESCE((SELECT SUM(ght.so_luong_giao) FROM giao_hang_tem ght WHERE ght.tem_id IN (SELECT tem_id FROM tp WHERE tp.lenh_id=l.lenh_id)),0)::int AS giao
    FROM l`;

  // Đợt vải CHƯA release (chưa có lệnh ≠ HUY nào) — để hiện hành trình READY NGAY, không chờ tạo lệnh.
  const pendingSql = `
    SELECT dv.ma_dot_vai, COALESCE(dv.so_luong_vai_ve,0)::int AS so_luong
    FROM dot_vai_ve dv
    WHERE dv.phan_in_id = $1 AND dv.trang_thai NOT IN ('DA_GOP','DA_HUY')
      AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai lsd JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id
                      WHERE lsd.dot_vai_ve_id = dv.id AND ls.trang_thai <> 'HUY')
    ORDER BY dv.created_date, dv.ma_dot_vai`;

  const [tramR, readyR, readyEvR, lenhR, lenhCklR, mocR, qtyR, pendingR] = await Promise.all([
    query(tramSql.replace(/\s+/g, ' ')),
    query(readyCklSql.replace(/\s+/g, ' '), [phanInId]),
    query(readyEventsSql.replace(/\s+/g, ' '), [phanInId]),
    query(lenhSql.replace(/\s+/g, ' '), [phanInId]),
    query(lenhCklSql.replace(/\s+/g, ' '), [phanInId]),
    query(mocSql.replace(/\s+/g, ' '), [phanInId]),
    query(qtySql.replace(/\s+/g, ' '), [phanInId]),
    query(pendingSql.replace(/\s+/g, ' '), [phanInId]),
  ]);
  const qtyByLenh = new Map(qtyR.rows.map((r) => [r.lenh_id, r]));
  // Số lượng hiển thị ở từng node theo trạm (mảng {label, value}).
  const nodeQty = (ma, q) => {
    if (!q) return [];
    switch (ma) {
      case 'RELEASE_1': case 'RELEASE_2': return [{ label: 'SL release', value: q.so_luong_release || 0 }];
      case 'SAN_XUAT': case 'CHO_KHO': return [{ label: 'SL in', value: q.pcs_in || 0 }];
      case 'KIEM': return [{ label: 'Đạt', value: q.kcs_dat || 0 }, { label: 'Sửa', value: q.kcs_sua || 0 }, { label: 'Hủy', value: q.kcs_huy || 0 }];
      case 'SUA': return [{ label: 'Sửa đạt', value: q.sua_dat || 0 }, { label: 'Sửa hủy', value: q.sua_huy || 0 }];
      case 'OQC': return [{ label: 'Đạt', value: q.oqc_dat || 0 }];
      case 'DONE_DELIVERY': return [{ label: 'SL giao', value: q.giao || 0 }];
      default: return [];
    }
  };

  const tramInfo = new Map(tramR.rows.map((t) => [t.ma_tram, t]));
  const tenTram = (ma) => tramInfo.get(ma)?.ten_tram || ma;
  const thuTu = (ma) => tramInfo.get(ma)?.thu_tu ?? 999;

  // READY (mức phần in)
  const ready = readyR.rows.length ? {
    ma_tram: 'READY', ten_tram: tenTram('READY'), thu_tu: thuTu('READY'),
    checklists: readyR.rows.map((r) => ({
      ma_checkpoint: r.ma_checkpoint, ten_checkpoint: r.ten_checkpoint,
      gia_tri_text: r.gia_tri_text, tg: r.tg, nguoi: r.nguoi || null,
    })),
  } : null;

  // Gom checklist + mốc theo lệnh
  const cklByLenh = new Map(); // lenh_id -> ma_tram -> checklists[]
  lenhCklR.rows.forEach((r) => {
    if (r.ma_tram === 'READY') return; // READY đã tách riêng
    if (!cklByLenh.has(r.lenh_id)) cklByLenh.set(r.lenh_id, new Map());
    const m = cklByLenh.get(r.lenh_id);
    if (!m.has(r.ma_tram)) m.set(r.ma_tram, []);
    m.get(r.ma_tram).push({ ma_checkpoint: r.ma_checkpoint, ten_checkpoint: r.ten_checkpoint, gia_tri_text: r.gia_tri_text, tg: r.tg, nguoi: r.nguoi || null });
  });
  const mocByLenh = new Map(); // lenh_id -> ma_tram -> moc
  mocR.rows.forEach((r) => {
    if (!mocByLenh.has(r.lenh_id)) mocByLenh.set(r.lenh_id, new Map());
    mocByLenh.get(r.lenh_id).set(r.ma_tram, { tg: r.tg, nguoi: r.nguoi || null, so_luong: r.so_luong });
  });

  // READY RIÊNG cho từng đợt SX = xác nhận READY (DAT) mới nhất TRƯỚC thời điểm tạo lệnh, theo từng checklist
  // (đúng CHU KỲ READY của lệnh đó — 1 phần in có nhiều READY khi được mở lại giữa các đợt SX).
  const readyEvents = readyEvR.rows;
  const readyForLenh = (createdDate) => {
    const T = new Date(createdDate).getTime();
    const byCp = new Map();
    for (const e of readyEvents) {
      if (new Date(e.tg).getTime() <= T) byCp.set(e.ma_checkpoint, e); // events đã ORDER BY tg → giữ cái mới nhất ≤ T
    }
    const checklists = [...byCp.values()].sort((a, b) => a.cp_thu_tu - b.cp_thu_tu)
      .map((e) => ({ ma_checkpoint: e.ma_checkpoint, ten_checkpoint: e.ten_checkpoint, gia_tri_text: null, tg: e.tg, nguoi: e.nguoi || null }));
    if (!checklists.length) return null;
    return { ma_tram: 'READY', ten_tram: tenTram('READY'), thu_tu: thuTu('READY'), checklists, moc: null };
  };

  const journeys = lenhR.rows.map((l) => {
    const ckl = cklByLenh.get(l.id) || new Map();
    const moc = mocByLenh.get(l.id) || new Map();
    const q = qtyByLenh.get(l.id);
    const maTrams = new Set([...ckl.keys(), ...moc.keys()]);
    const trams = [...maTrams].map((ma) => ({
      ma_tram: ma, ten_tram: tenTram(ma), thu_tu: thuTu(ma),
      checklists: ckl.get(ma) || [], moc: moc.get(ma) || null, qty: nodeQty(ma, q),
    })).sort((a, b) => a.thu_tu - b.thu_tu);
    // READY của chu kỳ ứng với lệnh (từ lịch sử); thiếu lịch sử (dữ liệu cũ/seed) → dùng READY hiện tại.
    const readyNode = readyForLenh(l.created_date) || ready;
    return {
      lenh_id: l.id, ma_lenh_san_xuat: l.ma_lenh_san_xuat, giai_doan: l.giai_doan,
      dot_vai: l.dot_vai || [], trams: readyNode ? [readyNode, ...trams] : trams,
    };
  });

  // Khối "chờ release": các đợt vải chưa có lệnh → hiện node READY hiện tại (mức phần in), KHÔNG có LSX.
  const pending = pendingR.rows.length ? {
    dot_vai: pendingR.rows.map((r) => ({ ma_dot_vai: r.ma_dot_vai, so_luong: r.so_luong })),
    trams: ready ? [ready] : [],
  } : null;

  return { ready, journeys, pending };
}

// Tổng hợp SỐ LƯỢNG theo tem của 1 phần in (hợp nhất mọi tem của phần in) — từ chờ khô trở đi.
//  pcs_in    = tổng pcs đã in (tem không HUY)
//  sl_dat    = tổng đạt (KCS)
//  sl_sua    = tổng chuyển sửa (KCS: lỗi - hủy tại KCS)
//  sl_sua_dat= tổng sửa đạt (bảng sửa)
async function getPhanInTemSummary(phanInId) {
  const sql = `
    WITH t_pin AS (
      SELECT tm.id AS tem_id, tm.so_luong, tm.trang_thai
      FROM tem tm
      JOIN phieu_san_xuat ps ON ps.id = tm.phieu_san_xuat_id
      JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id AND ls.trang_thai <> 'HUY'
      JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
      JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id AND dv.phan_in_id = $1
    )
    SELECT
      COALESCE(SUM(t.so_luong) FILTER (WHERE t.trang_thai <> 'HUY'), 0)::int AS pcs_in,
      COALESCE((SELECT SUM(k.so_luong_dat) FROM kcs k WHERE k.tem_id IN (SELECT tem_id FROM t_pin)), 0)::int AS sl_dat,
      COALESCE((SELECT SUM(GREATEST(k.so_luong_loi - COALESCE(k.so_luong_huy,0), 0)) FROM kcs k WHERE k.tem_id IN (SELECT tem_id FROM t_pin)), 0)::int AS sl_sua,
      COALESCE((SELECT SUM(s.so_luong_sua_dat) FROM sua s WHERE s.tem_id IN (SELECT tem_id FROM t_pin)), 0)::int AS sl_sua_dat,
      (SELECT count(*) FROM t_pin WHERE trang_thai <> 'HUY')::int AS so_tem
    FROM t_pin t`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [phanInId]);
  return rows[0] || { pcs_in: 0, sl_dat: 0, sl_sua: 0, sl_sua_dat: 0, so_tem: 0 };
}

// KCS theo TỪNG ĐỢT VẢI của 1 phần in (mỗi tem gắn đợt qua lenh_sx_dot_vai).
//  Trả về { dot: [{ma_dot_vai, sl_kiem, sl_dat, sl_hu, sl_sua, sl_huy, sl_du, sl_thieu, sl_sua_dat}], tong }.
//  sl_sua = quyết định sửa = hư − hủy (theo quy ước hiện có); tong chỉ có khi ≥2 đợt có KCS.
async function getPhanInKcsByDot(phanInId) {
  const sql = `
    WITH td AS (
      SELECT DISTINCT dv.id AS dot_vai_ve_id, t.id AS tem_id
      FROM dot_vai_ve dv
      JOIN lenh_sx_dot_vai lsd ON lsd.dot_vai_ve_id = dv.id
      JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id AND ls.trang_thai <> 'HUY'
      JOIN phieu_san_xuat ps ON ps.lenh_san_xuat_id = ls.id
      JOIN tem t ON t.phieu_san_xuat_id = ps.id AND t.trang_thai <> 'HUY'
      WHERE dv.phan_in_id = $1
    ),
    ad AS (SELECT id AS dot_vai_ve_id, ma_dot_vai FROM dot_vai_ve WHERE phan_in_id = $1)
    SELECT ad.dot_vai_ve_id, ad.ma_dot_vai,
           COALESCE(k.sl_kiem,0)::int AS sl_kiem, COALESCE(k.sl_dat,0)::int AS sl_dat,
           COALESCE(k.sl_hu,0)::int AS sl_hu, COALESCE(k.sl_sua,0)::int AS sl_sua,
           COALESCE(k.sl_huy,0)::int AS sl_huy, COALESCE(k.sl_du,0)::int AS sl_du,
           COALESCE(k.sl_thieu,0)::int AS sl_thieu, COALESCE(s.sl_sua_dat,0)::int AS sl_sua_dat,
           COALESCE(s.sl_sua_huy,0)::int AS sl_sua_huy
    FROM ad
    LEFT JOIN LATERAL (
      SELECT SUM(kc.so_luong_kiem) AS sl_kiem, SUM(kc.so_luong_dat) AS sl_dat,
             SUM(kc.so_luong_loi) AS sl_hu,
             SUM(GREATEST(kc.so_luong_loi - COALESCE(kc.so_luong_huy,0), 0)) AS sl_sua,
             SUM(kc.so_luong_huy) AS sl_huy,
             SUM(GREATEST(kc.so_luong_chenh_lech, 0)) AS sl_du,
             SUM(GREATEST(-kc.so_luong_chenh_lech, 0)) AS sl_thieu
      FROM kcs kc WHERE kc.tem_id IN (SELECT tem_id FROM td WHERE td.dot_vai_ve_id = ad.dot_vai_ve_id)
    ) k ON true
    LEFT JOIN LATERAL (
      SELECT SUM(su.so_luong_sua_dat) AS sl_sua_dat, SUM(su.so_luong_sua_huy) AS sl_sua_huy
      FROM sua su WHERE su.tem_id IN (SELECT tem_id FROM td WHERE td.dot_vai_ve_id = ad.dot_vai_ve_id)
    ) s ON true
    ORDER BY ad.ma_dot_vai`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [phanInId]);
  const dot = rows.filter((r) => r.sl_kiem > 0 || r.sl_dat > 0 || r.sl_hu > 0 || r.sl_huy > 0);
  if (dot.length === 0) return { dot: [], tong: null };
  let tong = null;
  if (dot.length > 1) {
    const keys = ['sl_kiem', 'sl_dat', 'sl_hu', 'sl_sua', 'sl_huy', 'sl_du', 'sl_thieu', 'sl_sua_dat', 'sl_sua_huy'];
    tong = keys.reduce((acc, kk) => { acc[kk] = dot.reduce((s, r) => s + (r[kk] || 0), 0); return acc; }, {});
  }
  return { dot, tong };
}

// SL theo TRẠM (hợp nhất theo phần in) để hiện tại node hành trình:
//  sl_release (Release 1) · sl_in_xong (Sản xuất) · oqc_dat (OQC) + nhánh kcs_dat/sua_dat (qua sửa).
async function getPhanInStagePcs(phanInId) {
  const sql = `
    WITH lp AS (
      SELECT DISTINCT ls.id, ls.so_luong_release, ls.la_in_lai
      FROM lenh_san_xuat ls
      JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
      JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id AND dv.phan_in_id = $1
      WHERE ls.trang_thai <> 'HUY'
    ),
    tp AS (
      SELECT DISTINCT tm.id, tm.so_luong, tm.trang_thai
      FROM tem tm
      JOIN phieu_san_xuat ps ON ps.id = tm.phieu_san_xuat_id
      JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id AND ls.trang_thai <> 'HUY'
      JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
      JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id AND dv.phan_in_id = $1
    )
    SELECT
      COALESCE((SELECT SUM(so_luong_release) FROM lp WHERE la_in_lai IS NOT TRUE), 0)::int AS sl_release,
      COALESCE((SELECT SUM(so_luong) FROM tp WHERE trang_thai <> 'HUY'), 0)::int AS sl_in_xong,
      COALESCE((SELECT SUM(so_luong_dat) FROM kcs WHERE tem_id IN (SELECT id FROM tp)), 0)::int AS kcs_dat,
      COALESCE((SELECT SUM(so_luong_sua_dat) FROM sua WHERE tem_id IN (SELECT id FROM tp)), 0)::int AS sua_dat,
      COALESCE((SELECT SUM(so_luong_dat) FROM oqc WHERE tem_id IN (SELECT id FROM tp)), 0)::int AS oqc_dat`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [phanInId]);
  return rows[0] || { sl_release: 0, sl_in_xong: 0, kcs_dat: 0, sua_dat: 0, oqc_dat: 0 };
}

// Thời gian chờ khô (phút) của phần in — best-effort (cần migration 038).
async function getDryMin(id) {
  try {
    const { rows } = await query('SELECT thoi_gian_cho_kho_phut AS phut FROM phan_in WHERE id=$1', [id]);
    return rows[0]?.phut ?? null;
  } catch (e) { return null; }
}

async function setDryMin(id, phut, actorId) {
  await query('UPDATE phan_in SET thoi_gian_cho_kho_phut=$2, updated_by=$3, updated_date=CURRENT_TIMESTAMP WHERE id=$1',
    [id, phut, actorId]);
  return true;
}

async function setLoiNhuan(id, loiNhuan, actorId) {
  const { rowCount } = await query(
    'UPDATE phan_in SET loi_nhuan = $2, updated_by = $3, updated_date = CURRENT_TIMESTAMP WHERE id = $1',
    [id, loiNhuan, actorId]
  );
  return rowCount > 0;
}

// Ghi lịch sử đặt lợi nhuận vào audit_log (forward-only).
async function logProfitChange(id, oldVal, newVal, actorId) {
  await query(
    `INSERT INTO audit_log
       (ten_bang, id_ban_ghi, hanh_dong, gia_tri_cu, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ('phan_in', $1, 'SET_LOI_NHUAN', $2::jsonb, $3::jsonb, $4, CURRENT_TIMESTAMP, $4)`,
    [String(id), JSON.stringify({ loi_nhuan: oldVal ?? null }), JSON.stringify({ loi_nhuan: newVal ?? null }), actorId]
  );
}

async function profitHistoryByDate(date) {
  const { rows } = await query(
    `SELECT a.thoi_gian AS tg, nd.ho_ten AS nguoi, pin.ma_phan, mh.ma_hang,
            a.gia_tri_cu->>'loi_nhuan' AS cu, a.gia_tri_moi->>'loi_nhuan' AS moi
     FROM audit_log a
     JOIN phan_in pin ON pin.id = a.id_ban_ghi::uuid
     JOIN ma_hang mh ON mh.id = pin.ma_hang_id
     LEFT JOIN nguoi_dung nd ON nd.id = a.nguoi_thuc_hien_id
     WHERE a.ten_bang = 'phan_in' AND a.hanh_dong = 'SET_LOI_NHUAN'
       AND (a.thoi_gian AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $1::date
     ORDER BY a.thoi_gian DESC`,
    [date]
  );
  return rows;
}

// ─── Hủy phần in (xóa mềm) ───────────────────────────────────────────────────
// Tìm phần in CÒN HOẠT ĐỘNG theo code phần / mã hàng / màu / khách (cho chọn nhiều rồi hủy).
// Kèm `giai_doan` = trạm hiện tại (dominant stage); `stage` (chip) để LỌC theo trạm đang ở.
async function searchPhanInForCancel(q, stage = '') {
  const stageCond = chipCondition(stage, 'pin.id'); // null nếu stage rỗng/'ALL'
  const sql = `
    SELECT pin.id AS phan_in_id, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim,
           mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang,
           (${dominantStageScalar('pin.id')}) AS giai_doan,
           (SELECT count(*) FROM dot_vai_ve d WHERE d.phan_in_id=pin.id AND d.trang_thai <> 'DA_HUY')::int AS so_dot_vai,
           EXISTS (SELECT 1 FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve d ON d.id=lsd.dot_vai_ve_id
                   JOIN lenh_san_xuat ls ON ls.id=lsd.lenh_san_xuat_id
                   WHERE d.phan_in_id=pin.id AND ls.trang_thai <> 'HUY') AS da_san_xuat
    FROM phan_in pin
    JOIN ma_hang mh ON mh.id=pin.ma_hang_id
    JOIN don_hang dh ON dh.id=mh.don_hang_id
    JOIN khach_hang kh ON kh.id=dh.khach_hang_id
    WHERE pin.dang_hoat_dong
      AND ($1='' OR pin.ma_phan ILIKE '%'||$1||'%' OR mh.ma_hang ILIKE '%'||$1||'%'
           OR pin.mau_vai ILIKE '%'||$1||'%' OR kh.ten_khach_hang ILIKE '%'||$1||'%')
      ${stageCond ? `AND (${stageCond})` : ''}
    ORDER BY pin.ma_phan LIMIT 50`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [q || '']);
  return rows;
}

// Xóa mềm 1 phần in + toàn bộ liên quan: tem/phiếu/lệnh → HUY, đợt vải → DA_HUY, phần in → dang_hoat_dong=false.
// SNAPSHOT trạng thái TRƯỚC khi xóa (id + trạng thái cũ) → cho phép "Mở phần in" khôi phục CHÍNH XÁC (task 4).
async function softDeletePhanInTx(client, phanInId, actorId) {
  const pin = await client.query('SELECT ma_phan FROM phan_in WHERE id=$1 AND dang_hoat_dong', [phanInId]);
  if (!pin.rows.length) return null;
  const temSel = `SELECT t.id, t.trang_thai FROM tem t WHERE t.trang_thai <> 'HUY' AND t.phieu_san_xuat_id IN (
       SELECT ps.id FROM phieu_san_xuat ps JOIN lenh_san_xuat ls ON ls.id=ps.lenh_san_xuat_id
       JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id=ls.id JOIN dot_vai_ve dv ON dv.id=lsd.dot_vai_ve_id
       WHERE dv.phan_in_id=$1)`.replace(/\s+/g, ' ');
  const phieuSel = `SELECT ps.id, ps.trang_thai FROM phieu_san_xuat ps WHERE ps.trang_thai <> 'HUY' AND ps.lenh_san_xuat_id IN (
       SELECT ls.id FROM lenh_san_xuat ls JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id=ls.id
       JOIN dot_vai_ve dv ON dv.id=lsd.dot_vai_ve_id WHERE dv.phan_in_id=$1)`.replace(/\s+/g, ' ');
  const lenhSel = `SELECT ls.id, ls.trang_thai FROM lenh_san_xuat ls WHERE ls.trang_thai <> 'HUY' AND ls.id IN (
       SELECT lsd.lenh_san_xuat_id FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id=lsd.dot_vai_ve_id
       WHERE dv.phan_in_id=$1)`.replace(/\s+/g, ' ');
  const dvSel = "SELECT id, trang_thai FROM dot_vai_ve WHERE phan_in_id=$1 AND trang_thai <> 'DA_HUY'";
  // Chạy TUẦN TỰ (cùng 1 client transaction — không dùng Promise.all trên cùng client).
  const tems = await client.query(temSel, [phanInId]);
  const phieus = await client.query(phieuSel, [phanInId]);
  const lenhs = await client.query(lenhSel, [phanInId]);
  const dvs = await client.query(dvSel, [phanInId]);
  const snapshot = { tem: tems.rows, phieu: phieus.rows, lenh: lenhs.rows, dot_vai: dvs.rows };

  await client.query(`UPDATE tem SET trang_thai='HUY', updated_by=$2, updated_date=CURRENT_TIMESTAMP
     WHERE trang_thai <> 'HUY' AND phieu_san_xuat_id IN (
       SELECT ps.id FROM phieu_san_xuat ps JOIN lenh_san_xuat ls ON ls.id=ps.lenh_san_xuat_id
       JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id=ls.id JOIN dot_vai_ve dv ON dv.id=lsd.dot_vai_ve_id
       WHERE dv.phan_in_id=$1)`.replace(/\s+/g, ' '), [phanInId, actorId]);
  await client.query(`UPDATE phieu_san_xuat SET trang_thai='HUY', updated_by=$2, updated_date=CURRENT_TIMESTAMP
     WHERE trang_thai <> 'HUY' AND lenh_san_xuat_id IN (
       SELECT ls.id FROM lenh_san_xuat ls JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id=ls.id
       JOIN dot_vai_ve dv ON dv.id=lsd.dot_vai_ve_id WHERE dv.phan_in_id=$1)`.replace(/\s+/g, ' '), [phanInId, actorId]);
  await client.query(`UPDATE lenh_san_xuat SET trang_thai='HUY', updated_by=$2, updated_date=CURRENT_TIMESTAMP
     WHERE trang_thai <> 'HUY' AND id IN (
       SELECT lsd.lenh_san_xuat_id FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id=lsd.dot_vai_ve_id
       WHERE dv.phan_in_id=$1)`.replace(/\s+/g, ' '), [phanInId, actorId]);
  await client.query("UPDATE dot_vai_ve SET trang_thai='DA_HUY', updated_by=$2, updated_date=CURRENT_TIMESTAMP WHERE phan_in_id=$1 AND trang_thai <> 'DA_HUY'", [phanInId, actorId]);
  await client.query('UPDATE phan_in SET dang_hoat_dong=false, updated_by=$2, updated_date=CURRENT_TIMESTAMP WHERE id=$1', [phanInId, actorId]);
  return { ma_phan: pin.rows[0].ma_phan, snapshot };
}

async function logSoftDeletePhanIn(phanInId, maPhan, lyDo, actorId, snapshot = null) {
  await query(`INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ('phan_in', $1, 'HUY_PHAN_IN', $2::jsonb, $3, CURRENT_TIMESTAMP, $3)`,
  [String(phanInId), JSON.stringify({ ma_phan: maPhan, ly_do: lyDo || null, snapshot }), actorId]);
}

// ─── Mở lại phần in (khôi phục xóa mềm) ──────────────────────────────────────
// Danh sách phần in ĐÃ XÓA MỀM (dang_hoat_dong=false) có bản ghi HUY_PHAN_IN — mới nhất mỗi phần in.
async function listDeletedPhanIn(q) {
  const sql = `
    SELECT DISTINCT ON (pin.id) pin.id AS phan_in_id, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim,
           mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang,
           a.thoi_gian AS tg_huy, nd.ho_ten AS nguoi_huy, a.gia_tri_moi->>'ly_do' AS ly_do,
           (a.gia_tri_moi->'snapshot' IS NOT NULL) AS co_snapshot,
           (SELECT count(*) FROM dot_vai_ve d WHERE d.phan_in_id=pin.id)::int AS so_dot_vai
    FROM phan_in pin
    JOIN ma_hang mh ON mh.id=pin.ma_hang_id
    JOIN don_hang dh ON dh.id=mh.don_hang_id
    JOIN khach_hang kh ON kh.id=dh.khach_hang_id
    JOIN audit_log a ON a.ten_bang='phan_in' AND a.hanh_dong='HUY_PHAN_IN' AND a.id_ban_ghi=pin.id::text
    LEFT JOIN nguoi_dung nd ON nd.id=a.nguoi_thuc_hien_id
    WHERE pin.dang_hoat_dong=false
      AND ($1='' OR pin.ma_phan ILIKE '%'||$1||'%' OR mh.ma_hang ILIKE '%'||$1||'%'
           OR pin.mau_vai ILIKE '%'||$1||'%' OR kh.ten_khach_hang ILIKE '%'||$1||'%')
    ORDER BY pin.id, a.thoi_gian DESC`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [q || '']);
  return rows.sort((a, b) => new Date(b.tg_huy) - new Date(a.tg_huy)).slice(0, 100);
}

// Đọc snapshot xóa mềm mới nhất của phần in (từ audit HUY_PHAN_IN).
async function getDeleteSnapshot(phanInId) {
  const { rows } = await query(
    `SELECT gia_tri_moi->'snapshot' AS snapshot FROM audit_log
     WHERE ten_bang='phan_in' AND hanh_dong='HUY_PHAN_IN' AND id_ban_ghi=$1
     ORDER BY thoi_gian DESC LIMIT 1`, [String(phanInId)]);
  return rows[0]?.snapshot || null;
}

// Khôi phục phần in: đảo snapshot chính xác (nếu có), else best-effort (đợt vải DA_HUY→NHAN_VAI, phần in active).
async function restorePhanInTx(client, phanInId, snapshot, actorId) {
  const pin = await client.query('SELECT ma_phan FROM phan_in WHERE id=$1 AND dang_hoat_dong=false', [phanInId]);
  if (!pin.rows.length) return null;
  if (snapshot && (snapshot.tem || snapshot.lenh || snapshot.phieu || snapshot.dot_vai)) {
    const restore = async (table, rows) => {
      for (const r of (rows || [])) {
        await client.query(`UPDATE ${table} SET trang_thai=$2, updated_by=$3, updated_date=CURRENT_TIMESTAMP WHERE id=$1`,
          [r.id, r.trang_thai, actorId]);
      }
    };
    await restore('lenh_san_xuat', snapshot.lenh);
    await restore('phieu_san_xuat', snapshot.phieu);
    await restore('tem', snapshot.tem);
    await restore('dot_vai_ve', snapshot.dot_vai);
  } else {
    // Dữ liệu cũ (không snapshot): chỉ khôi phục đợt vải + phần in (lệnh/tem giữ HUY).
    await client.query("UPDATE dot_vai_ve SET trang_thai='NHAN_VAI', updated_by=$2, updated_date=CURRENT_TIMESTAMP WHERE phan_in_id=$1 AND trang_thai='DA_HUY'", [phanInId, actorId]);
  }
  await client.query('UPDATE phan_in SET dang_hoat_dong=true, updated_by=$2, updated_date=CURRENT_TIMESTAMP WHERE id=$1', [phanInId, actorId]);
  return pin.rows[0].ma_phan;
}

async function logRestorePhanIn(phanInId, maPhan, actorId) {
  await query(`INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ('phan_in', $1, 'MO_PHAN_IN', $2::jsonb, $3, CURRENT_TIMESTAMP, $3)`,
  [String(phanInId), JSON.stringify({ ma_phan: maPhan }), actorId]);
}

module.exports = { list, listVaiVe, dotSanXuatLedger, findById, listDotVai, getPhanInTimeline, getPhanInTemSummary, getPhanInKcsByDot, getPhanInStagePcs, getDryMin, setDryMin, setLoiNhuan, logProfitChange, profitHistoryByDate,
  searchPhanInForCancel, softDeletePhanInTx, logSoftDeletePhanIn,
  listDeletedPhanIn, getDeleteSnapshot, restorePhanInTx, logRestorePhanIn };
