'use strict';

const { query } = require('../../config/db');
const ordersRepo = require('../orders/orders.repository');
const { dotStageCase, readyFallback, ORDER_SQL_ARRAY } = require('../../utils/stage');

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

// Hoạt động gần đây — GỘP MỌI XÁC NHẬN checkpoint/checklist từ READY → Giao
// (ket_qua_checkpoint READY+Test · Release lệnh · bắt đầu SX · KCS/Sửa/OQC/QC in-line · Giao).
async function activity(limit = 20) {
  const sql = `
    WITH ev AS (
      SELECT COALESCE(k.tg_xac_nhan, k.created_date) AS tg,
             COALESCE(k.nguoi_xac_nhan_id, k.created_by) AS nguoi_id,
             'Xác nhận' AS loai,
             (cp.ten_checkpoint || COALESCE(' · ' || pi.ma_phan, ' · ' || l.ma_lenh_san_xuat, '')) AS mo_ta
      FROM ket_qua_checkpoint k
      JOIN checkpoint cp ON cp.id = k.checkpoint_id
      LEFT JOIN phan_in pi ON pi.id = k.phan_in_id
      LEFT JOIN lenh_san_xuat l ON l.id = k.lenh_san_xuat_id
      WHERE k.trang_thai = 'DAT'
      UNION ALL
      SELECT ls.created_date, ls.created_by, 'Release', ('Release 1 · lệnh ' || ls.ma_lenh_san_xuat)
      FROM lenh_san_xuat ls WHERE ls.trang_thai <> 'HUY'
      UNION ALL
      SELECT a.thoi_gian, a.nguoi_thuc_hien_id, 'Release', ('Release 2 · lệnh ' || l.ma_lenh_san_xuat)
      FROM audit_log a JOIN lenh_san_xuat l ON l.id = a.id_ban_ghi::uuid
      WHERE a.ten_bang = 'lenh_san_xuat' AND a.hanh_dong = 'RELEASE_2'
      UNION ALL
      SELECT ps.created_date, ps.created_by, 'Bắt đầu SX', ('Phiếu ' || ps.ma_phieu_san_xuat)
      FROM phieu_san_xuat ps
      UNION ALL
      SELECT k.created_date, k.created_by, 'KCS', ('Tem ' || t.ma_tem || ' · đạt ' || COALESCE(k.so_luong_dat,0))
      FROM kcs k JOIN tem t ON t.id = k.tem_id
      UNION ALL
      SELECT s.created_date, s.created_by, 'Sửa', ('Tem ' || t.ma_tem || ' · đạt ' || COALESCE(s.so_luong_sua_dat,0))
      FROM sua s JOIN tem t ON t.id = s.tem_id
      UNION ALL
      SELECT o.created_date, o.created_by, 'OQC', ('Tem ' || t.ma_tem || ' · ' || o.ket_qua)
      FROM oqc o JOIN tem t ON t.id = o.tem_id
      UNION ALL
      SELECT q.created_date, q.created_by, 'QC in-line', ('Phiếu ' || ps.ma_phieu_san_xuat || ' · ' || q.ket_qua)
      FROM qc_in_line q JOIN phieu_san_xuat ps ON ps.id = q.phieu_san_xuat_id
      UNION ALL
      SELECT COALESCE(gh.ngay_giao::timestamptz, gh.created_date), gh.created_by, 'Giao', ('Phiếu giao ' || gh.ma_phieu_giao)
      FROM giao_hang gh WHERE gh.trang_thai = 'DA_GIAO'
    )
    SELECT ev.tg, ev.loai, ev.mo_ta, u.ho_ten AS nguoi
    FROM ev LEFT JOIN nguoi_dung u ON u.id = ev.nguoi_id
    ORDER BY ev.tg DESC NULLS LAST
    LIMIT $1`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [limit]);
  return rows.map((r, i) => ({ ...r, id: i }));
}

// Xác nhận HÔM NAY (giờ VN) gộp theo checkpoint/checklist — cho thẻ "Hoàn thành hôm nay".
async function confirmTodayGroups() {
  const sql = `
    WITH ev AS (
      SELECT cp.ten_checkpoint AS nhom, COALESCE(k.tg_xac_nhan, k.created_date) AS tg, COALESCE(k.nguoi_xac_nhan_id, k.created_by) AS nguoi_id
      FROM ket_qua_checkpoint k JOIN checkpoint cp ON cp.id = k.checkpoint_id WHERE k.trang_thai = 'DAT'
      UNION ALL SELECT 'KCS', k.created_date, k.created_by FROM kcs k
      UNION ALL SELECT 'Sửa', s.created_date, s.created_by FROM sua s
      UNION ALL SELECT 'OQC', o.created_date, o.created_by FROM oqc o
      UNION ALL SELECT 'QC in-line', q.created_date, q.created_by FROM qc_in_line q
      UNION ALL SELECT 'Giao', COALESCE(gh.ngay_giao::timestamptz, gh.created_date), gh.created_by FROM giao_hang gh WHERE gh.trang_thai = 'DA_GIAO'
    )
    SELECT e.nhom, count(*)::int AS n, max(e.tg) AS last_tg,
           (array_agg(u.ho_ten ORDER BY e.tg DESC))[1] AS last_nguoi
    FROM ev e LEFT JOIN nguoi_dung u ON u.id = e.nguoi_id
    WHERE (e.tg AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
    GROUP BY e.nhom ORDER BY n DESC`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim());
  return rows;
}

// Chi tiết xác nhận HÔM NAY (giờ VN): mỗi lượt kèm đối tượng (phần in / tem / lệnh / phiếu giao) + người.
// Suy phần in từ 1 tem `t` (tem → phiếu → lệnh → đợt vải → phần in); LIMIT 1 khi gom set nhiều đợt.
const TEM_PIN = `SELECT dv.phan_in_id, pi.ma_phan, pi.mau_vai, mh.ma_hang
  FROM phieu_san_xuat ps
  JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ps.lenh_san_xuat_id
  JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
  JOIN phan_in pi ON pi.id = dv.phan_in_id
  JOIN ma_hang mh ON mh.id = pi.ma_hang_id
  WHERE ps.id = t.phieu_san_xuat_id LIMIT 1`;

async function confirmTodayDetail() {
  const sql = `
    WITH ev AS (
      SELECT cp.ten_checkpoint AS nhom, pi.ma_phan AS doi_tuong, k.phan_in_id, pi.ma_phan,
             pi.mau_vai, mh.ma_hang, COALESCE(k.tg_xac_nhan, k.created_date) AS tg, COALESCE(k.nguoi_xac_nhan_id, k.created_by) AS nguoi_id
      FROM ket_qua_checkpoint k JOIN checkpoint cp ON cp.id = k.checkpoint_id
      JOIN phan_in pi ON pi.id = k.phan_in_id JOIN ma_hang mh ON mh.id = pi.ma_hang_id
      WHERE k.trang_thai = 'DAT' AND k.phan_in_id IS NOT NULL
      UNION ALL
      SELECT cp.ten_checkpoint, l.ma_lenh_san_xuat, lpin.phan_in_id, lpin.ma_phan, lpin.mau_vai, lpin.ma_hang,
             COALESCE(k.tg_xac_nhan, k.created_date), COALESCE(k.nguoi_xac_nhan_id, k.created_by)
      FROM ket_qua_checkpoint k JOIN checkpoint cp ON cp.id = k.checkpoint_id
      JOIN lenh_san_xuat l ON l.id = k.lenh_san_xuat_id
      LEFT JOIN LATERAL (SELECT dv.phan_in_id, pi.ma_phan, pi.mau_vai, mh.ma_hang
        FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
        JOIN phan_in pi ON pi.id = dv.phan_in_id JOIN ma_hang mh ON mh.id = pi.ma_hang_id
        WHERE lsd.lenh_san_xuat_id = l.id LIMIT 1) lpin ON true
      WHERE k.trang_thai = 'DAT' AND k.phan_in_id IS NULL AND k.lenh_san_xuat_id IS NOT NULL
      UNION ALL
      SELECT 'KCS', t.ma_tem, tp.phan_in_id, tp.ma_phan, tp.mau_vai, tp.ma_hang, k.created_date, k.created_by
      FROM kcs k JOIN tem t ON t.id = k.tem_id LEFT JOIN LATERAL (${TEM_PIN}) tp ON true
      UNION ALL
      SELECT 'Sửa', t.ma_tem, tp.phan_in_id, tp.ma_phan, tp.mau_vai, tp.ma_hang, s.created_date, s.created_by
      FROM sua s JOIN tem t ON t.id = s.tem_id LEFT JOIN LATERAL (${TEM_PIN}) tp ON true
      UNION ALL
      SELECT 'OQC', t.ma_tem, tp.phan_in_id, tp.ma_phan, tp.mau_vai, tp.ma_hang, o.created_date, o.created_by
      FROM oqc o JOIN tem t ON t.id = o.tem_id LEFT JOIN LATERAL (${TEM_PIN}) tp ON true
      UNION ALL
      SELECT 'Giao', gh.ma_phieu_giao, ghp.phan_in_id, ghp.ma_phan, ghp.mau_vai, ghp.ma_hang,
             COALESCE(gh.ngay_giao::timestamptz, gh.created_date), gh.created_by
      FROM giao_hang gh
      LEFT JOIN LATERAL (SELECT dv.phan_in_id, pi.ma_phan, pi.mau_vai, mh.ma_hang
        FROM giao_hang_tem ght JOIN tem t ON t.id = ght.tem_id
        JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
        JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ps.lenh_san_xuat_id
        JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
        JOIN phan_in pi ON pi.id = dv.phan_in_id JOIN ma_hang mh ON mh.id = pi.ma_hang_id
        WHERE ght.giao_hang_id = gh.id LIMIT 1) ghp ON true
      WHERE gh.trang_thai = 'DA_GIAO'
      UNION ALL
      SELECT 'Release 1', ls.ma_lenh_san_xuat, lp.phan_in_id, lp.ma_phan, lp.mau_vai, lp.ma_hang, ls.created_date, ls.created_by
      FROM lenh_san_xuat ls
      LEFT JOIN LATERAL (SELECT dv.phan_in_id, pi.ma_phan, pi.mau_vai, mh.ma_hang
        FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
        JOIN phan_in pi ON pi.id = dv.phan_in_id JOIN ma_hang mh ON mh.id = pi.ma_hang_id
        WHERE lsd.lenh_san_xuat_id = ls.id LIMIT 1) lp ON true
      WHERE ls.trang_thai <> 'HUY'
      UNION ALL
      SELECT 'Release 2', l.ma_lenh_san_xuat, lp.phan_in_id, lp.ma_phan, lp.mau_vai, lp.ma_hang, a.thoi_gian, a.nguoi_thuc_hien_id
      FROM audit_log a JOIN lenh_san_xuat l ON l.id = a.id_ban_ghi::uuid
      LEFT JOIN LATERAL (SELECT dv.phan_in_id, pi.ma_phan, pi.mau_vai, mh.ma_hang
        FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
        JOIN phan_in pi ON pi.id = dv.phan_in_id JOIN ma_hang mh ON mh.id = pi.ma_hang_id
        WHERE lsd.lenh_san_xuat_id = l.id LIMIT 1) lp ON true
      WHERE a.ten_bang = 'lenh_san_xuat' AND a.hanh_dong = 'RELEASE_2'
    )
    SELECT ev.nhom, ev.doi_tuong, ev.phan_in_id, ev.ma_phan, ev.mau_vai, ev.ma_hang, ev.tg, u.ho_ten AS nguoi
    FROM ev LEFT JOIN nguoi_dung u ON u.id = ev.nguoi_id
    WHERE (ev.tg AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
    ORDER BY ev.tg DESC`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim());
  return rows;
}

// ============ ĐẾM THEO GIAI ĐOẠN (cho Dashboard) ============
// Đơn vị = đợt vải, nhưng GIAI ĐOẠN suy ra TỪ TRẠNG THÁI RUNTIME (lệnh/tem/ket_qua_checkpoint) —
// KHÔNG phụ thuộc ton_tram (029) để tránh lệch khi ton_tram chưa đồng bộ. Nhất quán với màn Đơn hàng.
// Một phần in có thể ở nhiều giai đoạn (nhiều đợt vải rải rác) → đếm distinct phần in / mã hàng theo từng giai đoạn.
async function stageCounts() {
  // GIAI ĐOẠN DOMINANT mỗi phần in ("mỗi phần in 1 trạm" — utils/stage.js), dùng CHUNG logic với
  // orders.stageCondition ⇒ Σ(phần in mỗi stage) = tổng phần in, khớp mọi danh sách + đường vàng.
  const lenh = (col) => `(SELECT ls.${col} FROM lenh_sx_dot_vai lsd JOIN lenh_san_xuat ls ON ls.id=lsd.lenh_san_xuat_id WHERE lsd.dot_vai_ve_id=d.id AND ls.trang_thai<>'HUY' ORDER BY ls.created_date DESC LIMIT 1)`;
  const DOM_CTE = `
    WITH pin_active AS (
      SELECT pi.id AS phan_in_id, pi.ma_hang_id
      FROM phan_in pi JOIN ma_hang mh ON mh.id = pi.ma_hang_id
      JOIN don_hang dh ON dh.id = mh.don_hang_id AND dh.trang_thai IS DISTINCT FROM 'CLOSED_FINANCE'
      WHERE pi.dang_hoat_dong
    ),
    dvs AS (
      SELECT d.phan_in_id, ${lenh('id')} AS lenh_id, ${lenh('trang_thai')} AS lenh_tt
      FROM dot_vai_ve d JOIN pin_active p ON p.phan_in_id = d.phan_in_id
      WHERE d.trang_thai NOT IN ('DA_GOP','DA_HUY')
    ),
    st AS (SELECT phan_in_id, (${dotStageCase('dvs')}) AS stage FROM dvs),
    rk AS (SELECT phan_in_id, stage, array_position(${ORDER_SQL_ARRAY}, stage) AS rnk FROM st),
    dom AS (
      SELECT DISTINCT ON (p.phan_in_id) p.phan_in_id, p.ma_hang_id,
             COALESCE(r.stage, ${readyFallback('p.phan_in_id')}) AS stage
      FROM pin_active p LEFT JOIN rk r ON r.phan_in_id = p.phan_in_id
      ORDER BY p.phan_in_id, r.rnk ASC NULLS LAST
    )`;
  const stageSql = `${DOM_CTE}
    SELECT stage, count(*)::int AS n_phan_in, count(DISTINCT ma_hang_id)::int AS n_ma
    FROM dom GROUP BY stage`;
  const totalSql = `${DOM_CTE}
    SELECT (SELECT count(*) FROM don_hang WHERE trang_thai IS DISTINCT FROM 'CLOSED_FINANCE')::int AS so_don,
           (SELECT count(DISTINCT ma_hang_id) FROM dom)::int AS so_ma,
           (SELECT count(*) FROM dom)::int AS so_phan_in`;

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
  // Đếm TEM + pcs theo sổ cái (Chờ khô/KCS/Sửa theo trạng thái; OQC/Chờ giao/Đã giao theo con_X) — query nhẹ.
  const temCountSql = `
    SELECT
      count(*) FILTER (WHERE t.trang_thai IN ('IN','DANG_PHOI'))::int AS cho_kho,
      count(*) FILTER (WHERE t.trang_thai = 'DA_KHO')::int AS kcs,
      count(*) FILTER (WHERE t.trang_thai = 'CHO_SUA')::int AS sua,
      count(*) FILTER (WHERE (COALESCE(t.sl_kcs_dat,0)+COALESCE(t.sl_sua_dat,0)) > COALESCE(t.sl_oqc_dat,0))::int AS oqc,
      COALESCE(SUM((COALESCE(t.sl_kcs_dat,0)+COALESCE(t.sl_sua_dat,0)) - COALESCE(t.sl_oqc_dat,0))
               FILTER (WHERE (COALESCE(t.sl_kcs_dat,0)+COALESCE(t.sl_sua_dat,0)) > COALESCE(t.sl_oqc_dat,0)),0)::int AS oqc_pcs,
      count(*) FILTER (WHERE COALESCE(t.sl_oqc_dat,0) > COALESCE(t.sl_da_giao,0))::int AS dg_tem,
      COALESCE(SUM(COALESCE(t.sl_oqc_dat,0)-COALESCE(t.sl_da_giao,0)) FILTER (WHERE COALESCE(t.sl_oqc_dat,0) > COALESCE(t.sl_da_giao,0)),0)::int AS dg_pcs,
      count(*) FILTER (WHERE COALESCE(t.sl_da_giao,0) > 0 AND COALESCE(t.sl_oqc_dat,0) = COALESCE(t.sl_da_giao,0))::int AS gd_tem,
      COALESCE(SUM(COALESCE(t.sl_da_giao,0)),0)::int AS gd_pcs
    FROM tem t
    JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
    JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id AND ls.trang_thai <> 'HUY'
    WHERE t.trang_thai <> 'HUY'`;

  const [stageRows, totals, pcsRows, temRows] = await Promise.all([
    query(stageSql.replace(/\s+/g, ' ')),
    query(totalSql.replace(/\s+/g, ' ')),
    query(pcsSql.replace(/\s+/g, ' ')),
    query(temCountSql.replace(/\s+/g, ' ')),
  ]);
  const stages = {};
  stageRows.rows.forEach((r) => { stages[r.stage] = { phan_in: r.n_phan_in, ma: r.n_ma, pcs: 0 }; });
  pcsRows.rows.forEach((r) => {
    stages[r.stage] = stages[r.stage] || { phan_in: 0, ma: 0, pcs: 0 };
    stages[r.stage].pcs = r.pcs;
  });
  // Gắn số TEM/pcs (sổ cái tem) cho các giai đoạn tem — số PHẦN IN/MÃ giữ nguyên theo DOMINANT (dom).
  const tc = temRows.rows[0] || {};
  const setTem = (stage, n) => {
    stages[stage] = stages[stage] || { phan_in: 0, ma: 0, pcs: 0 };
    stages[stage].so_tem = n;
  };
  setTem('CHO_KHO', tc.cho_kho || 0);
  setTem('KCS', tc.kcs || 0);
  setTem('SUA', tc.sua || 0);
  setTem('OQC', tc.oqc || 0);
  if (stages.OQC) stages.OQC.pcs = tc.oqc_pcs || 0;
  // GIAO: số PHẦN IN/MÃ theo DOMINANT (đã có trong stages.DANG_GIAO/DA_GIAO); chỉ overlay TEM/PCS theo sổ cái tem.
  stages.DANG_GIAO = stages.DANG_GIAO || { phan_in: 0, ma: 0, pcs: 0 };
  stages.DA_GIAO = stages.DA_GIAO || { phan_in: 0, ma: 0, pcs: 0 };
  stages.DANG_GIAO.so_tem = tc.dg_tem || 0; stages.DANG_GIAO.pcs = tc.dg_pcs || 0;
  stages.DA_GIAO.so_tem = tc.gd_tem || 0; stages.DA_GIAO.pcs = tc.gd_pcs || 0;
  return { totals: totals.rows[0], stages };
}

// Chi tiết biểu đồ: OQC (pcs sổ cái tem theo nguồn KCS/Sửa) + READY (phần in chưa release, đã xác nhận từng mục).
async function chartDetail() {
  // OQC: chờ = tem đã tới OQC chưa kiểm (con_oqc); đã xác nhận = đã qua OQC (sổ cái sl_oqc_dat) — tách nguồn KCS(15-)/Sửa(17-).
  const oqcSql = `SELECT
      COALESCE(SUM(GREATEST(COALESCE(t.sl_kcs_dat,0) - (COALESCE(t.sl_oqc_dat,0) - COALESCE(t.sl_oqc_dat_sua,0)),0)),0)::int AS kcs_cho,
      COALESCE(SUM(GREATEST(COALESCE(t.sl_oqc_dat,0) - COALESCE(t.sl_oqc_dat_sua,0),0)),0)::int AS kcs_dat,
      COALESCE(SUM(GREATEST(COALESCE(t.sl_sua_dat,0) - COALESCE(t.sl_oqc_dat_sua,0),0)),0)::int AS sua_cho,
      COALESCE(SUM(COALESCE(t.sl_oqc_dat_sua,0)),0)::int AS sua_dat,
      COALESCE(SUM(COALESCE(t.sl_oqc_dat,0)),0)::int AS tong_dat
    FROM tem t JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
    JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id AND ls.trang_thai <> 'HUY'
    WHERE t.trang_thai <> 'HUY'`;
  let oqc;
  try {
    const { rows } = await query(oqcSql.replace(/\s+/g, ' '));
    const r = rows[0] || {};
    oqc = { kcs_cho: r.kcs_cho || 0, kcs_dat: r.kcs_dat || 0, sua_cho: r.sua_cho || 0, sua_dat: r.sua_dat || 0,
            tong_cho: (r.kcs_cho || 0) + (r.sua_cho || 0), tong_dat: r.tong_dat || 0 };
  } catch (e) {
    // Chưa chạy mig 047 (thiếu sl_oqc_dat_sua) → gộp chung nguồn.
    const fb = `SELECT
        COALESCE(SUM(GREATEST((COALESCE(t.sl_kcs_dat,0)+COALESCE(t.sl_sua_dat,0)) - COALESCE(t.sl_oqc_dat,0),0)),0)::int AS tong_cho,
        COALESCE(SUM(COALESCE(t.sl_oqc_dat,0)),0)::int AS tong_dat
      FROM tem t JOIN phieu_san_xuat ps ON ps.id=t.phieu_san_xuat_id
      JOIN lenh_san_xuat ls ON ls.id=ps.lenh_san_xuat_id AND ls.trang_thai<>'HUY' WHERE t.trang_thai<>'HUY'`;
    const { rows } = await query(fb.replace(/\s+/g, ' '));
    const r = rows[0] || {};
    oqc = { kcs_cho: r.tong_cho || 0, kcs_dat: r.tong_dat || 0, sua_cho: 0, sua_dat: 0, tong_cho: r.tong_cho || 0, tong_dat: r.tong_dat || 0 };
  }

  // READY: pool = phần in CHƯA release (chưa vào lệnh ≠ HUY). tong = pool; *_dat = số đã xác nhận từng mục.
  const done = (ma) => `EXISTS (SELECT 1 FROM ket_qua_checkpoint k JOIN checkpoint c ON c.id=k.checkpoint_id WHERE k.phan_in_id=pin.id AND c.ma_checkpoint='${ma}' AND k.trang_thai='DAT')`;
  const readySql = `SELECT count(*)::int AS tong,
      count(*) FILTER (WHERE khuon)::int AS khuon_dat,
      count(*) FILTER (WHERE film)::int AS film_dat,
      count(*) FILTER (WHERE muc)::int AS muc_dat,
      count(*) FILTER (WHERE qc)::int AS qc_dat
    FROM (
      SELECT ${done('KHUON')} AS khuon, ${done('FILM')} AS film, ${done('MUC')} AS muc, ${done('QC_XAC_NHAN')} AS qc
      FROM phan_in pin
      WHERE NOT EXISTS (SELECT 1 FROM dot_vai_ve dvr JOIN lenh_sx_dot_vai lsr ON lsr.dot_vai_ve_id=dvr.id
                        JOIN lenh_san_xuat lr ON lr.id=lsr.lenh_san_xuat_id
                        WHERE dvr.phan_in_id=pin.id AND lr.trang_thai<>'HUY')
    ) q`;
  const { rows: rr } = await query(readySql.replace(/\s+/g, ' '));
  const r = rr[0] || {};
  const ready = { tong: r.tong || 0, KHUON: r.khuon_dat || 0, FILM: r.film_dat || 0, MUC: r.muc_dat || 0, QA: r.qc_dat || 0 };

  // Đã xác nhận tại trạm & CHƯA GIAO: phần in đã qua/xác nhận từng trạm mà phần in đó chưa giao xong.
  const chain = `dot_vai_ve dvv JOIN lenh_sx_dot_vai lsdd ON lsdd.dot_vai_ve_id=dvv.id JOIN phieu_san_xuat pss ON pss.lenh_san_xuat_id=lsdd.lenh_san_xuat_id JOIN tem tt ON tt.phieu_san_xuat_id=pss.id`;
  // Chưa giao xong = phần in KHÔNG ở trạng thái "mọi tem đã giao" (chưa có tem hoặc còn tem chưa DA_GIAO).
  const notDelivered = `NOT (EXISTS(SELECT 1 FROM ${chain} WHERE dvv.phan_in_id=pin.id AND tt.trang_thai<>'HUY') AND NOT EXISTS(SELECT 1 FROM ${chain} WHERE dvv.phan_in_id=pin.id AND tt.trang_thai NOT IN ('DA_GIAO','HUY')))`;
  const hasLenh = `EXISTS(SELECT 1 FROM dot_vai_ve dv2 JOIN lenh_sx_dot_vai ls2 ON ls2.dot_vai_ve_id=dv2.id JOIN lenh_san_xuat l2 ON l2.id=ls2.lenh_san_xuat_id WHERE dv2.phan_in_id=pin.id`;
  const pReady = `EXISTS(SELECT 1 FROM ket_qua_checkpoint k JOIN checkpoint c ON c.id=k.checkpoint_id WHERE k.phan_in_id=pin.id AND c.ma_checkpoint='QC_XAC_NHAN' AND k.trang_thai='DAT')`;
  const pRel1 = `${hasLenh} AND l2.trang_thai<>'HUY')`;
  const pTest = `EXISTS(SELECT 1 FROM dot_vai_ve dv2 JOIN lenh_sx_dot_vai ls2 ON ls2.dot_vai_ve_id=dv2.id JOIN ket_qua_checkpoint k ON k.lenh_san_xuat_id=ls2.lenh_san_xuat_id JOIN checkpoint c ON c.id=k.checkpoint_id WHERE dv2.phan_in_id=pin.id AND c.ma_checkpoint='TEST_QA' AND k.trang_thai='DAT')`;
  const pSanXuat = `EXISTS(SELECT 1 FROM ${chain} WHERE dvv.phan_in_id=pin.id AND tt.trang_thai<>'HUY')`;
  const pRel2 = `(${hasLenh} AND l2.trang_thai IN ('RELEASE_2','SAN_XUAT')) OR ${pSanXuat})`;
  const pOqc = `EXISTS(SELECT 1 FROM ${chain} JOIN oqc oo ON oo.tem_id=tt.id WHERE dvv.phan_in_id=pin.id)`;
  const pGiao = `EXISTS(SELECT 1 FROM ${chain} WHERE dvv.phan_in_id=pin.id AND tt.trang_thai IN ('OQC_DAT','DA_GIAO'))`;
  const scSql = `SELECT
      count(*) FILTER (WHERE ready)::int AS ready, count(*) FILTER (WHERE release_1)::int AS release_1,
      count(*) FILTER (WHERE test)::int AS test, count(*) FILTER (WHERE release_2)::int AS release_2,
      count(*) FILTER (WHERE san_xuat)::int AS san_xuat,
      count(*) FILTER (WHERE oqc)::int AS oqc, count(*) FILTER (WHERE giao)::int AS giao
    FROM (
      SELECT ${pReady} AS ready, ${pRel1} AS release_1, ${pTest} AS test, ${pRel2} AS release_2,
             ${pSanXuat} AS san_xuat, ${pOqc} AS oqc, ${pGiao} AS giao
      FROM phan_in pin WHERE ${notDelivered}
    ) q`;
  let station_confirmed = { ready: 0, release_1: 0, test: 0, release_2: 0, san_xuat: 0, oqc: 0, giao: 0 };
  try {
    const { rows: scr } = await query(scSql.replace(/\s+/g, ' '));
    if (scr[0]) station_confirmed = scr[0];
  } catch (e) { /* query nặng bị reset → giữ 0, không phá OQC/READY */ }

  return { oqc, ready, station_confirmed };
}

// Đếm cho Bảng điều phối: QC trả về chưa xử lý, giao đặc biệt chờ (OQC không đạt chưa cho giao), chuyền đang chạy/tổng.
async function dieuPhoiExtra() {
  const sql = `SELECT
      (SELECT count(*) FROM qc_tra_ve WHERE da_xu_ly = false)::int AS qc_tra_ve,
      (SELECT count(*) FROM tem t WHERE t.trang_thai = 'CHO_OQC'
         AND EXISTS (SELECT 1 FROM oqc o WHERE o.tem_id = t.id AND o.ket_qua = 'KHONG_DAT' AND COALESCE(o.cho_giao,false) = false))::int AS oqc_khong_dat,
      (SELECT count(DISTINCT ps.chuyen_id) FROM phieu_san_xuat ps WHERE ps.trang_thai = 'DANG_CHAY' AND ps.chuyen_id IS NOT NULL)::int AS chuyen_dang_chay,
      (SELECT count(*) FROM chuyen_san_xuat WHERE COALESCE(dang_hoat_dong,true) = true)::int AS chuyen_tong`;
  try {
    const { rows } = await query(sql.replace(/\s+/g, ' '));
    return rows[0] || { qc_tra_ve: 0, oqc_khong_dat: 0, chuyen_dang_chay: 0, chuyen_tong: 0 };
  } catch (e) {
    return { qc_tra_ve: 0, oqc_khong_dat: 0, chuyen_dang_chay: 0, chuyen_tong: 0 };
  }
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

  const [kcsByDot, stagePcs] = await Promise.all([
    ordersRepo.getPhanInKcsByDot(phanInId), ordersRepo.getPhanInStagePcs(phanInId),
  ]);

  return {
    phan_in: info,
    tem_summary: temSummary,
    kcs_by_dot: kcsByDot,
    stage_pcs: stagePcs,
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
    ),
    qc AS (
      SELECT kq.phan_in_id, max(COALESCE(kq.tg_xac_nhan, kq.created_date)) AS qc_tg
      FROM ket_qua_checkpoint kq JOIN checkpoint c ON c.id = kq.checkpoint_id
      WHERE c.ma_checkpoint = 'QC_XAC_NHAN' AND kq.trang_thai = 'DAT'
      GROUP BY kq.phan_in_id
    ),
    kt AS (
      SELECT kq.phan_in_id,
             count(DISTINCT c.ma_checkpoint) FILTER (WHERE kq.trang_thai = 'DAT') AS n_kt,
             max(COALESCE(kq.tg_xac_nhan, kq.created_date)) FILTER (WHERE kq.trang_thai = 'DAT') AS kt_tg
      FROM ket_qua_checkpoint kq JOIN checkpoint c ON c.id = kq.checkpoint_id
      WHERE c.ma_checkpoint IN ('KHUON','FILM','MUC')
      GROUP BY kq.phan_in_id
    ),
    qcp AS (
      SELECT c.thoi_gian_quy_dinh_phut AS sla, c.canh_bao_truoc_phut AS cb
      FROM checkpoint c JOIN tram t ON t.id = c.tram_id
      JOIN workflow_version wv ON wv.id = t.workflow_version_id AND wv.la_hien_hanh = true
      WHERE c.ma_checkpoint = 'QC_XAC_NHAN' LIMIT 1
    )
    SELECT b.dot_vai_ve_id AS id, b.dot_vai_ve_id, b.phan_in_id, lk.lenh_id,
           b.ma_dot_vai, b.han_giao_hang, b.ma_phan, b.mau_vai, b.kich_vai, b.kich_phim,
           b.ma_hang, b.ma_don_hang, b.ten_khach_hang,
           COALESCE(ta.pcs,0) AS pcs,
           cur.ma_tram, tr.ten_tram, tr.thu_tu,
           CASE WHEN cur.ma_tram='READY' AND COALESCE(kt.n_kt,0)>=3 THEN qcp.sla ELSE tr.thoi_gian_quy_dinh_phut END AS sla_phut,
           CASE WHEN cur.ma_tram='READY' AND COALESCE(kt.n_kt,0)>=3 THEN qcp.cb ELSE tr.canh_bao_truoc_phut END AS canh_bao_truoc_phut,
           tv.tg_vao,
           floor(EXTRACT(EPOCH FROM (now() - tv.tg_vao)) / 60)::int AS phut_da_o,
           NULL::text AS owner_ho_ten
    FROM dvbase b
    LEFT JOIN lk ON lk.dot_vai_ve_id = b.dot_vai_ve_id
    LEFT JOIN ph ON ph.dot_vai_ve_id = b.dot_vai_ve_id
    LEFT JOIN ta ON ta.dot_vai_ve_id = b.dot_vai_ve_id
    LEFT JOIN ev ON ev.dot_vai_ve_id = b.dot_vai_ve_id
    LEFT JOIN qc ON qc.phan_in_id = b.phan_in_id
    LEFT JOIN kt ON kt.phan_in_id = b.phan_in_id
    CROSS JOIN qcp
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
        WHEN 'READY' THEN (CASE WHEN COALESCE(kt.n_kt,0)>=3 THEN kt.kt_tg ELSE b.dv_tg END)
        WHEN 'RELEASE_1' THEN COALESCE(qc.qc_tg, b.dv_tg)
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
  summary, activity, stageCounts, chartDetail, dieuPhoiExtra, flowRows, flowTimeline, tramOwnersActive, checkpointOwnersActive,
  tinhTrangActiveRows, tinhTrangPhanInList, tinhTrangDetail, confirmTodayGroups, confirmTodayDetail,
};
