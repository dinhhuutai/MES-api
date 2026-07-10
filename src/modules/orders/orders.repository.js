'use strict';

const { query } = require('../../config/db');

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
  const where = buildWhere(search, missingProfit);
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
    LEFT JOIN dot_vai_ve dv ON dv.phan_in_id = pin.id
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

// Điều kiện lọc theo GIAI ĐOẠN của phần in (derive từ trạng thái runtime — không phụ thuộc ton_tram/029).
// GIAI ĐOẠN khớp với MÀN HÌNH: phần in ĐÃ RELEASE (có lệnh ≠ HUY, trạng thái RELEASE_1) → Test Run;
// QC xong nhưng CHƯA release → Release 1; chưa QC → READY. Lệnh 'HUY' (đã hủy chuyển trạm) coi như chưa release.
// Một phần in có thể ở nhiều giai đoạn (nhiều đợt vải/tem rải rác).
function stageCondition(stage) {
  const LJ = "SELECT 1 FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve d ON d.id=lsd.dot_vai_ve_id AND d.phan_in_id=pin.id JOIN lenh_san_xuat ls ON ls.id=lsd.lenh_san_xuat_id";
  const anyLenh = `EXISTS (${LJ} WHERE ls.trang_thai <> 'HUY')`;
  const tem = (list) => `EXISTS (${LJ} JOIN phieu_san_xuat ps ON ps.lenh_san_xuat_id=ls.id JOIN tem t ON t.phieu_san_xuat_id=ps.id WHERE ls.trang_thai <> 'HUY' AND t.trang_thai <> 'HUY' AND t.trang_thai IN (${list.map((s) => `'${s}'`).join(',')}))`;
  const phieuChay = `EXISTS (${LJ} JOIN phieu_san_xuat ps ON ps.lenh_san_xuat_id=ls.id WHERE ls.trang_thai <> 'HUY' AND ps.trang_thai='DANG_CHAY')`;
  const qcDone = "EXISTS (SELECT 1 FROM ket_qua_checkpoint kq JOIN checkpoint c ON c.id=kq.checkpoint_id WHERE kq.phan_in_id=pin.id AND c.ma_checkpoint='QC_XAC_NHAN' AND kq.trang_thai='DAT')";
  // Test Run của 1 lệnh đã đủ CNSP + QA → lệnh sẵn sàng "duyệt cuối" (giai đoạn Release 2), không còn ở Test Run.
  const testDat = (ma) => `EXISTS (SELECT 1 FROM ket_qua_checkpoint k JOIN checkpoint c ON c.id=k.checkpoint_id WHERE k.lenh_san_xuat_id=ls.id AND c.ma_checkpoint='${ma}' AND k.trang_thai='DAT')`;
  const bothTest = `${testDat('TEST_CNSP')} AND ${testDat('TEST_QA')}`;
  switch (stage) {
    // READY = chưa release & chưa QC (khớp màn Chuẩn bị kỹ thuật + dashboard). Bao gồm phần in mới lấy từ ERP (chưa xác nhận mục kỹ thuật nào).
    case 'READY': return `NOT ${anyLenh} AND NOT ${qcDone}`;
    case 'RELEASE_1': return `NOT ${anyLenh} AND ${qcDone}`;
    // TEST_RUN = lệnh RELEASE_1 CHƯA đủ CNSP+QA. Đủ rồi thì nằm ở RELEASE_2 (chờ duyệt cuối).
    case 'TEST_RUN': return `EXISTS (${LJ} WHERE ls.trang_thai='RELEASE_1' AND NOT (${bothTest}))`;
    // RELEASE_2 = chờ DUYỆT cuối (lệnh RELEASE_1 đã đủ CNSP+QA). CHO_SAN_XUAT = đã DUYỆT Release 2, chờ vào sản xuất.
    case 'RELEASE_2': return `EXISTS (${LJ} WHERE ls.trang_thai='RELEASE_1' AND ${bothTest})`;
    case 'CHO_SAN_XUAT': return `EXISTS (${LJ} WHERE ls.trang_thai='RELEASE_2')`;
    case 'SAN_XUAT': return phieuChay;
    case 'CHO_KHO': return tem(['IN', 'DANG_PHOI']);
    case 'KCS': return tem(['DA_KHO']);
    case 'SUA': return tem(['CHO_SUA']);
    case 'OQC': return tem(['CHO_OQC']);
    case 'GIAO': return tem(['OQC_DAT']);
    case 'DA_GIAO': return tem(['DA_GIAO']);
    default: return null;
  }
}

// Danh sách "phần in vải về": GỘP theo phần in (mỗi dòng = 1 phần in), kèm mảng đợt vải về.
// Hỗ trợ: tìm nhanh (search), lọc nhiều trường cùng lúc (filters, AND), lọc theo giai đoạn (stage).
async function listVaiVe({ search = '', filters = {}, stage = '', offset = 0, limit = 20 }) {
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

  const limitP = add(limit); const offsetP = add(offset);
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
             COALESCE(json_agg(json_build_object(
               'dot_vai_id', dv.id, 'ma_dot_vai', dv.ma_dot_vai, 'so_luong_vai_ve', dv.so_luong_vai_ve,
               'ngay_vai_ve', dv.ngay_vai_ve, 'han_giao_hang', dv.han_giao_hang
             ) ORDER BY dv.ngay_vai_ve NULLS LAST, dv.ma_dot_vai), '[]') AS dot_vai
      FROM dot_vai_ve dv WHERE dv.phan_in_id = pin.id
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
    ORDER BY kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang, pin.ma_phan
    LIMIT ${limitP} OFFSET ${offsetP}`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), params);
  const total = rows.length ? rows[0].total_count : 0;
  return { rows, total };
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

// Hành trình phần in qua các trạm (checkpoint) của workflow hiện hành:
//  - READY (mức phần in) + TEST_RUN (mức lệnh): checklist đã xác nhận, kèm giờ + người (ket_qua_checkpoint).
//  - SAN_XUAT → giao: mốc thời gian (không có checklist), suy từ phiếu/tem/kcs/sua/oqc/giao_hang.
// Trả về mảng trạm theo thứ tự dòng chảy, mỗi trạm { checklists[], moc }.
async function getPhanInTimeline(phanInId) {
  const tramSql = `SELECT t.ma_tram, t.ten_tram, t.thu_tu
    FROM tram t JOIN workflow_version wv ON wv.id=t.workflow_version_id
    WHERE wv.la_hien_hanh=true ORDER BY t.thu_tu`;

  const cklSql = `
    SELECT t.ma_tram, cp.ma_checkpoint, cp.ten_checkpoint, cp.thu_tu AS cp_thu_tu,
           kq.gia_tri_text, kq.tg_xac_nhan AS tg, nd.ho_ten AS nguoi
    FROM ket_qua_checkpoint kq
    JOIN checkpoint cp ON cp.id = kq.checkpoint_id
    JOIN tram t ON t.id = cp.tram_id
    JOIN workflow_version wv ON wv.id = t.workflow_version_id AND wv.la_hien_hanh = true
    LEFT JOIN nguoi_dung nd ON nd.id = kq.nguoi_xac_nhan_id
    WHERE kq.trang_thai='DAT'
      AND (kq.phan_in_id = $1
           OR kq.lenh_san_xuat_id IN (
             SELECT lsd.lenh_san_xuat_id FROM lenh_sx_dot_vai lsd
             JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
             JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id
             WHERE dv.phan_in_id = $1 AND ls.trang_thai <> 'HUY'))
    ORDER BY t.thu_tu, cp.thu_tu, kq.tg_xac_nhan`;

  const mocSql = `
    WITH t_pin AS (
      SELECT tm.id AS tem_id, tm.created_date, tm.created_by
      FROM tem tm
      JOIN phieu_san_xuat ps ON ps.id = tm.phieu_san_xuat_id
      JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id AND ls.trang_thai <> 'HUY'
      JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
      JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id AND dv.phan_in_id = $1
    ),
    p_pin AS (
      SELECT DISTINCT ps.id, ps.tg_bd, ps.created_by
      FROM phieu_san_xuat ps
      JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id AND ls.trang_thai <> 'HUY'
      JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
      JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id AND dv.phan_in_id = $1
    ),
    l_pin AS (
      SELECT DISTINCT ls.id, ls.created_date, ls.created_by
      FROM lenh_san_xuat ls
      JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
      JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id AND dv.phan_in_id = $1
      WHERE ls.trang_thai <> 'HUY'
    )
    SELECT ma_tram, min(tg) AS tg, (array_agg(nguoi ORDER BY tg NULLS LAST))[1] AS nguoi, count(*)::int AS so_luong
    FROM (
      SELECT 'RELEASE_1' AS ma_tram, l.created_date AS tg, nd.ho_ten AS nguoi FROM l_pin l LEFT JOIN nguoi_dung nd ON nd.id=l.created_by
      UNION ALL
      SELECT 'RELEASE_2', a.thoi_gian, nd.ho_ten FROM audit_log a JOIN l_pin l ON l.id = a.id_ban_ghi::uuid
        LEFT JOIN nguoi_dung nd ON nd.id = a.nguoi_thuc_hien_id
        WHERE a.ten_bang='lenh_san_xuat' AND a.hanh_dong='RELEASE_2'
      UNION ALL
      SELECT 'SAN_XUAT' AS ma_tram, p.tg_bd AS tg, nd.ho_ten AS nguoi FROM p_pin p LEFT JOIN nguoi_dung nd ON nd.id=p.created_by
      UNION ALL
      SELECT 'CHO_KHO', tp.created_date, nd.ho_ten FROM t_pin tp LEFT JOIN nguoi_dung nd ON nd.id=tp.created_by
      UNION ALL
      SELECT 'KIEM', k.created_date, nd.ho_ten FROM kcs k JOIN t_pin tp ON tp.tem_id=k.tem_id LEFT JOIN nguoi_dung nd ON nd.id=k.created_by
      UNION ALL
      SELECT 'SUA', s.created_date, nd.ho_ten FROM sua s JOIN t_pin tp ON tp.tem_id=s.tem_id LEFT JOIN nguoi_dung nd ON nd.id=s.created_by
      UNION ALL
      SELECT 'OQC', o.created_date, nd.ho_ten FROM oqc o JOIN t_pin tp ON tp.tem_id=o.tem_id LEFT JOIN nguoi_dung nd ON nd.id=o.created_by
      UNION ALL
      SELECT 'DONE_DELIVERY', COALESCE(gh.ngay_giao::timestamptz, gh.updated_date), nd.ho_ten
        FROM giao_hang gh JOIN giao_hang_tem ght ON ght.giao_hang_id=gh.id JOIN t_pin tp ON tp.tem_id=ght.tem_id
        LEFT JOIN nguoi_dung nd ON nd.id=gh.updated_by
        WHERE gh.trang_thai='DA_GIAO'
    ) m
    WHERE tg IS NOT NULL
    GROUP BY ma_tram`;

  const [tramR, cklR, mocR] = await Promise.all([
    query(tramSql.replace(/\s+/g, ' ')),
    query(cklSql.replace(/\s+/g, ' '), [phanInId]),
    query(mocSql.replace(/\s+/g, ' '), [phanInId]),
  ]);

  const tramInfo = new Map(tramR.rows.map((t) => [t.ma_tram, t]));
  const byTram = new Map();
  const nodeFor = (maTram) => {
    if (!byTram.has(maTram)) {
      const info = tramInfo.get(maTram);
      byTram.set(maTram, {
        ma_tram: maTram, ten_tram: info?.ten_tram || maTram,
        thu_tu: info?.thu_tu ?? 999, checklists: [], moc: null,
      });
    }
    return byTram.get(maTram);
  };
  cklR.rows.forEach((r) => {
    nodeFor(r.ma_tram).checklists.push({
      ma_checkpoint: r.ma_checkpoint, ten_checkpoint: r.ten_checkpoint,
      gia_tri_text: r.gia_tri_text, tg: r.tg, nguoi: r.nguoi || null,
    });
  });
  mocR.rows.forEach((r) => {
    nodeFor(r.ma_tram).moc = { tg: r.tg, nguoi: r.nguoi || null, so_luong: r.so_luong };
  });
  return [...byTram.values()].sort((a, b) => a.thu_tu - b.thu_tu);
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

module.exports = { list, listVaiVe, findById, listDotVai, getPhanInTimeline, getPhanInTemSummary, getPhanInKcsByDot, getPhanInStagePcs, getDryMin, setDryMin, setLoiNhuan, logProfitChange, profitHistoryByDate };
