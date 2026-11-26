'use strict';

const { query } = require('../../config/db');
const { mauTim } = require('../../utils/timKiem');
const { sqlKhopMa } = require('../../utils/maPhanIn');
const { maTemUngVien } = require('../../utils/temPrefix');

// ─────────────────────────────────────────────────────────────────────────────
// LỊCH SỬ PHẦN IN — gom MỌI sự kiện của 1 phần in từ mọi bảng (thao tác người + hệ thống tự động + ERP).
// Chỉ ĐỌC. Phạm vi = phần in → mọi đợt vải (kể cả đã hủy) → mọi lệnh từng gắn đợt (kể cả HỦY / bị gộp) → phiếu → tem
//   (cả tem con 17 + tem gia công 13) → lượt KCS / Sửa / OQC / giao; trả về theo phần in / đợt / lệnh / tem.
// ⚠ Lệnh gom set cũ (nhiều phần in) ⇒ tem của lệnh tính cho mọi phần in của lệnh (tem không lưu phần in — DATABASE.md §4).
// ⚠ SQL gộp 1 dòng (IPS), không `--` trong chuỗi.
// ─────────────────────────────────────────────────────────────────────────────
const q1 = (sql) => sql.replace(/\s+/g, ' ').trim();
const rowsOf = async (sql, p) => (await query(q1(sql), p)).rows;

// TÌM PHẦN IN: mã tem (khớp chính xác) → mã lệnh LSX → code phần / mã TDTHĐH chính xác → gần đúng (≤ 20).
async function timPhanIn(q) {
  const ma = String(q || '').trim();
  if (ma.length < 3) return [];
  const COT = `pin.id, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.mau_in, pin.dang_hoat_dong,
               kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang`;
  const JOIN = `FROM phan_in pin LEFT JOIN ma_hang mh ON mh.id = pin.ma_hang_id
                LEFT JOIN don_hang dh ON dh.id = mh.don_hang_id LEFT JOIN khach_hang kh ON kh.id = dh.khach_hang_id`;
  const ungVien = maTemUngVien(ma);
  if (ungVien.length) {
    const theoTem = await rowsOf(
      `WITH t0 AS (SELECT t.id, t.tem_goc_id, t.phieu_san_xuat_id, t.dot_vai_ve_id FROM tem t WHERE t.ma_tem = ANY($1::text[])
                    ORDER BY array_position($1::text[], t.ma_tem) LIMIT 1),
            tg AS (SELECT t.id, t.phieu_san_xuat_id, t.dot_vai_ve_id FROM t0 JOIN tem t ON t.id = COALESCE(t0.tem_goc_id, t0.id)),
            p AS (SELECT dv.phan_in_id FROM tg JOIN phieu_san_xuat ps ON ps.id = tg.phieu_san_xuat_id
                    JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ps.lenh_san_xuat_id JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
                  UNION SELECT dv.phan_in_id FROM tg JOIN dot_vai_ve dv ON dv.id = tg.dot_vai_ve_id)
       SELECT ${COT}, true AS chinh_xac, 'TEM' AS khop ${JOIN} WHERE pin.id IN (SELECT phan_in_id FROM p) ORDER BY pin.ma_phan LIMIT 20`,
      [ungVien]);
    if (theoTem.length) return theoTem;
  }
  if (/^LSX/i.test(ma)) {
    const theoLenh = await rowsOf(
      `SELECT ${COT}, true AS chinh_xac, 'LENH' AS khop ${JOIN}
        WHERE pin.id IN (SELECT dv.phan_in_id FROM lenh_san_xuat ls JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
                          JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id WHERE upper(ls.ma_lenh_san_xuat) = upper($1))
        ORDER BY pin.ma_phan LIMIT 20`, [ma]);
    if (theoLenh.length) return theoLenh;
  }
  const ds = await rowsOf(
    `SELECT ${COT}, (upper(pin.ma_phan) = upper($1) OR ${sqlKhopMa('pin.barcode', '$1')}) AS chinh_xac, 'PHAN_IN' AS khop ${JOIN}
      WHERE pin.ma_phan ~* $2 OR ${sqlKhopMa('pin.barcode', '$1')}
         OR EXISTS (SELECT 1 FROM dot_vai_ve dv WHERE dv.phan_in_id = pin.id AND (upper(dv.ma_dot_vai) = upper($1) OR dv.barcode = $1))
      ORDER BY 11 DESC, pin.dang_hoat_dong DESC, pin.ma_phan LIMIT 21`, [ma, mauTim(ma)]);
  return ds.some((r) => r.chinh_xac) ? ds.filter((r) => r.chinh_xac) : ds;
}

// Thông tin đầu trang của phần in + HSKT đang dùng.
async function thongTinPhanIn(pinId) {
  const [r] = await rowsOf(
    `SELECT pin.id, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.mau_in, pin.tinh_chat_in, pin.so_luong_don_hang,
            pin.dang_hoat_dong, pin.barcode, pin.created_date, pin.created_by, to_jsonb(pin)->>'luong_sx' AS luong_sx,
            kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang, mh.ten_ma_hang,
            hs.barcode_hskt, hs.phuong_an_in
       FROM phan_in pin LEFT JOIN ma_hang mh ON mh.id = pin.ma_hang_id
       LEFT JOIN don_hang dh ON dh.id = mh.don_hang_id LEFT JOIN khach_hang kh ON kh.id = dh.khach_hang_id
       LEFT JOIN LATERAL (SELECT h.barcode_hskt, h.phuong_an_in FROM hskt_phan_in hp JOIN ho_so_ky_thuat h ON h.id = hp.hskt_id
                           WHERE hp.phan_in_id = pin.id AND hp.dang_hoat_dong AND h.dang_hoat_dong ORDER BY h.phien_ban DESC LIMIT 1) hs ON true
      WHERE pin.id = $1`, [pinId]);
  return r || null;
}

// PHẠM VI id của phần in (đợt · lệnh · phiếu · tem · lượt QC · trả về · giao · HSKT · set · kết quả checklist).
async function phamVi(pinId) {
  const ids = (rows, k = 'id') => rows.map((r) => String(r[k]));
  const dots = await rowsOf('SELECT d.id, d.ma_dot_vai FROM dot_vai_ve d WHERE d.phan_in_id = $1', [pinId]);
  const dotIds = ids(dots);
  const lenhs = dotIds.length ? await rowsOf(
    `SELECT DISTINCT ls.id, ls.ma_lenh_san_xuat FROM lenh_sx_dot_vai lsd JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id
      WHERE lsd.dot_vai_ve_id = ANY($1::uuid[])`, [dotIds]) : [];
  const lenhIds = ids(lenhs);
  const phieus = lenhIds.length ? await rowsOf('SELECT p.id FROM phieu_san_xuat p WHERE p.lenh_san_xuat_id = ANY($1::uuid[])', [lenhIds]) : [];
  const phieuIds = ids(phieus);
  const tems = (phieuIds.length || dotIds.length) ? await rowsOf(
    `WITH g AS (SELECT t.id FROM tem t WHERE t.phieu_san_xuat_id = ANY($1::uuid[])
                UNION SELECT t.id FROM tem t WHERE t.dot_vai_ve_id = ANY($2::uuid[]))
     SELECT id FROM g UNION SELECT t.id FROM tem t WHERE t.tem_goc_id IN (SELECT id FROM g)`, [phieuIds, dotIds]) : [];
  const temIds = ids(tems);
  const [kcs, sua, oqc, tests, giao, traVe, kqs, hskts, sets] = await Promise.all([
    temIds.length ? rowsOf('SELECT id FROM kcs WHERE tem_id = ANY($1::uuid[])', [temIds]) : [],
    temIds.length ? rowsOf('SELECT id FROM sua WHERE tem_id = ANY($1::uuid[])', [temIds]) : [],
    temIds.length ? rowsOf('SELECT id FROM oqc WHERE tem_id = ANY($1::uuid[])', [temIds]) : [],
    lenhIds.length ? rowsOf('SELECT id FROM test_run WHERE lenh_san_xuat_id = ANY($1::uuid[])', [lenhIds]) : [],
    temIds.length ? rowsOf('SELECT DISTINCT giao_hang_id AS id FROM giao_hang_tem WHERE tem_id = ANY($1::uuid[])', [temIds]) : [],
    rowsOf(`SELECT q.id FROM qc_tra_ve q WHERE q.phan_in_id = $1 OR q.dot_vai_ve_id = ANY($2::uuid[])
             OR q.lenh_san_xuat_id = ANY($3::uuid[]) OR q.tem_id = ANY($4::uuid[])`, [pinId, dotIds, lenhIds, temIds]),
    rowsOf('SELECT k.id FROM ket_qua_checkpoint k WHERE k.phan_in_id = $1 OR k.lenh_san_xuat_id = ANY($2::uuid[])', [pinId, lenhIds]),
    rowsOf('SELECT DISTINCT hskt_id AS id FROM hskt_phan_in WHERE phan_in_id = $1', [pinId]),
    dotIds.length ? rowsOf('SELECT DISTINCT gom_set_id AS id FROM gom_set_dot_vai WHERE dot_vai_ve_id = ANY($1::uuid[])', [dotIds]) : [],
  ]);
  return {
    pinId: String(pinId), dots, dotIds, lenhs, lenhIds, phieuIds, temIds,
    kcsIds: ids(kcs), suaIds: ids(sua), oqcIds: ids(oqc), testIds: ids(tests), giaoIds: ids(giao),
    traVeIds: ids(traVe), kqIds: ids(kqs), hsktIds: ids(hskts), setIds: ids(sets),
  };
}

// AUDIT của mọi bản ghi trong phạm vi. Kênh API ERP chỉ trả phần tóm tắt (thân gửi/nhận rất dài).
async function auditTrongPhamVi(pv) {
  const cap = [
    ['phan_in', [pv.pinId]], ['ket_qua_checkpoint', [pv.pinId, ...pv.kqIds]],
    ['dot_vai_ve', pv.dotIds], ['ke_hoach_tam', pv.dotIds], ['nhan_file_bh', pv.dotIds], ['cho_ky_ten', pv.dotIds],
    ['lenh_san_xuat', pv.lenhIds], ['phieu_san_xuat', pv.phieuIds], ['vai_cho_tem', pv.phieuIds],
    ['tem', pv.temIds], ['tem_phan_cong', pv.temIds],
    ['kcs', pv.kcsIds], ['sua', pv.suaIds], ['oqc', pv.oqcIds], ['test_run', pv.testIds],
    ['qc_tra_ve', pv.traVeIds], ['giao_hang', pv.giaoIds], ['ho_so_ky_thuat', pv.hsktIds], ['gom_set', pv.setIds],
  ].filter(([, ds]) => ds.length);
  if (!cap.length) return [];
  const dk = cap.map(([bang], i) => `(a.ten_bang = '${bang}' AND a.id_ban_ghi = ANY($${i + 1}::text[]))`).join(' OR ');
  return rowsOf(
    `SELECT a.id, a.ten_bang, a.id_ban_ghi, a.hanh_dong, a.thoi_gian, a.nguoi_thuc_hien_id, a.gia_tri_cu,
            CASE WHEN a.hanh_dong LIKE 'ERP%' AND a.hanh_dong NOT IN ('ERP_DONG_BO_DOI','ERP_CAP_NHAT_CODE_PHAN')
                 THEN jsonb_strip_nulls(jsonb_build_object('thanh_cong', a.gia_tri_moi->'thanh_cong', 'id_mes', a.gia_tri_moi->'id_mes',
                        'nguon', a.gia_tri_moi->'gui'->'Nguon', 'loi', a.gia_tri_moi->'loi', 'erp_message', a.gia_tri_moi->'erp_message',
                        'ma_tem', a.gia_tri_moi->'ma_tem', 'tu_gui_lai', a.gia_tri_moi->'tu_gui_lai', 'sua_tay', a.gia_tri_moi->'sua_tay',
                        'so_luong', COALESCE(a.gia_tri_moi->'gui'->'Soluong', a.gia_tri_moi->'gui'->'SoLuong')))
                 ELSE a.gia_tri_moi END AS gia_tri_moi
       FROM audit_log a WHERE ${dk}`,
    cap.map(([, ds]) => ds));
}

// Các nguồn sự kiện từ chính bảng nghiệp vụ (không qua audit).
async function suKienBang(pv) {
  const { pinId, dotIds, lenhIds, phieuIds, temIds } = pv;
  const E = {};
  const chay = (ten, cond, sql, p) => (cond ? rowsOf(sql, p).then((rows) => ({ ten, rows })).catch((e) => ({ ten, rows: [], loi: e.message })) : Promise.resolve({ ten, rows: [] }));
  const coNhanSua = (await rowsOf("SELECT to_regclass('public.nhan_sua') IS NOT NULL AS co", []))[0].co;
  const ds = await Promise.all([
    chay('dot', true,
      `SELECT d.id, d.ma_dot_vai, d.barcode, d.so_luong_vai_ve, d.ngay_vai_ve, d.han_giao_hang, d.trang_thai, d.created_date, d.created_by,
              d.tg_chuyen_ready, to_jsonb(d)->>'kt_can_kiem_tra' AS kt_can_kiem_tra, to_jsonb(d)->>'nha_gia_cong' AS nha_gia_cong,
              ldv.ten_loai AS loai_dot
         FROM dot_vai_ve d LEFT JOIN loai_dot_vai ldv ON ldv.id = d.loai_dot_vai_id WHERE d.phan_in_id = $1`, [pinId]),
    chay('lst', true,
      `SELECT lst.id, lst.tg_thuc_hien AS tg, lst.nguoi_thuc_hien_id, lst.ly_do, lst.ghi_chu, tm.ma_trang_thai AS tt_moi, tc.ma_trang_thai AS tt_cu,
              cp.ma_checkpoint, cp.ten_checkpoint, tr.ma_tram, kq.lenh_san_xuat_id
         FROM lich_su_trang_thai lst JOIN ket_qua_checkpoint kq ON kq.id = lst.ket_qua_checkpoint_id
         JOIN checkpoint cp ON cp.id = kq.checkpoint_id JOIN tram tr ON tr.id = cp.tram_id
         LEFT JOIN trang_thai tm ON tm.id = lst.trang_thai_moi_id LEFT JOIN trang_thai tc ON tc.id = lst.trang_thai_cu_id
        WHERE kq.phan_in_id = $1 OR kq.lenh_san_xuat_id = ANY($2::uuid[])`, [pinId, lenhIds]),
    chay('rxd', true,
      `SELECT r.id, COALESCE(r.tg_xac_nhan, r.updated_date, r.created_date) AS tg, r.trang_thai, r.nguoi_xac_nhan_id, r.dot_vai_ve_id,
              cp.ma_checkpoint, cp.ten_checkpoint, d.ma_dot_vai
         FROM ready_xac_nhan_dot r JOIN checkpoint cp ON cp.id = r.checkpoint_id LEFT JOIN dot_vai_ve d ON d.id = r.dot_vai_ve_id
        WHERE r.phan_in_id = $1`, [pinId]),
    chay('lenh', lenhIds.length,
      `SELECT ls.id, ls.ma_lenh_san_xuat, ls.created_date, ls.created_by, ls.giai_doan, ls.la_in_lai, cs.ma_chuyen,
              (SELECT SUM(x.so_luong) FROM lenh_sx_dot_vai x JOIN dot_vai_ve d ON d.id = x.dot_vai_ve_id
                WHERE x.lenh_san_xuat_id = ls.id AND d.phan_in_id = $2)::int AS sl_phan_in
         FROM lenh_san_xuat ls LEFT JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id WHERE ls.id = ANY($1::uuid[])`, [lenhIds, pinId]),
    chay('test', lenhIds.length,
      `SELECT tr.id, tr.lenh_san_xuat_id, tr.lan_test, tr.so_luong, tr.ket_qua, tr.ghi_chu, COALESCE(tr.tg_bd_test, tr.created_date) AS tg,
              tr.created_by, ls.ma_lenh_san_xuat
         FROM test_run tr JOIN lenh_san_xuat ls ON ls.id = tr.lenh_san_xuat_id WHERE tr.lenh_san_xuat_id = ANY($1::uuid[])`, [lenhIds]),
    chay('phieu', phieuIds.length,
      `SELECT ps.id, ps.ma_phieu_san_xuat, ps.tg_bd, ps.tg_kt, ps.trang_thai, ps.ghi_chu, ps.created_by, ps.updated_by, cs.ma_chuyen,
              ls.ma_lenh_san_xuat
         FROM phieu_san_xuat ps JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id LEFT JOIN chuyen_san_xuat cs ON cs.id = ps.chuyen_id
        WHERE ps.id = ANY($1::uuid[])`, [phieuIds]),
    chay('ngung', phieuIds.length,
      `SELECT n.id, n.tg_bd_ngung, n.tg_kt_ngung, n.so_phut, n.ly_do, n.trang_thai, n.created_by, n.updated_by, cs.ma_chuyen,
              ps.ma_phieu_san_xuat
         FROM ngung_chuyen n LEFT JOIN chuyen_san_xuat cs ON cs.id = n.chuyen_id LEFT JOIN phieu_san_xuat ps ON ps.id = n.phieu_san_xuat_id
        WHERE n.phieu_san_xuat_id = ANY($1::uuid[])`, [phieuIds]),
    chay('tem', temIds.length,
      `SELECT t.id, t.ma_tem, t.so_luong, t.trang_thai, t.created_date, t.created_by, t.ma_ngay_ca, t.tem_goc_id,
              t.kcs_tach_id, t.dot_vai_ve_id AS dot_gc, t.sl_kcs_dat,
              tg.ma_tem AS ma_tem_goc, ls.ma_lenh_san_xuat, cs.ma_chuyen
         FROM tem t LEFT JOIN tem tg ON tg.id = t.tem_goc_id
         LEFT JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id LEFT JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
         LEFT JOIN chuyen_san_xuat cs ON cs.id = COALESCE(t.chuyen_id, ps.chuyen_id)
        WHERE t.id = ANY($1::uuid[])`, [temIds]),
    chay('in_lai', temIds.length,
      `SELECT l.id, l.tem_id, l.ma_tem, l.tg_in, l.nguoi_in_id, l.so_lan_in, l.ly_do_in_lai, l.ghi_chu
         FROM log_tem l WHERE l.tem_id = ANY($1::uuid[]) AND (COALESCE(l.so_lan_in, 1) > 1 OR COALESCE(l.ly_do_in_lai, '') <> '')`, [temIds]),
    chay('phoi', temIds.length,
      `SELECT x.id, x.tem_id, x.tg_bd_phoi, x.tg_kt_phoi, x.trang_thai, x.created_by, xp.ten_xe_phoi, xp.ma_xe_phoi, t.ma_tem
         FROM tem_xe_phoi x JOIN tem t ON t.id = x.tem_id LEFT JOIN xe_phoi xp ON xp.id = x.xe_phoi_id
        WHERE x.tem_id = ANY($1::uuid[])`, [temIds]),
    chay('vai_huy', true,
      `SELECT v.id, v.loai, v.so_luong, v.ly_do, v.created_date, v.created_by, t.ma_tem, d.ma_dot_vai
         FROM vai_huy v LEFT JOIN tem t ON t.id = v.tem_id LEFT JOIN dot_vai_ve d ON d.id = v.dot_vai_ve_id
        WHERE v.phan_in_id = $1 OR v.dot_vai_ve_id = ANY($2::uuid[])`, [pinId, dotIds]),
    chay('kcs', temIds.length,
      `SELECT k.id, k.tem_id, k.so_luong_kiem, k.so_luong_mau, k.so_luong_dat, k.so_luong_loi, k.so_luong_huy, k.so_luong_chenh_lech,
              k.ket_qua, k.ghi_chu, k.created_date, k.created_by, t.ma_tem
         FROM kcs k JOIN tem t ON t.id = k.tem_id WHERE k.tem_id = ANY($1::uuid[])`, [temIds]),
    chay('pll', temIds.length,
      `SELECT p.id, p.tem_id, p.created_date, p.created_by, p.updated_date, p.updated_by, p.ghi_chu, t.ma_tem,
              (SELECT string_agg(COALESCE(ll.ma_loi, '?') || ' sửa ' || COALESCE(c.so_luong_sua, 0) || ' / hủy ' || COALESCE(c.so_luong_huy, 0), '; ' ORDER BY c.thu_tu)
                 FROM phan_loai_loi_ct c LEFT JOIN loai_loi ll ON ll.id = c.loai_loi_id WHERE c.phan_loai_loi_id = p.id) AS dong
         FROM phan_loai_loi p JOIN tem t ON t.id = p.tem_id WHERE p.tem_id = ANY($1::uuid[])`, [temIds]),
    chay('nhan_sua', coNhanSua && temIds.length,
      `SELECT n.*, t.ma_tem FROM nhan_sua n JOIN tem t ON t.id = n.tem_id WHERE n.tem_id = ANY($1::uuid[])`, [temIds]),
    chay('sua', temIds.length,
      `SELECT s.id, s.tem_id, s.so_luong_sua, s.so_luong_sua_dat, s.so_luong_sua_huy, s.ghi_chu, s.created_date, s.created_by, s.nguoi_sua,
              t.ma_tem, tc.ma_tem AS ma_tem_con
         FROM sua s JOIN tem t ON t.id = s.tem_id LEFT JOIN tem tc ON tc.id = s.tem_con_id WHERE s.tem_id = ANY($1::uuid[])`, [temIds]),
    chay('oqc', temIds.length,
      `SELECT o.id, o.tem_id, o.nguon, o.so_luong_kiem, o.so_luong_dat, o.so_luong_loi, o.ket_qua, o.sl_qua_giao, o.cho_giao,
              o.ly_do_cho_giao, o.ghi_chu, o.created_date, o.created_by, o.owner_cho_giao_id, t.ma_tem
         FROM oqc o JOIN tem t ON t.id = o.tem_id WHERE o.tem_id = ANY($1::uuid[])`, [temIds]),
    chay('giao', temIds.length,
      `SELECT gt.id, gt.so_luong_giao, gt.nguon, gh.ma_phieu_giao, gh.trang_thai, gh.created_date, gh.created_by, gh.giao_hang_tai, t.ma_tem
         FROM giao_hang_tem gt JOIN giao_hang gh ON gh.id = gt.giao_hang_id JOIN tem t ON t.id = gt.tem_id
        WHERE gt.tem_id = ANY($1::uuid[])`, [temIds]),
    chay('tra_ve', pv.traVeIds.length,
      `SELECT q.id, q.loai, q.ly_do, q.checklist_list, q.da_xu_ly, q.created_date, q.created_by, q.updated_date, q.updated_by,
              d.ma_dot_vai, ls.ma_lenh_san_xuat, t.ma_tem
         FROM qc_tra_ve q LEFT JOIN dot_vai_ve d ON d.id = q.dot_vai_ve_id LEFT JOIN lenh_san_xuat ls ON ls.id = q.lenh_san_xuat_id
         LEFT JOIN tem t ON t.id = q.tem_id WHERE q.id = ANY($1::uuid[])`, [pv.traVeIds]),
    chay('hskt', true,
      `SELECT l.id, l.hanh_dong, l.chi_tiet, l.phien_ban, l.nguoi_id, l.tg, h.barcode_hskt
         FROM lich_su_hskt l LEFT JOIN ho_so_ky_thuat h ON h.id = l.hskt_id
        WHERE l.phan_in_id = $1 OR (l.phan_in_id IS NULL AND l.hskt_id = ANY($2::uuid[]))`, [pinId, pv.hsktIds]),
    chay('nghen', true,
      `SELECT n.id, n.ma_trang, n.ly_do, n.hanh_dong, n.tg_bat_dau_nghen, n.so_phut_nghen, n.created_date, n.created_by, n.ma_doi_tuong
         FROM ly_do_nghen n WHERE n.phan_in_id = $1`, [pinId]),
    chay('ghi_chu', true,
      `SELECT g.id, g.loai, g.noi_dung, g.dang_hoat_dong, g.created_date, g.created_by, g.updated_date, g.updated_by
         FROM phan_in_ghi_chu g WHERE g.phan_in_id = $1`, [pinId]),
    chay('set', dotIds.length,
      `SELECT gsd.id, gsd.created_date, gsd.created_by, gs.ma_set, gs.trang_thai, d.ma_dot_vai
         FROM gom_set_dot_vai gsd JOIN gom_set gs ON gs.id = gsd.gom_set_id JOIN dot_vai_ve d ON d.id = gsd.dot_vai_ve_id
        WHERE gsd.dot_vai_ve_id = ANY($1::uuid[])`, [dotIds]),
  ]);
  ds.forEach((x) => { E[x.ten] = x.rows; if (x.loi) console.error(`[lich-su-phan-in] nguồn ${x.ten} lỗi: ${x.loi}`); });
  return E;
}

// Họ tên người theo id (người thao tác + owner).
async function tenNguoi(ids) {
  const ds = [...new Set(ids.filter(Boolean).map(String))];
  if (!ds.length) return new Map();
  const rows = await rowsOf('SELECT id, ho_ten, ten_dang_nhap FROM nguoi_dung WHERE id = ANY($1::uuid[])', [ds]);
  return new Map(rows.map((r) => [String(r.id), r]));
}

// Tên tra cứu cho id trong vết (chuyền · loại đợt) — để chi tiết không hiện uuid trần.
async function tenTheoId(ids) {
  const ds = [...new Set(ids.filter(Boolean).map(String))].filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  if (!ds.length) return new Map();
  const rows = await rowsOf(
    `SELECT id::text, ma_chuyen AS ten FROM chuyen_san_xuat WHERE id = ANY($1::uuid[])
     UNION ALL SELECT id::text, ten_loai FROM loai_dot_vai WHERE id = ANY($1::uuid[])
     UNION ALL SELECT id::text, ma_lenh_san_xuat FROM lenh_san_xuat WHERE id = ANY($1::uuid[])
     UNION ALL SELECT id::text, ma_dot_vai FROM dot_vai_ve WHERE id = ANY($1::uuid[])
     UNION ALL SELECT id::text, ho_ten FROM nguoi_dung WHERE id = ANY($1::uuid[])`, [ds]);
  return new Map(rows.map((r) => [r.id, r.ten]));
}

module.exports = { timPhanIn, thongTinPhanIn, phamVi, auditTrongPhamVi, suKienBang, tenNguoi, tenTheoId };
