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
const VN = "AT TIME ZONE 'Asia/Ho_Chi_Minh'";

// ⚠⚠ 26/10/2026 chiều (người dùng: "lấy theo ngày là ngày in tem"): tập dòng = lệnh có TEM GỐC IN trong khoảng
//   [tuNgay, denNgay] (giờ VN, `tem.created_date` — cùng nghĩa ô "Ngày in tem" của Danh sách tem in; bỏ tem `HT-` của
//   script) — `releaseList(…, 'IN_TEM')`. Các số SL theo KỲ:
//   · SL IN       = tem gốc của CHÍNH lệnh in TRONG kỳ (= Σ cột "In" của Nhật ký in cùng kỳ cho lệnh đó).
//   · SL ĐÃ IN    = tem gốc của phần in in TRƯỚC kỳ (mọi lệnh sống, kể cả chính lệnh — "đã in trước") + tem `HT-` của
//     script "chạy đến giao" tới hết kỳ (tem script không bao giờ vào SL IN ⇒ để ở Đã in, không rơi mất khi kỳ chứa ngày
//     chạy script). `sl_da_in_ht` / `sl_da_giao_ht` = phần do script tạo — FE đánh dấu (ca thật 8A8B 26/10/2026: phần in
//     SL-2608-020-A01-F04-C01 "đã in 304 / đã giao 304" đều là tem `HT-LSX8701` + phiếu `HT-GH-00405` của script 25/10).
//   · SLNV (`slnv_pin`) = vải nhận của CẢ phần in (mọi đợt sống) — CÙNG phạm vi với Đã in / Đã giao (bản đầu dùng vải của
//     đợt trong lệnh ⇒ 64 đứng cạnh "đã in 304", nhìn như sai). Vải của đợt trong lệnh giữ ở `slnv`.
//   · `sl_in_truoc_lenh` = tem của CHÍNH lệnh in trước kỳ ⇒ CL = Tổng + phần này − SL release (= còn thiếu của lệnh).
//   · Vải hư / thiếu = sổ `vai_huy` của lệnh GHI trong kỳ.
async function dsReleaseSx(tuNgay, denNgay) {
  const ngay = tuNgay;
  const den = denNgay || tuNgay;
  const { items } = await planningService.releaseList(tuNgay, 'IN_TEM', den);
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
  const [inTruoc, nvPin, inLenh, vai, ghi, ttLenh] = await Promise.all([
    // Theo cặp (lệnh × phần in): đã in TRƯỚC kỳ (tem gốc) + đã giao của phần in (mọi tem).
    query(
      `WITH p AS (SELECT DISTINCT dv.phan_in_id, ls.id AS lenh_id
                    FROM lenh_san_xuat ls JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
                    JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
                   WHERE ls.trang_thai <> 'HUY' AND dv.phan_in_id = ANY($1::uuid[])),
            t AS (SELECT p.phan_in_id, p.lenh_id,
                         COALESCE(SUM(tm.so_luong) FILTER (WHERE tm.tem_goc_id IS NULL AND ((tm.created_date ${VN})::date < $2::date
                                   OR (tm.ma_tem LIKE 'HT-%' AND (tm.created_date ${VN})::date <= $3::date))), 0) AS da_in,
                         COALESCE(SUM(tm.so_luong) FILTER (WHERE tm.tem_goc_id IS NULL AND tm.ma_tem LIKE 'HT-%'
                                   AND (tm.created_date ${VN})::date <= $3::date), 0) AS da_in_ht,
                         COALESCE(SUM(tm.sl_da_giao), 0) AS da_giao,
                         COALESCE(SUM(tm.sl_da_giao) FILTER (WHERE tm.ma_tem LIKE 'HT-%'), 0) AS da_giao_ht
                    FROM p JOIN phieu_san_xuat ps ON ps.lenh_san_xuat_id = p.lenh_id
                    JOIN tem tm ON tm.phieu_san_xuat_id = ps.id AND tm.trang_thai <> 'HUY'
                   GROUP BY p.phan_in_id, p.lenh_id)
       SELECT phan_in_id, lenh_id, da_in::int, da_in_ht::int, da_giao::int, da_giao_ht::int FROM t`.replace(/\s+/g, ' '),
      [pinIds, ngay, den]
    ),
    // SL NHẬN VẢI của CẢ PHẦN IN (mọi đợt sống) — cùng phạm vi với Đã in / Đã giao (26/10/2026, ca 8A8B).
    query(
      `SELECT dv.phan_in_id, COALESCE(SUM(dv.so_luong_vai_ve), 0)::int AS slnv
         FROM dot_vai_ve dv WHERE dv.phan_in_id = ANY($1::uuid[]) AND dv.trang_thai NOT IN ('DA_HUY', 'DA_GOP')
        GROUP BY 1`.replace(/\s+/g, ' '),
      [pinIds]
    ),
    query(
      `SELECT ps.lenh_san_xuat_id AS lenh_id,
              COALESCE(SUM(tm.so_luong) FILTER (WHERE tm.ma_tem NOT LIKE 'HT-%'
                        AND (tm.created_date ${VN})::date BETWEEN $2::date AND $3::date), 0)::int AS sl_in,
              COALESCE(SUM(tm.so_luong) FILTER (WHERE (tm.created_date ${VN})::date < $2::date
                        OR (tm.ma_tem LIKE 'HT-%' AND (tm.created_date ${VN})::date <= $3::date)), 0)::int AS sl_in_truoc
         FROM phieu_san_xuat ps JOIN tem tm ON tm.phieu_san_xuat_id = ps.id AND tm.trang_thai <> 'HUY' AND tm.tem_goc_id IS NULL
        WHERE ps.lenh_san_xuat_id = ANY($1::uuid[]) GROUP BY 1`.replace(/\s+/g, ' '),
      [lenhIds, ngay, den]
    ),
    query(
      `SELECT COALESCE(vh.lenh_san_xuat_id, ps.lenh_san_xuat_id) AS lenh_id, vh.phan_in_id,
              COALESCE(SUM(vh.so_luong) FILTER (WHERE COALESCE(vh.loai, 'HUY') = 'HUY'), 0)::int AS hu,
              COALESCE(SUM(vh.so_luong) FILTER (WHERE vh.loai = 'THIEU'), 0)::int AS thieu
         FROM vai_huy vh LEFT JOIN phieu_san_xuat ps ON ps.id = vh.phieu_san_xuat_id
        WHERE COALESCE(vh.lenh_san_xuat_id, ps.lenh_san_xuat_id) = ANY($1::uuid[])
          AND (vh.created_date ${VN})::date BETWEEN $2::date AND $3::date GROUP BY 1, 2`.replace(/\s+/g, ' '),
      [lenhIds, ngay, den]
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
    const o = theoPin.get(x.phan_in_id) || { in: 0, giao: 0, inHt: 0, giaoHt: 0, lenh: new Map() };
    o.in += x.da_in; o.giao += x.da_giao; o.inHt += x.da_in_ht; o.giaoHt += x.da_giao_ht; o.lenh.set(x.lenh_id, x.da_in);
    theoPin.set(x.phan_in_id, o);
  });
  const nvMap = new Map(nvPin.rows.map((x) => [x.phan_in_id, x.slnv]));
  const slInLenh = new Map(inLenh.rows.map((x) => [x.lenh_id, x]));
  const ghiMap = new Map(ghi.rows.map((x) => [x.id_ban_ghi, x.gia_tri_moi || {}]));
  const daGhiSlLenh = new Set();
  const out = rows.map((r) => {
    const p = theoPin.get(r.phan_in_id) || { in: 0, giao: 0, inHt: 0, giaoHt: 0, lenh: new Map() };
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
      sl_da_in_truoc: p.in,
      sl_da_giao_pin: p.giao,
      sl_da_in_ht: p.inHt,
      sl_da_giao_ht: p.giaoHt,
      slnv_pin: nvMap.has(r.phan_in_id) ? nvMap.get(r.phan_in_id) : r.slnv,
      sl_in: dau ? ((slInLenh.get(r.lenh_id) || {}).sl_in || 0) : null,
      sl_in_truoc_lenh: dau ? ((slInLenh.get(r.lenh_id) || {}).sl_in_truoc || 0) : null,
      vai_hu: [...vaiPin, ...vaiChung].reduce((a, v) => a + v.hu, 0),
      vai_thieu: [...vaiPin, ...vaiChung].reduce((a, v) => a + v.thieu, 0),
      dm_test: g.dm_test ?? null,
      ghi_chu_sx: g.ghi_chu ?? null,
    };
  });
  return { ngay, den_ngay: den, items: out };
}

// ─── NHẬT KÝ IN (26/10/2026, người dùng gửi mẫu ERP "DANH SÁCH NHẬT KÝ IN Từ ngày … đến ngày …") ─────────────────
// Toggle thứ hai của modal: 1 dòng / TEM GỐC sản xuất in trong kỳ (cùng tập tem của Danh sách release cùng kỳ: sống,
//   không phải tem `HT-`, không phải chuyền gia công), xếp theo giờ in. Cột theo mẫu ERP — nguồn MES:
//   · Số CT = IDMES lượt "Báo ERP mỗi lần in tem" (`erp_ok` = lượt thành công) — MES không có số chứng từ ERP `SF0…`.
//   · Vải hư / thiếu = cùng luật cột "Hủy / Thiếu" của Danh sách tem in (`repo.vaiTemSql`).
//   · Ngày = Ngày CT đã gửi ERP (`gui.Ngayct`), chưa gửi ⇒ ngày ca của tem · Giờ = lúc in tem · Số phút = giờ SX nhập
//     ở ô In tem (KT < BĐ ⇒ qua đêm).
//   · Thời gian kiểm / Ngày XN kiểm / Số CT XN kiểm = lượt KCS (chưa hủy xác nhận) ĐẦU / CUỐI của tem + IDMES kiểm phẩm.
//   · Thông tin phần in lấy phần in ĐẠI DIỆN của lệnh (tem không lưu đợt vải — lệnh gom set cũ chỉ mang phần in đầu).
async function nhatKyIn(tuNgay, denNgay) {
  const repo = require('./production.repository');
  const { nhomCuaLoai, NHOM } = require('../../utils/baoCaoSanXuat');
  const { notCancelledQc } = require('../quality/quality.repository');
  const { soVai, ERP_VAI_LATERAL } = await repo.vaiTemSql();
  const [coTo, coMaLo] = await Promise.all([repo.phieuCoCotToIn(), repo.temCoCot('ma_lo')]);
  const sql = `
    SELECT t.id, t.ma_tem, t.so_luong, t.created_date, t.ma_ngay_ca, to_char(t.ngay_ca, 'YYYY-MM-DD') AS ngay_ca,
           to_char(t.gio_sx_bd, 'HH24:MI') AS gio_sx_bd, to_char(t.gio_sx_kt, 'HH24:MI') AS gio_sx_kt,
           t.btp_truoc, t.btp_cuoi, ${coMaLo ? 't.ma_lo' : 'NULL::text AS ma_lo'},
           ${soVai('HUY', 'Soluongloi')} AS vai_hu, ${soVai('THIEU', 'SOLUONGTHIEU')} AS vai_thieu,
           erpv.id_mes, erpv.erp_ok, erpv.gui->>'Ngayct' AS ngay_ct_erp,
           ls.id AS lenh_id, ls.ma_lenh_san_xuat, cs.ma_chuyen, cs.ten_chuyen, lc.ma_loai AS ma_loai_chuyen,
           ${coTo ? 'ti.ma_to' : 'NULL::text AS ma_to'},
           (SELECT string_agg(DISTINCT pc.tho_in, ', ') FROM phan_cong_san_xuat pc
             WHERE pc.phieu_san_xuat_id = ps.id AND COALESCE(pc.tho_in, '') <> '') AS tho_in,
           info.*,
           (SELECT count(DISTINCT dv2.phan_in_id) FROM lenh_sx_dot_vai l2 JOIN dot_vai_ve dv2 ON dv2.id = l2.dot_vai_ve_id
             WHERE l2.lenh_san_xuat_id = COALESCE(ls.lenh_lien_ket_id, ls.id))::int AS so_phan_in_lenh,
           (SELECT string_agg(DISTINCT g.ma_set, ', ') FROM gom_set g JOIN gom_set_dot_vai gd ON gd.gom_set_id = g.id
              JOIN lenh_sx_dot_vai l3 ON l3.dot_vai_ve_id = gd.dot_vai_ve_id
             WHERE l3.lenh_san_xuat_id = COALESCE(ls.lenh_lien_ket_id, ls.id) AND g.trang_thai <> 'HUY') AS ma_set,
           kk.tg_kiem_dau, kk.tg_kiem_cuoi, kk.id_mes_kiem
      FROM tem t
      JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
      JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
      LEFT JOIN chuyen_san_xuat cs ON cs.id = COALESCE(ps.chuyen_id, ls.chuyen_id)
      LEFT JOIN loai_chuyen lc ON lc.id = cs.loai_chuyen_id
      ${coTo ? 'LEFT JOIN to_in ti ON ti.id = ps.to_in_id' : ''}
      ${ERP_VAI_LATERAL}
      LEFT JOIN LATERAL (
        SELECT kh.ten_khach_hang, dh.ma_don_hang, dh.so_po, dh.ddh_id, mh.ma_hang,
               pin.id AS phan_in_id, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.mau_in, pin.do_in,
               pin.tinh_chat_in, pin.ddh_sub_id, pin.barcode AS barcode_phan_in,
               dv.han_giao_hang, dv.nha_gia_cong, dv.sl_bo_sung_cty, dv.sl_bo_sung_khach, ldv.ten_loai AS loai_dot_vai
          FROM lenh_sx_dot_vai lsd
          JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
          JOIN phan_in pin ON pin.id = dv.phan_in_id
          JOIN ma_hang mh ON mh.id = pin.ma_hang_id
          JOIN don_hang dh ON dh.id = mh.don_hang_id
          JOIN khach_hang kh ON kh.id = dh.khach_hang_id
          LEFT JOIN loai_dot_vai ldv ON ldv.id = dv.loai_dot_vai_id
         WHERE lsd.lenh_san_xuat_id = COALESCE(ls.lenh_lien_ket_id, ls.id)
         ORDER BY pin.ma_phan, dv.ma_dot_vai LIMIT 1
      ) info ON true
      LEFT JOIN LATERAL (
        SELECT min(k.created_date) AS tg_kiem_dau, max(k.created_date) AS tg_kiem_cuoi,
               (SELECT string_agg(DISTINCT a.gia_tri_moi->>'id_mes', ', ') FROM kcs k2
                  JOIN audit_log a ON a.ten_bang = 'kcs' AND a.id_ban_ghi = k2.id::text AND a.hanh_dong = 'ERP_GUI_KIEM_PHAM'
                 WHERE k2.tem_id = t.id AND ${notCancelledQc('k2', 'kcs')}) AS id_mes_kiem
          FROM kcs k WHERE k.tem_id = t.id AND ${notCancelledQc('k', 'kcs')}
      ) kk ON true
     WHERE t.tem_goc_id IS NULL AND t.trang_thai <> 'HUY' AND t.ma_tem NOT LIKE 'HT-%'
       AND COALESCE(lc.ma_loai, '') <> 'GIA_CONG'
       AND (t.created_date ${VN})::date BETWEEN $1::date AND $2::date
     ORDER BY t.created_date, t.ma_tem`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [tuNgay, denNgay || tuNgay]);
  const nhanNhom = new Map(NHOM.map((n) => [n.key, n.label]));
  // KT < BĐ chỉ qua nửa đêm khi mã ca là ca ĐÊM (`C3`/`D2`) — cùng luật `Dengio` gửi ERP (`duLieuGhiInTem`); ca ngày giờ
  //   ngược (nhập sai) ⇒ để trống, không bịa.
  const phut = (bd, kt, maCa) => {
    if (!bd || !kt) return null;
    const m = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
    const d = m(kt) - m(bd);
    if (d >= 0) return d;
    return ['C3', 'D2'].includes(String(maCa || '').slice(-2).toUpperCase()) ? d + 1440 : null;
  };
  // `Ngayct` đã gửi có thể là `YYYY/MM/DD`, `YYYY-MM-DD…Z` (giờ VN dán Z) — chỉ lấy phần ngày.
  const ngayCt = (s) => {
    const m = String(s || '').match(/^(\d{4})[/-](\d{2})[/-](\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  };
  const items = rows.map((r) => ({
    ...r,
    so_phut: phut(r.gio_sx_bd, r.gio_sx_kt, r.ma_ngay_ca),
    ngay_ct: ngayCt(r.ngay_ct_erp) || r.ngay_ca || null,
    day_chuyen: nhanNhom.get(nhomCuaLoai(r.ma_loai_chuyen)) || 'Khác',
  }));
  return { tu_ngay: tuNgay, den_ngay: denNgay || tuNgay, items };
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

module.exports = { dsReleaseSx, nhatKyIn, luuDong, docChuyenThem, luuChuyenThem };
