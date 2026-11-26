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
const { chuyenTemSql } = require('../../utils/temChuyen');
const { ngaySxTemSql, temTrongKySql, caTemSql, chuanDsCa, temThuocCaSql } = require('../../utils/ngaySxTem');
const planningService = require('../planning/planning.service');

const KHOA_DONG = 'ds_release_sx';
const KHOA_CHUYEN = 'ds_release_sx_chuyen';
const VN = "AT TIME ZONE 'Asia/Ho_Chi_Minh'";

// ⚠⚠ Tập dòng = lệnh có TEM GỐC thuộc khoảng [tuNgay, denNgay] theo NGÀY SẢN XUẤT của tem = ngày trong MÃ NGÀY CA
//   (ca trước / ca sau — `utils/ngaySxTem.js`, cùng luật Báo cáo sản xuất; bỏ tem `HT-` của script) —
//   `releaseList(…, 'IN_TEM')`. "Trong kỳ" / "trước kỳ" dưới đây đều theo ngày đó. Các số SL theo KỲ:
//   · SL IN       = tem gốc của CHÍNH lệnh in TRONG kỳ (= Σ cột "In" của Nhật ký in cùng kỳ cho lệnh đó).
//   · SL ĐÃ IN    = tem gốc của phần in in TRƯỚC kỳ (mọi lệnh sống, kể cả chính lệnh — "đã in trước") + tem `HT-` của
//     script "chạy đến giao" tới hết kỳ (tem script không bao giờ vào SL IN ⇒ để ở Đã in, không rơi mất khi kỳ chứa ngày
//     chạy script). `sl_da_in_ht` / `sl_da_giao_ht` = phần do script tạo — FE đánh dấu (ca thật 8A8B 26/10/2026: phần in
//     SL-2608-020-A01-F04-C01 "đã in 304 / đã giao 304" đều là tem `HT-LSX8701` + phiếu `HT-GH-00405` của script 25/10).
//   · SLNV (`slnv_pin`) = vải nhận của CẢ phần in (mọi đợt sống) — CÙNG phạm vi với Đã in / Đã giao (bản đầu dùng vải của
//     đợt trong lệnh ⇒ 64 đứng cạnh "đã in 304", nhìn như sai). Vải của đợt trong lệnh giữ ở `slnv`.
//   · `sl_in_truoc_lenh` = tem của CHÍNH lệnh in trước kỳ ⇒ CL = Tổng + phần này − SL release (= còn thiếu của lệnh).
//   · Vải hư / thiếu = sổ `vai_huy` của lệnh thuộc kỳ: dòng gắn tem (mig 118) theo ngày SX của TEM đó, dòng không gắn tem
//     theo lúc ghi (cắt 06:00).
// ⚠⚠ LỌC CA (25/11/2026, người dùng: "bộ lọc cho thêm theo ngày ca / ca"): `ca` = danh sách mã ca của tem (HC · C1 · C2 · C3
//   · D1 · D2 — 2 ký tự cuối mã ngày ca, `utils/ngaySxTem.js`; rỗng = mọi ca). "Kỳ" = ngày SX trong khoảng VÀ ca thuộc danh
//   sách ⇒ dòng chỉ còn lệnh có tem trong kỳ đó; SL IN / bổ sung / vải hư–thiếu (chỉ dòng gắn tem) theo kỳ đó. Tem của chính
//   lệnh cùng khoảng ngày nhưng KHÁC ca cộng vào `sl_in_truoc_lenh` ⇒ CL vẫn là còn thiếu / dư của lệnh tới hết ngày đến.
//   SL ĐÃ IN (mức phần in) vẫn = trước NGÀY đầu kỳ.
// BỔ SUNG (25/11/2026, người dùng gửi mẫu ô vàng IN SL · IN BS · CTY · KH + sheet tổng theo chuyền):
//   · `sl_release_bs` = phần SL release của dòng thuộc đợt loại `BO_SUNG` (Σ `lenh_sx_dot_vai` của lệnh × phần in, kẹp ≤ SL
//     release của dòng) — Release SL = SL release − phần này (FE).
//   · `sl_in_bs_cty` / `sl_in_bs_khach` = Σ SL bổ sung do công ty / khách CỦA TEM (mig 135) của tem trong kỳ — mức LỆNH như
//     `sl_in` (chỉ ở dòng đầu của lệnh). In BS = cty + khách · In SL = SL IN − In BS (FE).
async function dsReleaseSx(tuNgay, denNgay, { ca } = {}) {
  const ngay = tuNgay;
  const den = denNgay || tuNgay;
  const dsCa = chuanDsCa(ca);
  const { items } = await planningService.releaseList(tuNgay, 'IN_TEM', den);
  const NGAY_TM = ngaySxTemSql('tm');
  // ⚠ 26/10/2026 (người dùng: "chỉ lấy những phần đã xác nhận chạy"): giữ lệnh ĐÃ CÓ phiếu Xác nhận chạy (phiếu ≠ HUY —
  //   đang chạy hoặc đã chạy hoàn tất; bỏ phiếu script hệ thống `PHIEU_THAT`, cùng luật Báo cáo sản xuất).
  const { PHIEU_THAT } = require('./baoCaoSanXuat');
  const ungVien = items.filter((r) => String(r.ma_loai_chuyen || '').toUpperCase() !== 'GIA_CONG');
  // Luôn trả `ca` (kể cả rỗng) — FE dựa vào khóa này để biết máy chủ đã có bản lọc ca / bổ sung (25/11) hay chưa.
  if (!ungVien.length) return { ngay, den_ngay: den, ca: dsCa, items: [] };
  const { rows: daChay } = await query(
    `SELECT DISTINCT ps.lenh_san_xuat_id AS id FROM phieu_san_xuat ps
      WHERE ps.lenh_san_xuat_id = ANY($1::uuid[]) AND ps.trang_thai <> 'HUY' AND ${PHIEU_THAT}`.replace(/\s+/g, ' '),
    [[...new Set(ungVien.map((r) => r.lenh_id))]]
  );
  const setChay = new Set(daChay.map((x) => x.id));
  let rows = ungVien.filter((r) => setChay.has(r.lenh_id));
  // Lọc ca: chỉ giữ lệnh có tem gốc sống (không `HT-`) thuộc ngày + ca đang lọc.
  if (rows.length && dsCa.length) {
    const { rows: coTem } = await query(
      `SELECT DISTINCT ps.lenh_san_xuat_id AS id FROM phieu_san_xuat ps
         JOIN tem tm ON tm.phieu_san_xuat_id = ps.id AND tm.trang_thai <> 'HUY' AND tm.tem_goc_id IS NULL
        WHERE ps.lenh_san_xuat_id = ANY($1::uuid[]) AND tm.ma_tem NOT LIKE 'HT-%'
          AND ${temTrongKySql('tm', '$2', '$3')} AND ${temThuocCaSql('tm', '$4')}`.replace(/\s+/g, ' '),
      [[...new Set(rows.map((r) => r.lenh_id))], ngay, den, dsCa]
    );
    const setCa = new Set(coTem.map((x) => x.id));
    rows = rows.filter((r) => setCa.has(r.lenh_id));
  }
  if (!rows.length) return { ngay, den_ngay: den, ca: dsCa, items: [] };
  const lenhIds = [...new Set(rows.map((r) => r.lenh_id))];
  const pinIds = [...new Set(rows.map((r) => r.phan_in_id))];
  const khoa = rows.map((r) => `${r.lenh_id}|${r.phan_in_id}`);
  // TRẠNG THÁI của CHÍNH LỆNH (26/10/2026 — người dùng: "M4 đã xác nhận chạy sao lại Release 1"): `releaseList` trả
  //   giai đoạn CHẬM NHẤT của cả PHẦN IN — phần in còn 1 đợt chưa release thì lệnh đang chạy cũng ghi "Release 1". Ở đây
  //   tính lại bằng CHÍNH `dotStageCase` trên các đợt của ĐÚNG lệnh × phần in (lấy giai đoạn chậm nhất trong các đợt đó).
  const { dotStageCase, ORDER_SQL_ARRAY, STAGE_LABEL } = require('../../utils/stage');
  const L = require('../../utils/luongSanXuat');
  const prodRepo = require('./production.repository');
  const [coVaiTem, coBsTem] = await Promise.all([prodRepo.vaiHuyCoCotTem(), prodRepo.temCoCotBoSung()]);
  // Tem thuộc KỲ đang xem (ngày SX trong khoảng + ca đang lọc) — tham số $2 / $3 / $4 của các câu dưới.
  const TRONG_KY = `${NGAY_TM} BETWEEN $2::date AND $3::date AND ${temThuocCaSql('tm', '$4')}`;
  const [inTruoc, nvPin, inLenh, vai, ghi, ttLenh, pinLuong, relBs] = await Promise.all([
    // Theo cặp (lệnh × phần in): đã in TRƯỚC kỳ (tem gốc) + đã giao của phần in (mọi tem). `gd` = công đoạn của lệnh.
    query(
      `WITH p AS (SELECT DISTINCT dv.phan_in_id, ls.id AS lenh_id, COALESCE(ls.giai_doan, '${L.GD_IN}') AS gd
                    FROM lenh_san_xuat ls JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
                    JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
                   WHERE ls.trang_thai <> 'HUY' AND dv.phan_in_id = ANY($1::uuid[])),
            t AS (SELECT p.phan_in_id, p.lenh_id, p.gd,
                         COALESCE(SUM(tm.so_luong) FILTER (WHERE tm.tem_goc_id IS NULL AND (${NGAY_TM} < $2::date
                                   OR (tm.ma_tem LIKE 'HT-%' AND (tm.created_date ${VN})::date <= $3::date))), 0) AS da_in,
                         COALESCE(SUM(tm.so_luong) FILTER (WHERE tm.tem_goc_id IS NULL AND tm.ma_tem LIKE 'HT-%'
                                   AND (tm.created_date ${VN})::date <= $3::date), 0) AS da_in_ht,
                         COALESCE(SUM(tm.sl_da_giao), 0) AS da_giao,
                         COALESCE(SUM(tm.sl_da_giao) FILTER (WHERE tm.ma_tem LIKE 'HT-%'), 0) AS da_giao_ht
                    FROM p JOIN phieu_san_xuat ps ON ps.lenh_san_xuat_id = p.lenh_id
                    JOIN tem tm ON tm.phieu_san_xuat_id = ps.id AND tm.trang_thai <> 'HUY'
                   GROUP BY p.phan_in_id, p.lenh_id, p.gd)
       SELECT phan_in_id, lenh_id, gd, da_in::int, da_in_ht::int, da_giao::int, da_giao_ht::int FROM t`.replace(/\s+/g, ' '),
      [pinIds, ngay, den]
    ),
    // SL NHẬN VẢI của CẢ PHẦN IN (mọi đợt sống) — cùng phạm vi với Đã in / Đã giao (26/10/2026, ca 8A8B).
    //   `gd_dot` = công đoạn của đợt (kiếng ủi: 4I = In kiếng, đợt khác = Ép; luồng khác NULL = mọi công đoạn).
    query(
      `SELECT dv.phan_in_id, ${L.dotGdSql('dv', 'pin.luong_sx')} AS gd_dot, COALESCE(SUM(dv.so_luong_vai_ve), 0)::int AS slnv
         FROM dot_vai_ve dv JOIN phan_in pin ON pin.id = dv.phan_in_id
        WHERE dv.phan_in_id = ANY($1::uuid[]) AND dv.trang_thai NOT IN ('DA_HUY', 'DA_GOP')
        GROUP BY 1, 2`.replace(/\s+/g, ' '),
      [pinIds]
    ),
    // SL IN / bổ sung của tem trong KỲ (ngày + ca) · `sl_in_truoc` = tem của lệnh in trước ngày đầu kỳ + tem `HT-` tới hết kỳ
    //   + tem cùng khoảng ngày nhưng KHÁC ca đang lọc (để CL vẫn là còn thiếu / dư của lệnh).
    query(
      `SELECT ps.lenh_san_xuat_id AS lenh_id,
              COALESCE(SUM(tm.so_luong) FILTER (WHERE tm.ma_tem NOT LIKE 'HT-%' AND ${TRONG_KY}), 0)::int AS sl_in,
              ${coBsTem
    ? `COALESCE(SUM(tm.sl_bo_sung_cty) FILTER (WHERE tm.ma_tem NOT LIKE 'HT-%' AND ${TRONG_KY}), 0)::int AS bs_cty,
              COALESCE(SUM(tm.sl_bo_sung_khach) FILTER (WHERE tm.ma_tem NOT LIKE 'HT-%' AND ${TRONG_KY}), 0)::int AS bs_khach,`
    : '0 AS bs_cty, 0 AS bs_khach,'}
              COALESCE(SUM(tm.so_luong) FILTER (WHERE ${NGAY_TM} < $2::date
                        OR (tm.ma_tem LIKE 'HT-%' AND (tm.created_date ${VN})::date <= $3::date)
                        OR (tm.ma_tem NOT LIKE 'HT-%' AND ${NGAY_TM} BETWEEN $2::date AND $3::date
                            AND cardinality($4::text[]) > 0 AND ${caTemSql('tm')} <> ALL($4::text[]))), 0)::int AS sl_in_truoc
         FROM phieu_san_xuat ps JOIN tem tm ON tm.phieu_san_xuat_id = ps.id AND tm.trang_thai <> 'HUY' AND tm.tem_goc_id IS NULL
        WHERE ps.lenh_san_xuat_id = ANY($1::uuid[]) GROUP BY 1`.replace(/\s+/g, ' '),
      [lenhIds, ngay, den, dsCa]
    ),
    // Vải hư / thiếu của kỳ. Lọc ca ⇒ chỉ dòng GẮN TEM thuộc ca đó (dòng không gắn tem không biết ca ⇒ bỏ).
    query(
      `SELECT COALESCE(vh.lenh_san_xuat_id, ps.lenh_san_xuat_id) AS lenh_id, vh.phan_in_id,
              COALESCE(SUM(vh.so_luong) FILTER (WHERE COALESCE(vh.loai, 'HUY') = 'HUY'), 0)::int AS hu,
              COALESCE(SUM(vh.so_luong) FILTER (WHERE vh.loai = 'THIEU'), 0)::int AS thieu
         FROM vai_huy vh LEFT JOIN phieu_san_xuat ps ON ps.id = vh.phieu_san_xuat_id
         ${coVaiTem ? 'LEFT JOIN tem tv ON tv.id = vh.tem_id' : ''}
        WHERE COALESCE(vh.lenh_san_xuat_id, ps.lenh_san_xuat_id) = ANY($1::uuid[])
          AND COALESCE(${coVaiTem ? ngaySxTemSql('tv') : 'NULL::date'},
                       ((vh.created_date ${VN}) - interval '6 hours')::date) BETWEEN $2::date AND $3::date
          AND (cardinality($4::text[]) = 0
               OR ${coVaiTem ? `(tv.id IS NOT NULL AND ${caTemSql('tv')} = ANY($4::text[]))` : 'false'})
        GROUP BY 1, 2`.replace(/\s+/g, ' '),
      [lenhIds, ngay, den, dsCa]
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
    query('SELECT id, luong_sx, tinh_chat_in FROM phan_in WHERE id = ANY($1::uuid[])', [pinIds]),
    // Phần SL release thuộc đợt BỔ SUNG của từng (lệnh × phần in) — theo MÃ loại đợt, không so tên.
    query(
      `SELECT lsd.lenh_san_xuat_id AS lenh_id, dv.phan_in_id, COALESCE(SUM(lsd.so_luong), 0)::int AS sl_bs
         FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
         JOIN loai_dot_vai ldv ON ldv.id = dv.loai_dot_vai_id AND ldv.ma_loai = 'BO_SUNG'
        WHERE lsd.lenh_san_xuat_id = ANY($1::uuid[]) GROUP BY 1, 2`.replace(/\s+/g, ' '),
      [lenhIds]
    ),
  ]);
  const relBsMap = new Map(relBs.rows.map((x) => [`${x.lenh_id}|${x.phan_in_id}`, x.sl_bs]));
  const ttMap = new Map(ttLenh.rows.map((x) => [`${x.lenh_id}|${x.phan_in_id}`, x.stage]));
  // ⚠⚠ THEO CÔNG ĐOẠN (19/11/2026, người dùng: "danh sách release của sản xuất tách dòng theo công đoạn, 2 công đoạn thì
  //   2 dòng"): mỗi công đoạn vốn là 1 LỆNH riêng ⇒ đã ra dòng riêng, nhưng trước đây không ghi công đoạn và SL ĐÃ IN /
  //   ĐÃ GIAO / SLNV cộng chung CẢ phần in (tem In kiếng + tem Ép cùng dồn vào 1 số) ⇒ 2 dòng nhìn như trùng. Nay phần in
  //   2 công đoạn tính các số đó theo ĐÚNG công đoạn của lệnh (`gd`); kiếng ủi SLNV = đợt của công đoạn đó (4I / đợt Ép).
  //   Phần in 1 công đoạn: mọi lệnh cùng 1 khóa ⇒ như cũ. Dòng mang `luong_sx` + nhãn `cong_doan` (In · In kiếng · Ép · Logo).
  const luongMap = new Map(pinLuong.rows.map((x) => [x.id, x]));
  const haiCd = (pinId) => L.laHaiCongDoan(L.chuanLuong((luongMap.get(pinId) || {}).luong_sx));
  const khoaCd = (pinId, gd) => `${pinId}|${haiCd(pinId) ? L.chuanGd(gd) : '*'}`;
  const theoPin = new Map();
  inTruoc.rows.forEach((x) => {
    const k = khoaCd(x.phan_in_id, x.gd);
    const o = theoPin.get(k) || { in: 0, giao: 0, inHt: 0, giaoHt: 0, lenh: new Map() };
    o.in += x.da_in; o.giao += x.da_giao; o.inHt += x.da_in_ht; o.giaoHt += x.da_giao_ht; o.lenh.set(x.lenh_id, x.da_in);
    theoPin.set(k, o);
  });
  // SLNV: phần in 2 công đoạn theo công đoạn của ĐỢT (`gd_dot` — kiếng ủi theo loại đợt, đợt đánh dấu mig 139; NULL = đợt mang
  //   cả 2 công đoạn ⇒ cộng cho cả 2); phần in 1 công đoạn = tổng mọi đợt.
  const nvMap = new Map();
  const congNv = (k, v) => nvMap.set(k, (nvMap.get(k) || 0) + v);
  nvPin.rows.forEach((x) => {
    const luong = L.chuanLuong((luongMap.get(x.phan_in_id) || {}).luong_sx);
    if (!L.laHaiCongDoan(luong)) { congNv(`${x.phan_in_id}|*`, x.slnv); return; }
    (x.gd_dot ? [x.gd_dot] : [L.GD_IN, L.GD_EP]).forEach((g) => congNv(`${x.phan_in_id}|${g}`, x.slnv));
  });
  const slnvDong = (pinId, gd) => {
    const luong = L.chuanLuong((luongMap.get(pinId) || {}).luong_sx);
    // Không có đợt nào của công đoạn này (dữ liệu trước luật đợt-theo-công-đoạn) ⇒ null ⇒ vải đợt trong lệnh (`r.slnv`).
    const k = L.laHaiCongDoan(luong) ? `${pinId}|${L.chuanGd(gd)}` : `${pinId}|*`;
    return nvMap.has(k) ? nvMap.get(k) : null;
  };
  // Nhãn công đoạn của dòng — phần in 2 công đoạn theo `nhanCongDoan` (PA ép theo tính chất in: Ép / Logo).
  const paEp = new Map();
  for (const p of pinLuong.rows) {
    if (L.laHaiCongDoan(L.chuanLuong(p.luong_sx))) paEp.set(p.id, await L.paCongDoanEp(p.tinh_chat_in).catch(() => null)); // eslint-disable-line no-await-in-loop
  }
  const nhanCd = (pinId, gd) => {
    const luong = L.chuanLuong((luongMap.get(pinId) || {}).luong_sx);
    if (L.laHaiCongDoan(luong)) return L.nhanCongDoan(luong, gd, paEp.get(pinId));
    if (luong === 'LOGO') return 'Logo';
    if (luong === 'KIENG_KHONG_EP') return 'In kiếng';
    return 'In';
  };
  const slInLenh = new Map(inLenh.rows.map((x) => [x.lenh_id, x]));
  const ghiMap = new Map(ghi.rows.map((x) => [x.id_ban_ghi, x.gia_tri_moi || {}]));
  const daGhiSlLenh = new Set();
  const out = rows.map((r) => {
    const p = theoPin.get(khoaCd(r.phan_in_id, r.giai_doan)) || { in: 0, giao: 0, inHt: 0, giaoHt: 0, lenh: new Map() };
    const nv = slnvDong(r.phan_in_id, r.giai_doan);
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
      slnv_pin: nv == null ? r.slnv : nv,
      luong_sx: (luongMap.get(r.phan_in_id) || {}).luong_sx || null,
      cong_doan: nhanCd(r.phan_in_id, r.giai_doan),
      hai_cong_doan: haiCd(r.phan_in_id),
      sl_in: dau ? ((slInLenh.get(r.lenh_id) || {}).sl_in || 0) : null,
      sl_in_truoc_lenh: dau ? ((slInLenh.get(r.lenh_id) || {}).sl_in_truoc || 0) : null,
      sl_in_bs_cty: dau ? ((slInLenh.get(r.lenh_id) || {}).bs_cty || 0) : null,
      sl_in_bs_khach: dau ? ((slInLenh.get(r.lenh_id) || {}).bs_khach || 0) : null,
      sl_release_bs: Math.min(relBsMap.get(`${r.lenh_id}|${r.phan_in_id}`) || 0,
        Number(r.sl_release_phan ?? r.so_luong_release) || 0),
      vai_hu: [...vaiPin, ...vaiChung].reduce((a, v) => a + v.hu, 0),
      vai_thieu: [...vaiPin, ...vaiChung].reduce((a, v) => a + v.thieu, 0),
      dm_test: g.dm_test ?? null,
      ghi_chu_sx: g.ghi_chu ?? null,
    };
  });
  return { ngay, den_ngay: den, ca: dsCa, items: out };
}

// ─── NHẬT KÝ IN (26/10/2026, người dùng gửi mẫu ERP "DANH SÁCH NHẬT KÝ IN Từ ngày … đến ngày …") ─────────────────
// Toggle thứ hai của modal: 1 dòng / TEM GỐC sản xuất thuộc kỳ theo NGÀY SẢN XUẤT (mã ngày ca — `utils/ngaySxTem.js`; cùng
//   tập tem của Danh sách release cùng kỳ: sống, không phải tem `HT-`, không phải chuyền gia công), xếp theo giờ in. Cột
//   theo mẫu ERP — nguồn MES:
//   · Số CT = IDMES lượt "Báo ERP mỗi lần in tem" (`erp_ok` = lượt thành công) — MES không có số chứng từ ERP `SF0…`.
//   · Vải hư / thiếu = cùng luật cột "Hủy / Thiếu" của Danh sách tem in (`repo.vaiTemSql`).
//   · Ngày = Ngày CT đã gửi ERP (`gui.Ngayct`), chưa gửi ⇒ ngày ca của tem · Giờ = lúc in tem · Số phút = giờ SX nhập
//     ở ô In tem (KT < BĐ ⇒ qua đêm).
//   · Thời gian kiểm / Ngày XN kiểm / Số CT XN kiểm = lượt KCS (chưa hủy xác nhận) ĐẦU / CUỐI của tem + IDMES kiểm phẩm.
//   · Thông tin phần in lấy phần in ĐẠI DIỆN của lệnh (tem không lưu đợt vải — lệnh gom set cũ chỉ mang phần in đầu).
// Lọc ca (25/11/2026): `ca` như Danh sách release — chỉ tem có mã ca thuộc danh sách (rỗng = mọi ca).
async function nhatKyIn(tuNgay, denNgay, { ca } = {}) {
  const dsCa = chuanDsCa(ca);
  const repo = require('./production.repository');
  const { nhomCuaLoai, NHOM } = require('../../utils/baoCaoSanXuat');
  const { notCancelledQc } = require('../quality/quality.repository');
  const { soVai, ERP_VAI_LATERAL } = await repo.vaiTemSql();
  const [coTo, coMaLo, coBsTem] = await Promise.all([repo.phieuCoCotToIn(), repo.temCoCot('ma_lo'), repo.temCoCotBoSung()]);
  const sql = `
    SELECT t.id, t.ma_tem, t.so_luong, t.created_date, t.ma_ngay_ca, to_char(t.ngay_ca, 'YYYY-MM-DD') AS ngay_ca,
           to_char(t.gio_sx_bd, 'HH24:MI') AS gio_sx_bd, to_char(t.gio_sx_kt, 'HH24:MI') AS gio_sx_kt,
           t.btp_truoc, t.btp_cuoi, ${coMaLo ? 't.ma_lo' : 'NULL::text AS ma_lo'},
           ${coBsTem ? 't.sl_bo_sung_cty, t.sl_bo_sung_khach' : 'info.dv_bs_cty AS sl_bo_sung_cty, info.dv_bs_khach AS sl_bo_sung_khach'},
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
      LEFT JOIN chuyen_san_xuat cs ON cs.id = ${await chuyenTemSql()}
      LEFT JOIN loai_chuyen lc ON lc.id = cs.loai_chuyen_id
      ${coTo ? 'LEFT JOIN to_in ti ON ti.id = ps.to_in_id' : ''}
      ${ERP_VAI_LATERAL}
      LEFT JOIN LATERAL (
        SELECT kh.ten_khach_hang, dh.ma_don_hang, dh.so_po, dh.ddh_id, mh.ma_hang,
               pin.id AS phan_in_id, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.mau_in, pin.do_in,
               pin.tinh_chat_in, pin.ddh_sub_id, pin.barcode AS barcode_phan_in,
               dv.han_giao_hang, dv.nha_gia_cong, dv.sl_bo_sung_cty AS dv_bs_cty, dv.sl_bo_sung_khach AS dv_bs_khach, ldv.ten_loai AS loai_dot_vai
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
       AND ${temTrongKySql('t', '$1', '$2')} AND ${temThuocCaSql('t', '$3')}
     ORDER BY t.created_date, t.ma_tem`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [tuNgay, denNgay || tuNgay, dsCa]);
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
  return { tu_ngay: tuNgay, den_ngay: denNgay || tuNgay, ca: dsCa, items };
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
