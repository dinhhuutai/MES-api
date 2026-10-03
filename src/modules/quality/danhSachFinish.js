'use strict';

// ─── DANH SÁCH FINISH (màn OQC, 03/10/2026) — đọc dữ liệu thô ─────────────────────────────────────
// Luật từng cột: `utils/danhSachFinish.js`. Ở đây 2 câu:
//   1. Dòng finish: 1 dòng / PHẦN IN (code phần) có OQC cho qua giao trong [tuNgay, denNgay] giờ VN — mọi tem của
//      phần in cộng lại (03/10/2026 người dùng chốt; bản đầu tách 1 dòng / ngày × phần in).
//   2. MỤC TIÊU ngày tiêu đề (= denNgay): phần in còn hiệu lực có ĐỢT VẢI hạn giao đúng ngày đó.
// Sổ cái tem đọc bằng CHÍNH biểu thức của `quality.repository` (`conKcsSql`, `CON_OQC`, `notCancelledQc`).
// Gửi 1 dòng (IPS), không `--` trong chuỗi SQL. Cache RAM 15s theo tham số.

const { query } = require('../../config/db');
const { conKcsSql, CON_OQC, notCancelledQc } = require('./quality.repository');
const { DAU_HE_THONG, dungDanhSachFinish } = require('../../utils/danhSachFinish');

const VN = "AT TIME ZONE 'Asia/Ho_Chi_Minh'";
const T0 = `(($1::date)::timestamp ${VN})`;
const T1 = `(($2::date + 1)::timestamp ${VN})`;

// Lệnh mang đợt vải: lệnh ép ủi (in kiếng) dùng đợt của lệnh IN liên kết — gương `baoCaoKiemHang`.
const LENH_DOT = 'COALESCE(ls.lenh_lien_ket_id, ls.id)';
// Phần in của 1 tem: tem gia công 13 có `dot_vai_ve_id` ⇒ đúng phần in; còn lại = phần in ĐẦU của lệnh
// (cùng thứ tự `quality.repository TEM_INFO_LATERAL`).
const PIN_CUA_TEM = `COALESCE((SELECT zd.phan_in_id FROM dot_vai_ve zd WHERE zd.id = t.dot_vai_ve_id),
  (SELECT zv.phan_in_id FROM lenh_sx_dot_vai zl JOIN dot_vai_ve zv ON zv.id = zl.dot_vai_ve_id
     JOIN phan_in zp ON zp.id = zv.phan_in_id WHERE zl.lenh_san_xuat_id = ${LENH_DOT}
    ORDER BY zp.ma_phan, zv.ma_dot_vai LIMIT 1))`;
const SLNV = (pin) => `(SELECT sum(xv.so_luong_vai_ve) FROM dot_vai_ve xv
  WHERE xv.phan_in_id = ${pin} AND xv.trang_thai NOT IN ('DA_GOP','DA_HUY'))::int`;
const PIN_INFO = `kh.ten_khach_hang, dh.ma_don_hang, COALESCE(NULLIF(mh.ten_ma_hang, ''), mh.ma_hang) AS ma_hang,
  pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.barcode, pin.so_luong_don_hang`;
const JOIN_PIN = `JOIN ma_hang mh ON mh.id = pin.ma_hang_id JOIN don_hang dh ON dh.id = mh.don_hang_id
  JOIN khach_hang kh ON kh.id = dh.khach_hang_id`;

// Phiếu Phân loại lỗi (mig 075 — có thể thiếu ở môi trường cũ): dò bảng + cột `sl_huy_luc_luu` trước.
// Cache khi ĐÃ có (chạy migration xong nhận ngay, khỏi restart).
let _coPll = false;
async function coPhanLoaiLoi() {
  if (_coPll) return true;
  const { rows } = await query(`SELECT count(*)::int n FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'phan_loai_loi' AND column_name IN ('tem_id', 'sl_huy_luc_luu')`.replace(/\s+/g, ' '));
  _coPll = rows[0].n === 2;
  return _coPll;
}

async function docDong(tuNgay, denNgay, gomHeThong) {
  const pll = (await coPhanLoaiLoi())
    ? `UNION ALL SELECT p.tem_id, COALESCE(p.updated_date, p.created_date) FROM phan_loai_loi p WHERE COALESCE(p.sl_huy_luc_luu, 0) > 0`
    : '';
  const sql = `WITH o AS MATERIALIZED (
      SELECT x.tem_id, to_char((x.created_date ${VN})::date, 'YYYY-MM-DD') AS ngay FROM oqc x
       WHERE x.created_date >= ${T0} AND x.created_date < ${T1} AND COALESCE(x.sl_qua_giao, 0) > 0
         AND ${notCancelledQc('x', 'oqc')} AND ($3::boolean OR x.ghi_chu IS NULL OR x.ghi_chu NOT LIKE $4)),
    op AS MATERIALIZED (
      SELECT o.ngay, ${PIN_CUA_TEM} AS phan_in_id, ${LENH_DOT} AS lenh_dot, COALESCE(ps.chuyen_id, ls.chuyen_id) AS chuyen_id
        FROM o JOIN tem t ON t.id = o.tem_id AND t.trang_thai <> 'HUY'
        JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id),
    d AS MATERIALIZED (
      SELECT max(op.ngay) AS ngay, op.phan_in_id, array_agg(DISTINCT op.lenh_dot) AS lenh_dots,
        COALESCE(json_agg(DISTINCT jsonb_build_object('ma_chuyen', cs.ma_chuyen, 'ten_chuyen', cs.ten_chuyen, 'ma_loai_chuyen', lc.ma_loai))
          FILTER (WHERE cs.id IS NOT NULL), '[]') AS chuyen,
        string_agg(DISTINCT cs.ma_chuyen, ', ') AS ma_chuyen
        FROM op LEFT JOIN chuyen_san_xuat cs ON cs.id = op.chuyen_id LEFT JOIN loai_chuyen lc ON lc.id = cs.loai_chuyen_id
       WHERE op.phan_in_id IS NOT NULL GROUP BY op.phan_in_id),
    ta AS MATERIALIZED (
      SELECT z.* FROM (SELECT t.id, t.so_luong, t.sl_chenh_lech, t.sl_kcs_dat, t.sl_kcs_sua, t.sl_kcs_huy, t.sl_sua_dat,
            t.sl_sua_huy, t.sl_oqc_dat, t.sl_sua_tach, t.tem_goc_id, ${PIN_CUA_TEM} AS phan_in_id
          FROM tem t JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
         WHERE t.trang_thai <> 'HUY' AND ${LENH_DOT} IN (SELECT yl.lenh_san_xuat_id FROM lenh_sx_dot_vai yl
           JOIN dot_vai_ve yv ON yv.id = yl.dot_vai_ve_id WHERE yv.phan_in_id IN (SELECT phan_in_id FROM d))
         OFFSET 0) z
       WHERE z.phan_in_id IN (SELECT phan_in_id FROM d)),
    ag AS (
      SELECT t.phan_in_id, sum(COALESCE(t.so_luong, 0))::int AS slin,
        sum(CASE WHEN t.tem_goc_id IS NULL THEN t.sl_kcs_sua + t.sl_kcs_huy ELSE 0 END)::int AS ton_cuoi,
        sum(t.sl_sua_dat)::int AS sua_dat,
        sum(t.sl_sua_huy + CASE WHEN t.tem_goc_id IS NULL THEN t.sl_kcs_huy ELSE 0 END)::int AS sua_huy,
        sum(GREATEST(t.sl_kcs_sua - t.sl_sua_dat - t.sl_sua_huy, 0))::int AS sl_con_lai,
        sum(GREATEST(${conKcsSql('t.')}, 0))::int AS con_kcs,
        sum(GREATEST(${CON_OQC}, 0))::int AS con_oqc
        FROM ta t GROUP BY t.phan_in_id),
    kq AS (
      SELECT ta.phan_in_id, max(e.tg) AS tg FROM ta JOIN (
          SELECT s.tem_id, s.created_date AS tg FROM sua s WHERE ${notCancelledQc('s', 'sua')} ${pll}
        ) e ON e.tem_id = ta.id GROUP BY ta.phan_in_id)
    SELECT d.ngay, d.phan_in_id, ${PIN_INFO}, d.ma_chuyen, d.chuyen, ${SLNV('d.phan_in_id')} AS slnv,
      ag.slin, ag.ton_cuoi, ag.sua_dat, ag.sua_huy, ag.sl_con_lai, ag.con_kcs, ag.con_oqc,
      (SELECT sum(xo.sl_qua_giao) FROM oqc xo JOIN ta xt ON xt.id = xo.tem_id
        WHERE xt.phan_in_id = d.phan_in_id AND xo.created_date < ${T1}
          AND ${notCancelledQc('xo', 'oqc')})::int AS sgiao,
      to_char(COALESCE(
        (SELECT min(hv.han_giao_hang) FROM lenh_sx_dot_vai hl JOIN dot_vai_ve hv ON hv.id = hl.dot_vai_ve_id
          WHERE hl.lenh_san_xuat_id = ANY(d.lenh_dots) AND hv.phan_in_id = d.phan_in_id),
        (SELECT min(hv2.han_giao_hang) FROM dot_vai_ve hv2 WHERE hv2.phan_in_id = d.phan_in_id
          AND hv2.trang_thai NOT IN ('DA_GOP','DA_HUY'))), 'YYYY-MM-DD') AS han_giao_hang,
      to_char((kq.tg ${VN})::date, 'YYYY-MM-DD') AS ngay_cap_nhat_ket_qua
    FROM d JOIN phan_in pin ON pin.id = d.phan_in_id ${JOIN_PIN}
    LEFT JOIN ag ON ag.phan_in_id = d.phan_in_id
    LEFT JOIN kq ON kq.phan_in_id = d.phan_in_id`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [tuNgay, denNgay, !!gomHeThong, DAU_HE_THONG]);
  return rows;
}

// MỤC TIÊU của ngày tiêu đề: phần in còn hiệu lực có ≥1 đợt vải (còn hiệu lực) HẠN GIAO đúng ngày đó.
// Chuyền = các lệnh sống của phần in (để chip loại chuyền / khu lọc được cả dòng mục tiêu).
async function docMucTieu(ngay) {
  const sql = `SELECT pin.id AS phan_in_id, ${PIN_INFO}, ${SLNV('pin.id')} AS slnv, ch.chuyen, ch.ma_chuyen
    FROM phan_in pin ${JOIN_PIN}
    LEFT JOIN LATERAL (SELECT COALESCE(json_agg(DISTINCT jsonb_build_object('ma_chuyen', cs.ma_chuyen, 'ten_chuyen', cs.ten_chuyen,
          'ma_loai_chuyen', lc.ma_loai)) FILTER (WHERE cs.id IS NOT NULL), '[]') AS chuyen,
        string_agg(DISTINCT cs.ma_chuyen, ', ') AS ma_chuyen
      FROM lenh_sx_dot_vai l JOIN dot_vai_ve v ON v.id = l.dot_vai_ve_id
      JOIN lenh_san_xuat ls ON ls.id = l.lenh_san_xuat_id AND ls.trang_thai <> 'HUY'
      LEFT JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id LEFT JOIN loai_chuyen lc ON lc.id = cs.loai_chuyen_id
      WHERE v.phan_in_id = pin.id) ch ON true
    WHERE pin.dang_hoat_dong AND EXISTS (SELECT 1 FROM dot_vai_ve hv WHERE hv.phan_in_id = pin.id
      AND hv.trang_thai NOT IN ('DA_GOP','DA_HUY') AND hv.han_giao_hang = $1::date)`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [ngay]);
  return rows;
}

const CACHE_MS = 15000;
const cache = new Map(); // `tu|den|he` → { het, hua }

// Lưu PROMISE ⇒ nhiều người mở cùng lúc chỉ chạy 1 lượt; lỗi thì bỏ cache ngay.
async function danhSachFinish(tuNgay, denNgay, gomHeThong = false) {
  const k = `${tuNgay}|${denNgay}|${gomHeThong ? 1 : 0}`;
  const now = Date.now();
  const c = cache.get(k);
  if (c && c.het > now) return c.hua;
  const hua = Promise.all([docDong(tuNgay, denNgay, gomHeThong), docMucTieu(denNgay)])
    .then(([rows, mucTieu]) => dungDanhSachFinish({ tuNgay, denNgay, gomHeThong, rows, mucTieu }));
  cache.set(k, { het: now + CACHE_MS, hua });
  hua.catch(() => cache.delete(k));
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  return hua;
}

module.exports = { danhSachFinish };
