'use strict';

const { query } = require('../../config/db');

const groupMap = (rows, keyCol, valCol = 'n') =>
  rows.reduce((acc, r) => { acc[r[keyCol]] = Number(r[valCol]); return acc; }, {});

async function summary() {
  const [
    donHang, donHangTT, phanIn, lenhTT, temTT, xePhoi, giaoHangTT, giaoSl, kcs, oqc, nghen,
  ] = await Promise.all([
    query('SELECT count(*)::int AS n FROM don_hang'),
    query('SELECT trang_thai, count(*)::int AS n FROM don_hang GROUP BY trang_thai'),
    query(`SELECT
             count(*)::int AS total,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ket_qua_checkpoint kq JOIN checkpoint cp ON cp.id=kq.checkpoint_id
                WHERE kq.phan_in_id=pin.id AND cp.ma_checkpoint='QC_XAC_NHAN' AND kq.trang_thai='DAT'))::int AS ready,
             count(*) FILTER (WHERE pin.loi_nhuan IS NOT NULL)::int AS co_loi_nhuan
           FROM phan_in pin`),
    query("SELECT trang_thai, count(*)::int AS n FROM lenh_san_xuat GROUP BY trang_thai"),
    query('SELECT trang_thai, count(*)::int AS n FROM tem GROUP BY trang_thai'),
    query("SELECT count(*)::int AS n FROM tem_xe_phoi WHERE trang_thai='DANG_PHOI'"),
    query('SELECT trang_thai, count(*)::int AS n FROM giao_hang GROUP BY trang_thai'),
    query("SELECT COALESCE(SUM(gt.so_luong_giao),0)::int AS n FROM giao_hang_tem gt JOIN giao_hang gh ON gh.id=gt.giao_hang_id WHERE gh.trang_thai='DA_GIAO'"),
    query('SELECT count(*)::int AS n FROM kcs'),
    query("SELECT count(*) FILTER (WHERE ket_qua='DAT')::int AS dat, count(*) FILTER (WHERE ket_qua='KHONG_DAT')::int AS khong_dat FROM oqc"),
    query("SELECT count(*)::int AS n FROM nghen WHERE trang_thai='DANG_NGHEN'"),
  ]);

  return {
    don_hang: { total: donHang.rows[0].n, by_trang_thai: groupMap(donHangTT.rows, 'trang_thai') },
    phan_in: phanIn.rows[0],
    lenh: groupMap(lenhTT.rows, 'trang_thai'),
    tem: groupMap(temTT.rows, 'trang_thai'),
    xe_phoi: { dang_phoi: xePhoi.rows[0].n },
    giao_hang: { by_trang_thai: groupMap(giaoHangTT.rows, 'trang_thai'), tong_sl_da_giao: giaoSl.rows[0].n },
    chat_luong: { so_kcs: kcs.rows[0].n, oqc_dat: oqc.rows[0].dat, oqc_khong_dat: oqc.rows[0].khong_dat },
    nghen: { dang_nghen: nghen.rows[0].n },
  };
}

async function activity(limit = 12) {
  const { rows } = await query(
    `SELECT lst.id, lst.ly_do, lst.tg_thuc_hien,
            tt.ten_trang_thai AS trang_thai_moi, u.ho_ten AS nguoi
     FROM lich_su_trang_thai lst
     LEFT JOIN trang_thai tt ON tt.id = lst.trang_thai_moi_id
     LEFT JOIN nguoi_dung u ON u.id = lst.nguoi_thuc_hien_id
     ORDER BY lst.tg_thuc_hien DESC NULLS LAST, lst.created_date DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

// ============ ĐẾM THEO GIAI ĐOẠN (cho Dashboard) ============
// Đơn vị = đợt vải, nhưng GIAI ĐOẠN suy ra TỪ TRẠNG THÁI RUNTIME (lệnh/tem/ket_qua_checkpoint) —
// KHÔNG phụ thuộc ton_tram (029) để tránh lệch khi ton_tram chưa đồng bộ. Nhất quán với màn Đơn hàng.
// Một phần in có thể ở nhiều giai đoạn (nhiều đợt vải rải rác) → đếm distinct phần in / mã hàng theo từng giai đoạn.
async function stageCounts() {
  // tem cùng lệnh của đợt vải: EXISTS (phiếu → tem) theo trạng thái.
  const temEx = (cond) => `EXISTS (SELECT 1 FROM phieu_san_xuat ps JOIN tem t ON t.phieu_san_xuat_id = ps.id
    WHERE ps.lenh_san_xuat_id = lk.lenh_id AND t.trang_thai <> 'HUY' AND ${cond})`;
  const stageSql = `
    WITH dv AS (
      SELECT d.id AS dot_vai_id, d.phan_in_id, pi.ma_hang_id
      FROM dot_vai_ve d
      JOIN phan_in pi ON pi.id = d.phan_in_id
      JOIN ma_hang mh ON mh.id = pi.ma_hang_id
      JOIN don_hang dh ON dh.id = mh.don_hang_id AND dh.trang_thai IS DISTINCT FROM 'CLOSED_FINANCE'
    ),
    lk AS (
      SELECT DISTINCT ON (lsd.dot_vai_ve_id) lsd.dot_vai_ve_id, ls.id AS lenh_id, ls.trang_thai AS lenh_tt
      FROM lenh_sx_dot_vai lsd JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id
      WHERE ls.trang_thai <> 'HUY'
      ORDER BY lsd.dot_vai_ve_id, ls.created_date DESC
    ),
    staged AS (
      SELECT dv.phan_in_id, dv.ma_hang_id,
        CASE
          WHEN lk.lenh_id IS NULL THEN
            CASE
              WHEN EXISTS (SELECT 1 FROM ket_qua_checkpoint k JOIN checkpoint c ON c.id = k.checkpoint_id
                           WHERE k.phan_in_id = dv.phan_in_id AND c.ma_checkpoint = 'QC_XAC_NHAN' AND k.trang_thai = 'DAT') THEN 'RELEASE_1'
              WHEN (SELECT count(*) FROM ket_qua_checkpoint k JOIN checkpoint c ON c.id = k.checkpoint_id
                    WHERE k.phan_in_id = dv.phan_in_id AND c.ma_checkpoint IN ('KHUON','FILM','MUC') AND k.trang_thai = 'DAT') >= 3 THEN 'READY_QA'
              ELSE 'READY_KT'
            END
          WHEN EXISTS (SELECT 1 FROM phieu_san_xuat ps WHERE ps.lenh_san_xuat_id = lk.lenh_id AND ps.trang_thai = 'DANG_CHAY') THEN 'SAN_XUAT'
          WHEN ${temEx("t.trang_thai IN ('IN','DANG_PHOI')")} THEN 'CHO_KHO'
          WHEN ${temEx("t.trang_thai = 'DA_KHO'")} THEN 'KCS'
          WHEN ${temEx("t.trang_thai = 'CHO_SUA'")} THEN 'SUA'
          WHEN ${temEx("t.trang_thai = 'CHO_OQC'")} THEN 'OQC'
          WHEN ${temEx("t.trang_thai = 'OQC_DAT'")} THEN 'DANG_GIAO'
          WHEN ${temEx("t.trang_thai = 'DA_GIAO'")} THEN 'DA_GIAO'
          WHEN lk.lenh_tt = 'RELEASE_2' THEN 'CHO_SAN_XUAT'
          WHEN EXISTS (SELECT 1 FROM ket_qua_checkpoint k JOIN checkpoint c ON c.id = k.checkpoint_id
                       WHERE k.lenh_san_xuat_id = lk.lenh_id AND c.ma_checkpoint = 'TEST_CNSP' AND k.trang_thai = 'DAT')
               AND EXISTS (SELECT 1 FROM ket_qua_checkpoint k JOIN checkpoint c ON c.id = k.checkpoint_id
                       WHERE k.lenh_san_xuat_id = lk.lenh_id AND c.ma_checkpoint = 'TEST_QA' AND k.trang_thai = 'DAT') THEN 'RELEASE_2'
          WHEN EXISTS (SELECT 1 FROM ket_qua_checkpoint k JOIN checkpoint c ON c.id = k.checkpoint_id
                       WHERE k.lenh_san_xuat_id = lk.lenh_id AND c.ma_checkpoint = 'TEST_CNSP' AND k.trang_thai = 'DAT') THEN 'TESTRUN_QA'
          ELSE 'TESTRUN_CNSP'
        END AS stage
      FROM dv LEFT JOIN lk ON lk.dot_vai_ve_id = dv.dot_vai_id
    )
    SELECT stage, count(DISTINCT phan_in_id)::int AS n_phan_in, count(DISTINCT ma_hang_id)::int AS n_ma
    FROM staged GROUP BY stage`;

  // Tổng pcs đã in theo giai đoạn — tính ở MỨC LỆNH (tránh nhân đôi khi gom set nhiều đợt vải chung 1 lệnh).
  const temEx2 = (cond) => `EXISTS (SELECT 1 FROM phieu_san_xuat ps JOIN tem t ON t.phieu_san_xuat_id=ps.id WHERE ps.lenh_san_xuat_id=ls.id AND t.trang_thai<>'HUY' AND ${cond})`;
  const pcsSql = `
    SELECT stage, COALESCE(SUM(pcs),0)::int AS pcs FROM (
      SELECT ls.id,
        CASE
          WHEN EXISTS (SELECT 1 FROM phieu_san_xuat ps WHERE ps.lenh_san_xuat_id=ls.id AND ps.trang_thai='DANG_CHAY') THEN 'SAN_XUAT'
          WHEN ${temEx2("t.trang_thai IN ('IN','DANG_PHOI')")} THEN 'CHO_KHO'
          WHEN ${temEx2("t.trang_thai = 'DA_KHO'")} THEN 'KCS'
          WHEN ${temEx2("t.trang_thai = 'CHO_SUA'")} THEN 'SUA'
          WHEN ${temEx2("t.trang_thai = 'CHO_OQC'")} THEN 'OQC'
          WHEN ${temEx2("t.trang_thai = 'OQC_DAT'")} THEN 'DANG_GIAO'
          WHEN ${temEx2("t.trang_thai = 'DA_GIAO'")} THEN 'DA_GIAO'
          ELSE NULL
        END AS stage,
        COALESCE((SELECT SUM(t.so_luong) FROM phieu_san_xuat ps JOIN tem t ON t.phieu_san_xuat_id=ps.id WHERE ps.lenh_san_xuat_id=ls.id AND t.trang_thai<>'HUY'),0) AS pcs
      FROM lenh_san_xuat ls
      WHERE ls.trang_thai<>'HUY' AND EXISTS (SELECT 1 FROM phieu_san_xuat ps WHERE ps.lenh_san_xuat_id=ls.id)
    ) x WHERE stage IS NOT NULL GROUP BY stage`;

  // Số lượng TEM đang ở các giai đoạn theo tem (Chờ khô / KCS / Sửa) — đếm tem theo trạng thái thực tế.
  const temCountSql = `
    SELECT
      count(*) FILTER (WHERE t.trang_thai IN ('IN','DANG_PHOI'))::int AS cho_kho,
      count(*) FILTER (WHERE t.trang_thai = 'DA_KHO')::int AS kcs,
      count(*) FILTER (WHERE t.trang_thai = 'CHO_SUA')::int AS sua
    FROM tem t
    JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
    JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id AND ls.trang_thai <> 'HUY'
    WHERE t.trang_thai <> 'HUY'`;

  const [stageRows, totals, pcsRows, temRows] = await Promise.all([
    query(stageSql.replace(/\s+/g, ' ')),
    query(`SELECT
              (SELECT count(*) FROM don_hang WHERE trang_thai IS DISTINCT FROM 'CLOSED_FINANCE')::int AS so_don,
              (SELECT count(*) FROM ma_hang)::int AS so_ma,
              (SELECT count(*) FROM phan_in)::int AS so_phan_in`.replace(/\s+/g, ' ')),
    query(pcsSql.replace(/\s+/g, ' ')),
    query(temCountSql.replace(/\s+/g, ' ')),
  ]);
  const stages = {};
  stageRows.rows.forEach((r) => { stages[r.stage] = { phan_in: r.n_phan_in, ma: r.n_ma, pcs: 0 }; });
  pcsRows.rows.forEach((r) => {
    stages[r.stage] = stages[r.stage] || { phan_in: 0, ma: 0, pcs: 0 };
    stages[r.stage].pcs = r.pcs;
  });
  // Gắn số tem cho các giai đoạn tem (Chờ khô / KCS / Sửa).
  const tc = temRows.rows[0] || {};
  const setTem = (stage, n) => {
    stages[stage] = stages[stage] || { phan_in: 0, ma: 0, pcs: 0 };
    stages[stage].so_tem = n;
  };
  setTem('CHO_KHO', tc.cho_kho || 0);
  setTem('KCS', tc.kcs || 0);
  setTem('SUA', tc.sua || 0);
  return { totals: totals.rows[0], stages };
}

// ============ KIOSK: TÌNH TRẠNG ĐƠN HÀNG THEO TRẠM ============

// Các đợt vải đang trong dòng chảy (chưa CLOSED_FINANCE) — rows để tính tổng quan + danh sách nghẽn.
async function tinhTrangActiveRows() {
  const { rows } = await query(
    `SELECT dv.phan_in_id, tr.ma_tram, tr.ten_tram,
            tr.thoi_gian_quy_dinh_phut AS sla_phut, tr.canh_bao_truoc_phut,
            floor(EXTRACT(EPOCH FROM (now() - tt.tg_vao)) / 60)::int AS phut_da_o,
            pi.ma_phan, pi.mau_vai, pi.kich_vai, pi.kich_phim,
            mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang
     FROM ton_tram tt JOIN tram tr ON tr.id = tt.tram_id
     JOIN dot_vai_ve dv ON dv.id = tt.dot_vai_ve_id
     JOIN phan_in pi ON pi.id = dv.phan_in_id
     JOIN ma_hang mh ON mh.id = pi.ma_hang_id
     JOIN don_hang dh ON dh.id = mh.don_hang_id
     JOIN khach_hang kh ON kh.id = dh.khach_hang_id
     WHERE tt.dot_vai_ve_id IS NOT NULL AND tr.ma_tram <> 'CLOSED_FINANCE'`.replace(/\s+/g, ' ')
  );
  return rows;
}

// Danh sách phần in đang trong dòng chảy (để xoay vòng trên kiosk), lọc theo tìm kiếm.
async function tinhTrangPhanInList(search = '') {
  const { rows } = await query(
    `SELECT DISTINCT pi.id, pi.ma_phan, pi.mau_vai, pi.kich_vai, pi.kich_phim,
            mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang
     FROM ton_tram tt JOIN dot_vai_ve dv ON dv.id = tt.dot_vai_ve_id
     JOIN tram tr ON tr.id = tt.tram_id
     JOIN phan_in pi ON pi.id = dv.phan_in_id
     JOIN ma_hang mh ON mh.id = pi.ma_hang_id
     JOIN don_hang dh ON dh.id = mh.don_hang_id
     JOIN khach_hang kh ON kh.id = dh.khach_hang_id
     WHERE tr.ma_tram <> 'CLOSED_FINANCE'
       AND ($1 = '' OR pi.ma_phan ILIKE '%'||$1||'%' OR dh.ma_don_hang ILIKE '%'||$1||'%'
            OR mh.ma_hang ILIKE '%'||$1||'%' OR pi.mau_vai ILIKE '%'||$1||'%'
            OR pi.kich_vai ILIKE '%'||$1||'%' OR pi.kich_phim ILIKE '%'||$1||'%')
     ORDER BY pi.ma_phan`.replace(/\s+/g, ' '),
    [search]
  );
  return rows;
}

// Đồ thị dòng chảy phân nhánh của 1 phần in: đợt vải → tem → nhánh KCS/Sửa/OQC.
async function tinhTrangDetail(phanInId) {
  const info = (await query(
    `SELECT pi.id, pi.ma_phan, pi.mau_vai, pi.kich_vai, pi.kich_phim,
            mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang
     FROM phan_in pi JOIN ma_hang mh ON mh.id = pi.ma_hang_id
     JOIN don_hang dh ON dh.id = mh.don_hang_id
     JOIN khach_hang kh ON kh.id = dh.khach_hang_id
     WHERE pi.id = $1`.replace(/\s+/g, ' '),
    [phanInId]
  )).rows[0];
  if (!info) return null;

  const dotVai = (await query(
    `SELECT dv.id, dv.ma_dot_vai, dv.so_luong_vai_ve, dv.han_giao_hang,
            tr.ma_tram AS cur_ma_tram, tr.ten_tram AS cur_ten_tram, tt.tg_vao AS cur_tg_vao,
            tr.thoi_gian_quy_dinh_phut AS cur_sla, tr.canh_bao_truoc_phut AS cur_cb
     FROM dot_vai_ve dv
     LEFT JOIN ton_tram tt ON tt.dot_vai_ve_id = dv.id
     LEFT JOIN tram tr ON tr.id = tt.tram_id
     WHERE dv.phan_in_id = $1 ORDER BY dv.ma_dot_vai`.replace(/\s+/g, ' '),
    [phanInId]
  )).rows;
  const dotIds = dotVai.map((d) => d.id);

  const timelines = dotIds.length ? (await query(
    `SELECT ls.dot_vai_ve_id, ls.tg_bd, ls.tg_kt, ls.so_luong,
            t1.ten_tram AS tu_ten, t2.ma_tram AS den_tram, t2.ten_tram AS den_ten,
            u.ho_ten AS nguoi,
            CASE WHEN ls.tg_bd IS NOT NULL AND ls.tg_kt IS NOT NULL
                 THEN floor(EXTRACT(EPOCH FROM (ls.tg_kt - ls.tg_bd)) / 60)::int END AS phut
     FROM lich_su_luan_chuyen ls
     LEFT JOIN tram t1 ON t1.id = ls.tu_tram_id
     LEFT JOIN tram t2 ON t2.id = ls.den_tram_id
     LEFT JOIN nguoi_dung u ON u.id = ls.created_by
     WHERE ls.dot_vai_ve_id = ANY($1::uuid[])
     ORDER BY ls.tg_kt NULLS LAST, ls.created_date`.replace(/\s+/g, ' '),
    [dotIds]
  )).rows : [];

  const tems = dotIds.length ? (await query(
    `SELECT lsd.dot_vai_ve_id, t.id AS tem_id, t.ma_tem, t.so_luong, t.trang_thai,
            k.ket_qua AS kcs_ket_qua, k.so_luong_dat AS kcs_dat, k.so_luong_loi AS kcs_loi,
            ku.ho_ten AS kcs_nguoi, k.created_date AS kcs_tg,
            s.so_luong_sua_dat AS sua_dat, su.ho_ten AS sua_nguoi, s.created_date AS sua_tg,
            o.ket_qua AS oqc_ket_qua, o.cho_giao AS oqc_cho_giao, ou.ho_ten AS oqc_nguoi, o.created_date AS oqc_tg
     FROM lenh_sx_dot_vai lsd
     JOIN phieu_san_xuat ps ON ps.lenh_san_xuat_id = lsd.lenh_san_xuat_id
     JOIN tem t ON t.phieu_san_xuat_id = ps.id
     LEFT JOIN LATERAL (SELECT ket_qua, so_luong_dat, so_luong_loi, created_by, created_date FROM kcs WHERE tem_id = t.id ORDER BY created_date DESC LIMIT 1) k ON true
     LEFT JOIN nguoi_dung ku ON ku.id = k.created_by
     LEFT JOIN LATERAL (SELECT so_luong_sua_dat, created_by, created_date FROM sua WHERE tem_id = t.id ORDER BY created_date DESC LIMIT 1) s ON true
     LEFT JOIN nguoi_dung su ON su.id = s.created_by
     LEFT JOIN LATERAL (SELECT ket_qua, cho_giao, created_by, created_date FROM oqc WHERE tem_id = t.id ORDER BY created_date DESC LIMIT 1) o ON true
     LEFT JOIN nguoi_dung ou ON ou.id = o.created_by
     WHERE lsd.dot_vai_ve_id = ANY($1::uuid[]) AND t.trang_thai <> 'HUY'
     ORDER BY t.ma_tem`.replace(/\s+/g, ' '),
    [dotIds]
  )).rows : [];

  const tlByDot = {}; timelines.forEach((t) => { (tlByDot[t.dot_vai_ve_id] = tlByDot[t.dot_vai_ve_id] || []).push(t); });
  const temByDot = {}; tems.forEach((t) => { (temByDot[t.dot_vai_ve_id] = temByDot[t.dot_vai_ve_id] || []).push(t); });

  // Tổng hợp số lượng theo tem (hợp nhất theo phần in) — pcs / đạt / sửa / sửa đạt.
  const temSummary = (await query(
    `WITH tp AS (
       SELECT tm.id, tm.so_luong, tm.trang_thai FROM tem tm
       JOIN phieu_san_xuat ps ON ps.id=tm.phieu_san_xuat_id
       JOIN lenh_san_xuat ls ON ls.id=ps.lenh_san_xuat_id AND ls.trang_thai<>'HUY'
       JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id=ls.id
       JOIN dot_vai_ve dv ON dv.id=lsd.dot_vai_ve_id AND dv.phan_in_id=$1)
     SELECT COALESCE(SUM(so_luong) FILTER (WHERE trang_thai<>'HUY'),0)::int AS pcs_in,
            count(*) FILTER (WHERE trang_thai<>'HUY')::int AS so_tem,
            (SELECT COALESCE(SUM(so_luong_dat),0)::int FROM kcs k WHERE k.tem_id IN (SELECT id FROM tp)) AS sl_dat,
            (SELECT COALESCE(SUM(GREATEST(so_luong_loi-COALESCE(so_luong_huy,0),0)),0)::int FROM kcs k WHERE k.tem_id IN (SELECT id FROM tp)) AS sl_sua,
            (SELECT COALESCE(SUM(so_luong_sua_dat),0)::int FROM sua s WHERE s.tem_id IN (SELECT id FROM tp)) AS sl_sua_dat
     FROM tp`.replace(/\s+/g, ' '),
    [phanInId]
  )).rows[0];

  return {
    phan_in: info,
    tem_summary: temSummary,
    dot_vai: dotVai.map((d) => ({
      ...d,
      current: d.cur_ma_tram ? {
        ma_tram: d.cur_ma_tram, ten_tram: d.cur_ten_tram, tg_vao: d.cur_tg_vao,
        sla_phut: d.cur_sla, canh_bao_truoc_phut: d.cur_cb,
      } : null,
      timeline: tlByDot[d.id] || [],
      tems: temByDot[d.id] || [],
    })),
  };
}

// ============ DÒNG CHẢY (theo dõi chủ động — migration 029) ============

// Các đợt vải đang ở 1 trạm (ton_tram) + SLA trạm + phần in + owner xử lý.
// tramMa='' → tất cả; luôn loại CLOSED_FINANCE (đã ra khỏi dòng chảy).
// Trạm HIỆN TẠI của mỗi đợt vải suy TRỰC TIẾP từ trạng thái runtime (KHÔNG dùng ton_tram — hay bị kẹt).
// tg_vao = mốc vào trạm hiện tại (xấp xỉ theo nguồn tin cậy nhất của từng giai đoạn) để tính SLA.
async function flowRows(tramMa = '') {
  const sql = `
    WITH dvbase AS (
      SELECT dv.id AS dot_vai_ve_id, dv.phan_in_id, dv.ma_dot_vai, dv.han_giao_hang,
             COALESCE(dv.created_date, dv.ngay_vai_ve::timestamptz) AS dv_tg,
             pi.ma_phan, pi.mau_vai, pi.kich_vai, pi.kich_phim,
             mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang
      FROM dot_vai_ve dv
      JOIN phan_in pi ON pi.id = dv.phan_in_id
      JOIN ma_hang mh ON mh.id = pi.ma_hang_id
      JOIN don_hang dh ON dh.id = mh.don_hang_id AND dh.trang_thai IS DISTINCT FROM 'CLOSED_FINANCE'
      JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    ),
    lk AS (
      SELECT DISTINCT ON (lsd.dot_vai_ve_id) lsd.dot_vai_ve_id, ls.id AS lenh_id, ls.trang_thai AS lenh_tt, ls.created_date AS lenh_tg
      FROM lenh_sx_dot_vai lsd JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id
      WHERE ls.trang_thai <> 'HUY'
      ORDER BY lsd.dot_vai_ve_id, ls.created_date DESC
    ),
    ph AS (
      SELECT lk.dot_vai_ve_id, min(ps.tg_bd) AS phieu_tg, bool_or(ps.trang_thai='DANG_CHAY') AS co_chay
      FROM lk JOIN phieu_san_xuat ps ON ps.lenh_san_xuat_id = lk.lenh_id
      GROUP BY lk.dot_vai_ve_id
    ),
    ta AS (
      SELECT lk.dot_vai_ve_id,
             COALESCE(SUM(t.so_luong) FILTER (WHERE t.trang_thai<>'HUY'),0)::int AS pcs,
             min(t.created_date) AS tem_tg,
             bool_or(t.trang_thai='DA_GIAO') AS has_giao,
             bool_or(t.trang_thai='OQC_DAT') AS has_oqcdat,
             bool_or(t.trang_thai='CHO_OQC') AS has_choqc,
             bool_or(t.trang_thai='CHO_SUA') AS has_chosua,
             bool_or(t.trang_thai='DA_KHO') AS has_dakho,
             bool_or(t.trang_thai IN ('IN','DANG_PHOI')) AS has_phoi
      FROM lk JOIN phieu_san_xuat ps ON ps.lenh_san_xuat_id = lk.lenh_id
      JOIN tem t ON t.phieu_san_xuat_id = ps.id
      GROUP BY lk.dot_vai_ve_id
    ),
    ev AS (
      SELECT lk.dot_vai_ve_id,
             max(k.created_date) AS kcs_tg, max(s.created_date) AS sua_tg,
             max(o.created_date) AS oqc_tg, max(txp.tg_kt_phoi) AS dry_tg
      FROM lk JOIN phieu_san_xuat ps ON ps.lenh_san_xuat_id = lk.lenh_id
      JOIN tem t ON t.phieu_san_xuat_id = ps.id
      LEFT JOIN kcs k ON k.tem_id = t.id
      LEFT JOIN sua s ON s.tem_id = t.id
      LEFT JOIN oqc o ON o.tem_id = t.id
      LEFT JOIN tem_xe_phoi txp ON txp.tem_id = t.id
      GROUP BY lk.dot_vai_ve_id
    )
    SELECT b.dot_vai_ve_id AS id, b.dot_vai_ve_id,
           b.ma_dot_vai, b.han_giao_hang, b.ma_phan, b.mau_vai, b.kich_vai, b.kich_phim,
           b.ma_hang, b.ma_don_hang, b.ten_khach_hang,
           COALESCE(ta.pcs,0) AS pcs,
           cur.ma_tram, tr.ten_tram, tr.thu_tu,
           tr.thoi_gian_quy_dinh_phut AS sla_phut, tr.canh_bao_truoc_phut,
           tv.tg_vao,
           floor(EXTRACT(EPOCH FROM (now() - tv.tg_vao)) / 60)::int AS phut_da_o,
           NULL::text AS owner_ho_ten
    FROM dvbase b
    LEFT JOIN lk ON lk.dot_vai_ve_id = b.dot_vai_ve_id
    LEFT JOIN ph ON ph.dot_vai_ve_id = b.dot_vai_ve_id
    LEFT JOIN ta ON ta.dot_vai_ve_id = b.dot_vai_ve_id
    LEFT JOIN ev ON ev.dot_vai_ve_id = b.dot_vai_ve_id
    CROSS JOIN LATERAL (SELECT (CASE
        WHEN lk.lenh_id IS NULL THEN (CASE WHEN EXISTS (SELECT 1 FROM ket_qua_checkpoint kq JOIN checkpoint c ON c.id=kq.checkpoint_id WHERE kq.phan_in_id=b.phan_in_id AND c.ma_checkpoint='QC_XAC_NHAN' AND kq.trang_thai='DAT') THEN 'RELEASE_1' ELSE 'READY' END)
        WHEN ph.co_chay THEN 'SAN_XUAT'
        WHEN ta.has_phoi THEN 'CHO_KHO'
        WHEN ta.has_dakho THEN 'KIEM'
        WHEN ta.has_chosua THEN 'SUA'
        WHEN ta.has_choqc THEN 'OQC'
        WHEN ta.has_oqcdat THEN 'FINISH'
        WHEN ta.pcs IS NOT NULL THEN 'DONE_DELIVERY'
        WHEN lk.lenh_tt='RELEASE_2' THEN 'RELEASE_2'
        ELSE 'TEST_RUN'
      END) AS ma_tram) cur
    CROSS JOIN LATERAL (SELECT (CASE cur.ma_tram
        WHEN 'TEST_RUN' THEN lk.lenh_tg
        WHEN 'RELEASE_2' THEN lk.lenh_tg
        WHEN 'SAN_XUAT' THEN ph.phieu_tg
        WHEN 'CHO_KHO' THEN ta.tem_tg
        WHEN 'KIEM' THEN COALESCE(ev.dry_tg, ta.tem_tg)
        WHEN 'SUA' THEN COALESCE(ev.kcs_tg, ta.tem_tg)
        WHEN 'OQC' THEN COALESCE(GREATEST(ev.kcs_tg, ev.sua_tg), ta.tem_tg)
        WHEN 'FINISH' THEN COALESCE(ev.oqc_tg, ta.tem_tg)
        ELSE b.dv_tg
      END) AS tg_vao) tv
    JOIN tram tr ON tr.ma_tram = cur.ma_tram
    JOIN workflow_version wv ON wv.id = tr.workflow_version_id AND wv.la_hien_hanh = true
    WHERE cur.ma_tram <> 'DONE_DELIVERY'
      AND ($1 = '' OR cur.ma_tram = $1)
    ORDER BY tr.thu_tu NULLS LAST, phut_da_o DESC`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [tramMa]);
  return rows;
}

// Timeline dòng chảy của 1 đợt vải + trạm hiện tại.
async function flowTimeline(dotVaiId) {
  const [{ rows: timeline }, { rows: cur }] = await Promise.all([
    query(
      `SELECT ls.id, ls.tg_bd, ls.tg_kt, ls.so_luong,
              t1.ma_tram AS tu_tram, t1.ten_tram AS tu_ten,
              t2.ma_tram AS den_tram, t2.ten_tram AS den_ten,
              CASE WHEN ls.tg_bd IS NOT NULL AND ls.tg_kt IS NOT NULL
                   THEN floor(EXTRACT(EPOCH FROM (ls.tg_kt - ls.tg_bd)) / 60)::int END AS phut
       FROM lich_su_luan_chuyen ls
       LEFT JOIN tram t1 ON t1.id = ls.tu_tram_id
       LEFT JOIN tram t2 ON t2.id = ls.den_tram_id
       WHERE ls.dot_vai_ve_id = $1
       ORDER BY ls.tg_kt NULLS LAST, ls.created_date`.replace(/\s+/g, ' '),
      [dotVaiId]
    ),
    query(
      `SELECT tr.ma_tram, tr.ten_tram, tt.tg_vao, tr.thoi_gian_quy_dinh_phut AS sla_phut,
              tr.canh_bao_truoc_phut,
              floor(EXTRACT(EPOCH FROM (now() - tt.tg_vao)) / 60)::int AS phut_da_o
       FROM ton_tram tt JOIN tram tr ON tr.id = tt.tram_id
       WHERE tt.dot_vai_ve_id = $1`.replace(/\s+/g, ' '),
      [dotVaiId]
    ),
  ]);
  return { timeline, current: cur[0] || null };
}

// Owner cấu hình theo trạm (workflow hiện hành) — gộp tên theo trạm + loại (để hiển thị trên board).
async function tramOwnersActive() {
  const { rows } = await query(
    `SELECT tr.ma_tram, o.loai,
            COALESCE(u.ho_ten, r.ten_role, pb.ten_phong_ban) AS ten
     FROM tram_owner o
     JOIN tram tr ON tr.id = o.tram_id
     JOIN workflow_version wv ON wv.id = tr.workflow_version_id AND wv.la_hien_hanh = true
     LEFT JOIN nguoi_dung u ON u.id = o.user_id
     LEFT JOIN vai_tro r ON r.id = o.role_id
     LEFT JOIN phong_ban pb ON pb.id = o.phong_ban_id
     ORDER BY tr.ma_tram`.replace(/\s+/g, ' ')
  );
  return rows;
}

// Owner cấu hình theo checkpoint (workflow hiện hành) — cho hiển thị "ai cần xử lý" ở các màn checkpoint.
async function checkpointOwnersActive() {
  const { rows } = await query(
    `SELECT cp.ma_checkpoint, o.loai,
            COALESCE(u.ho_ten, r.ten_role, pb.ten_phong_ban) AS ten
     FROM checkpoint_owner o
     JOIN checkpoint cp ON cp.id = o.checkpoint_id
     JOIN tram tr ON tr.id = cp.tram_id
     JOIN workflow_version wv ON wv.id = tr.workflow_version_id AND wv.la_hien_hanh = true
     LEFT JOIN nguoi_dung u ON u.id = o.user_id
     LEFT JOIN vai_tro r ON r.id = o.role_id
     LEFT JOIN phong_ban pb ON pb.id = o.phong_ban_id
     ORDER BY cp.ma_checkpoint`.replace(/\s+/g, ' ')
  );
  return rows;
}

module.exports = {
  summary, activity, stageCounts, flowRows, flowTimeline, tramOwnersActive, checkpointOwnersActive,
  tinhTrangActiveRows, tinhTrangPhanInList, tinhTrangDetail,
};
