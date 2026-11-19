'use strict';

// ─── DONE DELIVERY THEO PHẦN IN (19/11/2026, người dùng chốt) ─────────────────────────────────────────────────────────
// "Ở giao hàng thêm modal DONE DELIVERY, nút DONE kế bên nút Nghẽn: phần in đã finish, tất cả SL đạt đã có phiếu giao;
//   SL giao < SLĐH thì phải hiện nút xác nhận … toggle chưa done giống bên finish."
// 1 phần in (code phần) DONE khi đủ:
//   · FINISH    — đã finish (7 điều kiện hoặc Chuyển finish — `modules/quality/finishPhanIn.docFinish`);
//   · HET_GIAO  — mọi SL đạt (qua OQC) đã nằm trên PHIẾU GIAO ĐÃ GIAO: Σ (sl_oqc_dat − sl_da_giao) của mọi tem = 0 và đã giao > 0
//                 (sổ cái `tem.sl_da_giao` chỉ cộng khi phiếu `DA_GIAO` — in phiếu = xác nhận giao);
//   · SL_GIAO   — SL giao (Σ `sl_da_giao`) ≥ SLĐH.
//   Đủ 3 ⇒ DONE TỰ ĐỘNG, ngày done = ngày giao (`giao_hang.ngay_giao`) của phiếu giao CUỐI.
//   Đủ FINISH + HET_GIAO mà SL giao < SLĐH ⇒ vào toggle "Chưa done" với nút "Xác nhận DONE" (quyền DELIVERY_MANAGE) ⇒ DONE,
//   ngày done = ngày bấm. Xác nhận chỉ MIỄN điều kiện SL_GIAO: phiếu bị hủy sau đó (HET_GIAO hỏng) ⇒ hết done tới khi giao lại.
//   Admin hủy được 1 lần xác nhận (ngay trong modal, chế độ Đã done).
// Trạng thái tay ở `audit_log` `ten_bang='phan_in_done_delivery'`, `id_ban_ghi` = phần in — dòng MỚI NHẤT thắng:
//   `XAC_NHAN_DONE` / `HUY_XAC_NHAN_DONE`. Không migration.
// Tem quy về phần in như Danh sách finish (`PIN_CUA_TEM`). SQL gửi 1 dòng (IPS), không `--` trong chuỗi.

const { query, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const sockets = require('../../sockets');
const { nhoDoc } = require('../../utils/cacheDoc');
const { soNgay } = require('../../utils/danhSachFinish');
const { docFinish } = require('../quality/finishPhanIn');
const { PIN_CUA_TEM, LENH_DOT } = require('../quality/danhSachFinish');

const AUDIT_DONE = 'phan_in_done_delivery';
const VN = "AT TIME ZONE 'Asia/Ho_Chi_Minh'";
const NGAY_GIAO = `COALESCE(gh.ngay_giao, (gh.created_date ${VN})::date)`;
const NGAY = (x) => `to_char((${x} ${VN})::date, 'YYYY-MM-DD')`;

// Ứng viên theo khoảng ngày: phần in có phiếu giao ĐÃ GIAO mang ngày giao trong khoảng (+ chế độ DONE: phần in được xác nhận
//   DONE trong khoảng). Phiếu `HT-…` (script dọn tồn — hệ thống tự chạy đến giao) chỉ vào khi `gomHeThong` (như Danh sách finish).
async function ungVien(tuNgay, denNgay, cheDo, gomHeThong) {
  const theoPhieu = `SELECT DISTINCT ${PIN_CUA_TEM} AS phan_in_id FROM giao_hang gh
      JOIN giao_hang_tem gt ON gt.giao_hang_id = gh.id JOIN tem t ON t.id = gt.tem_id
      JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
     WHERE gh.trang_thai = 'DA_GIAO' AND ${NGAY_GIAO} BETWEEN $1::date AND $2::date
       AND ($3::boolean OR gh.ma_phieu_giao NOT LIKE 'HT-%')`;
  const theoXacNhan = `SELECT a.id_ban_ghi::uuid FROM audit_log a WHERE a.ten_bang = '${AUDIT_DONE}' AND a.hanh_dong = 'XAC_NHAN_DONE'
       AND a.thoi_gian >= (($1::date)::timestamp ${VN}) AND a.thoi_gian < (($2::date + 1)::timestamp ${VN})`;
  const sql = cheDo === 'CHUA' ? theoPhieu : `${theoPhieu} UNION ${theoXacNhan}`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [tuNgay, denNgay, !!gomHeThong]);
  return rows.map((r) => r.phan_in_id).filter(Boolean);
}

// Số giao theo phần in + xác nhận tay mới nhất. `db` = client trong transaction (kiểm lại trước khi ghi) hoặc pool.
async function docGiao(ids, db = { query }) {
  if (!ids.length) return new Map();
  const sql = `WITH ung AS MATERIALIZED (SELECT DISTINCT u FROM unnest($1::uuid[]) u),
    lenh AS MATERIALIZED (SELECT DISTINCT ls.id FROM ung JOIN dot_vai_ve dv ON dv.phan_in_id = ung.u
        JOIN lenh_sx_dot_vai l ON l.dot_vai_ve_id = dv.id JOIN lenh_san_xuat ls ON ls.id = l.lenh_san_xuat_id AND ls.trang_thai <> 'HUY'),
    ta AS MATERIALIZED (
      SELECT z.* FROM (SELECT t.id, t.sl_oqc_dat, t.sl_da_giao, ${PIN_CUA_TEM} AS phan_in_id
          FROM tem t JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
         WHERE t.trang_thai <> 'HUY' AND ${LENH_DOT} IN (SELECT id FROM lenh) OFFSET 0) z
       WHERE z.phan_in_id IN (SELECT u FROM ung)),
    ag AS (SELECT phan_in_id, sum(COALESCE(sl_oqc_dat, 0))::int AS sl_qua_oqc, sum(COALESCE(sl_da_giao, 0))::int AS sl_giao,
             sum(GREATEST(COALESCE(sl_oqc_dat, 0) - COALESCE(sl_da_giao, 0), 0))::int AS con_giao
        FROM ta GROUP BY phan_in_id),
    ph AS (SELECT ta.phan_in_id, count(DISTINCT gh.id)::int AS so_phieu,
             string_agg(DISTINCT gh.ma_phieu_giao, ', ') AS ma_phieu, to_char(max(${NGAY_GIAO}), 'YYYY-MM-DD') AS ngay_giao_cuoi
        FROM ta JOIN giao_hang_tem gt ON gt.tem_id = ta.id JOIN giao_hang gh ON gh.id = gt.giao_hang_id AND gh.trang_thai = 'DA_GIAO'
       GROUP BY ta.phan_in_id),
    xn AS (SELECT DISTINCT ON (a.id_ban_ghi) a.id_ban_ghi, a.hanh_dong, a.thoi_gian, a.gia_tri_moi->>'ghi_chu' AS ghi_chu, nd.ho_ten
        FROM audit_log a LEFT JOIN nguoi_dung nd ON nd.id = a.nguoi_thuc_hien_id
       WHERE a.ten_bang = '${AUDIT_DONE}' AND a.hanh_dong IN ('XAC_NHAN_DONE', 'HUY_XAC_NHAN_DONE')
         AND a.id_ban_ghi IN (SELECT u::text FROM ung)
       ORDER BY a.id_ban_ghi, a.thoi_gian DESC)
    SELECT ung.u AS phan_in_id, COALESCE(ag.sl_qua_oqc, 0) AS sl_qua_oqc, COALESCE(ag.sl_giao, 0) AS sl_giao,
      COALESCE(ag.con_giao, 0) AS con_giao, COALESCE(ph.so_phieu, 0) AS so_phieu, ph.ma_phieu, ph.ngay_giao_cuoi,
      CASE WHEN xn.hanh_dong = 'XAC_NHAN_DONE' THEN jsonb_build_object('tg', xn.thoi_gian, 'ngay', ${NGAY('xn.thoi_gian')},
        'ghi_chu', xn.ghi_chu, 'nguoi', xn.ho_ten) END AS xac_nhan_done
    FROM ung LEFT JOIN ag ON ag.phan_in_id = ung.u LEFT JOIN ph ON ph.phan_in_id = ung.u
    LEFT JOIN xn ON xn.id_ban_ghi = ung.u::text`;
  const { rows } = await db.query(sql.replace(/\s+/g, ' '), [ids]);
  return new Map(rows.map((r) => [String(r.phan_in_id), r]));
}

const so = (v) => (v == null || v === '' ? 0 : Number(v) || 0);

// Chấm 1 phần in: `f` = dòng finish (`docFinish`), `g` = dòng giao (`docGiao`).
function danhGiaDone(f, g) {
  const sldh = so(f.so_luong_don_hang);
  const slGiao = so(g && g.sl_giao);
  const dk = {
    FINISH: !!f.finish,
    HET_GIAO: !!g && so(g.con_giao) === 0 && slGiao > 0,
    SL_GIAO: sldh > 0 && slGiao >= sldh,
  };
  const xn = (g && g.xac_nhan_done) || null;
  const nen = dk.FINISH && dk.HET_GIAO;
  const tuDong = nen && dk.SL_GIAO;
  const done = tuDong || (nen && !!xn);
  return {
    dk,
    done,
    // Xác nhận tay thắng (đã chốt ngày bấm) — kể cả khi sau đó giao thêm đủ SLĐH (cùng luật Chuyển finish).
    loai_done: !done ? null : (xn ? 'XAC_NHAN' : 'TU_DONG'),
    ngay_done: !done ? null : (xn ? xn.ngay : (g.ngay_giao_cuoi || null)),
    duoc_xac_nhan: nen && !dk.SL_GIAO && !xn,
  };
}

function ghiChuDone(r) {
  const f = (n) => so(n).toLocaleString('vi-VN');
  if (r.done && r.xac_nhan_done) {
    const x = r.xac_nhan_done;
    return `Xác nhận DONE${x.nguoi ? ` (${x.nguoi})` : ''}${x.ghi_chu ? `: ${x.ghi_chu}` : ''}`;
  }
  const p = [];
  if (!r.dk.FINISH) p.push('Chưa finish');
  if (!r.dk.HET_GIAO) p.push(so(r.con_giao) > 0 ? `Còn ${f(r.con_giao)} đạt chưa có phiếu giao` : 'Chưa có phiếu giao');
  if (!r.dk.SL_GIAO) p.push(so(r.so_luong_don_hang) > 0 ? `SL giao ${f(r.sl_giao)} < SLĐH ${f(r.so_luong_don_hang)}` : 'Chưa có SLĐH');
  return p.join(' · ');
}

// Đọc + chấm cho 1 tập phần in.
async function docDone(ids, db = { query }) {
  if (!ids.length) return [];
  const [fin, giao] = await Promise.all([docFinish({ cheDo: 'IDS', ids }, db), docGiao(ids, db)]);
  return fin.map((f) => {
    const g = giao.get(String(f.phan_in_id)) || null;
    const kq = danhGiaDone(f, g);
    const r = {
      ...f,
      sl_qua_oqc: so(g && g.sl_qua_oqc), sl_giao: so(g && g.sl_giao), con_giao: so(g && g.con_giao),
      so_phieu: so(g && g.so_phieu), ma_phieu: (g && g.ma_phieu) || '', ngay_giao_cuoi: (g && g.ngay_giao_cuoi) || null,
      xac_nhan_done: (g && g.xac_nhan_done) || null,
      ...kq,
    };
    r.chenh_lech_giao = r.sl_giao - so(r.so_luong_don_hang);
    r.ghi_chu_done = ghiChuDone(r);
    return r;
  });
}

const sapXep = (a, b) => {
  const k = (r) => [r.ngay || '', r.ten_khach_hang || '', r.ma_don_hang || '', r.ma_hang || '', r.ma_phan || ''];
  const x = k(a); const y = k(b);
  for (let i = 0; i < x.length; i += 1) { const c = x[i].localeCompare(y[i], 'vi'); if (c) return c; }
  return 0;
};

// Danh sách cho modal: DONE (ngày done trong khoảng) | CHUA (giao trong khoảng, chờ xác nhận DONE).
function danhSachDone(tuNgay, denNgay, cheDo, gomHeThong = false) {
  const cd = cheDo === 'CHUA' ? 'CHUA' : 'DONE';
  return nhoDoc('done-delivery', { tuNgay, denNgay, cd, he: gomHeThong ? 1 : 0 }, async () => {
    const rows = await docDone(await ungVien(tuNgay, denNgay, cd, gomHeThong));
    const giu = cd === 'CHUA'
      ? rows.filter((r) => r.duoc_xac_nhan)
      : rows.filter((r) => r.done && r.ngay_done && r.ngay_done >= tuNgay && r.ngay_done <= denNgay);
    return {
      meta: { tu_ngay: tuNgay, den_ngay: denNgay, che_do: cd, gom_he_thong: !!gomHeThong },
      items: giu.map((r) => {
        const ngay = cd === 'CHUA' ? r.ngay_giao_cuoi : r.ngay_done;
        return { ...r, ngay, so_ngay_ton_dong: soNgay(ngay, r.han_giao_hang) };
      }).sort(sapXep),
    };
  }, 15000);
}

// ─── GHI ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function trongKhoa(phanInId, fn) {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('done-delivery:' || $1::text))", [phanInId]);
    const [r] = await docDone([phanInId], client);
    if (!r) throw new AppError('Không tìm thấy phần in (hoặc đã bị hủy)', { status: 404, errorCode: 'NOT_FOUND' });
    return fn(client, r);
  });
}

// `clock_timestamp()`: trạng thái = dòng MỚI NHẤT theo `thoi_gian` (2 dòng cùng transaction không được trùng giờ).
async function ghiAudit(client, phanInId, hanhDong, giaTriMoi, actorId) {
  await client.query(`INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
    VALUES ($1, $2, $3, $4::jsonb, $5, clock_timestamp(), $5)`.replace(/\s+/g, ' '),
  [AUDIT_DONE, String(phanInId), hanhDong, JSON.stringify(giaTriMoi), actorId]);
}

const anhChup = (r) => ({
  ma_phan: r.ma_phan, sl_giao: r.sl_giao, sldh: so(r.so_luong_don_hang), sl_qua_oqc: r.sl_qua_oqc,
  con_giao: r.con_giao, ma_phieu: r.ma_phieu, finish: r.finish, loai_finish: r.loai_finish,
});

const chuanChu = (v, toiDa, ten) => {
  const s = String(v || '').trim();
  if (s.length > toiDa) throw new AppError(`${ten} tối đa ${toiDa} ký tự`, { status: 422, errorCode: 'QUA_DAI' });
  return s;
};

// "Xác nhận DONE" — phần in đã finish + mọi SL đạt đã có phiếu giao mà SL giao < SLĐH. Ghi chú tùy chọn.
async function xacNhanDone(phanInId, ghiChu, actorId) {
  const gc = chuanChu(ghiChu, 500, 'Ghi chú');
  const kq = await trongKhoa(phanInId, async (client, r) => {
    if (r.done) throw new AppError(`Phần in ${r.ma_phan} đã DONE`, { status: 409, errorCode: 'DA_DONE' });
    if (!r.duoc_xac_nhan) {
      throw new AppError(`Chưa xác nhận DONE được: ${ghiChuDone(r) || 'chưa đủ điều kiện'}`,
        { status: 409, errorCode: 'CHUA_DU_DIEU_KIEN' });
    }
    await ghiAudit(client, phanInId, 'XAC_NHAN_DONE', { ghi_chu: gc || null, ...anhChup(r) }, actorId);
    return { phan_in_id: phanInId, ma_phan: r.ma_phan };
  });
  sockets.emit('delivery:updated', { doneDelivery: true });
  return kq;
}

// Admin: hủy 1 lần xác nhận DONE (lý do bắt buộc) ⇒ phần in quay lại "Chưa done" nếu vẫn thiếu SL.
async function huyXacNhanDone(phanInId, lyDo, actorId) {
  const ly = chuanChu(lyDo, 500, 'Lý do');
  if (!ly) throw new AppError('Nhập lý do', { status: 422, errorCode: 'NO_LY_DO' });
  const kq = await trongKhoa(phanInId, async (client, r) => {
    if (!r.xac_nhan_done) throw new AppError('Phần in không được xác nhận DONE tay', { status: 409, errorCode: 'KHONG_XAC_NHAN' });
    await ghiAudit(client, phanInId, 'HUY_XAC_NHAN_DONE', { ly_do: ly, ma_phan: r.ma_phan, xac_nhan_luc: r.xac_nhan_done.tg }, actorId);
    return { phan_in_id: phanInId, ma_phan: r.ma_phan };
  });
  sockets.emit('delivery:updated', { doneDelivery: true });
  return kq;
}

module.exports = { AUDIT_DONE, danhSachDone, docDone, danhGiaDone, xacNhanDone, huyXacNhanDone };
