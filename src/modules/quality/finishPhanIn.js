'use strict';

// ─── DANH SÁCH FINISH THEO 7 ĐIỀU KIỆN (18/11/2026, người dùng chốt) ─────────────────────────────────────────────────
// Luật từng điều kiện + nút "Chuyển finish" + admin "Mở điều kiện": `utils/dieuKienFinish.js`. Ở đây: đọc số theo PHẦN IN
// (code phần) cho 1 TẬP ỨNG VIÊN rồi chấm điểm bằng `danhGiaFinish`; ghi trạng thái tay vào `audit_log` `phan_in_finish`.
//   · Chế độ FINISH (mặc định): ứng viên = phần in có tem TÍCH GIAO trong [tuNgay, denNgay] (giờ VN) + phần in được Chuyển
//     finish trong khoảng ⇒ giữ dòng ĐÃ finish có ngày finish trong khoảng.
//   · Chế độ CHUA (toggle "Chưa finish"): ứng viên = phần in có phiếu CHẠY HOÀN TẤT trong khoảng + phần in admin đang mở
//     điều kiện ⇒ giữ dòng CHƯA finish (kèm điều kiện còn thiếu, nút Chuyển finish).
//   · IDS: đúng các phần in truyền vào (kiểm lại trước khi ghi, trang admin tìm theo mã).
// Tem quy về phần in như mọi màn theo tem (`PIN_CUA_TEM`: lệnh gom set cũ ⇒ phần in đầu; tem 13 ⇒ đợt của tem).
// Gửi 1 dòng (IPS), không `--` trong chuỗi SQL. Danh sách cache theo phiên bản dữ liệu (`utils/cacheDoc`).

const { query, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const sockets = require('../../sockets');
const { chuyenTemSql } = require('../../utils/temChuyen');
const { nhoDoc } = require('../../utils/cacheDoc');
const { vaoSuaDuocSql } = require('../../utils/choSua');
const { sqlKhopMa } = require('../../utils/maPhanIn');
const { AUDIT_FINISH, danhGiaFinish, ghiChuThieu } = require('../../utils/dieuKienFinish');
const { soNgay } = require('../../utils/danhSachFinish');
const { conKcsSql, CON_OQC, notCancelledQc } = require('./quality.repository');
const { docMucTieu, PIN_CUA_TEM, LENH_DOT, PIN_INFO, JOIN_PIN, SLNV, coPhanLoaiLoi } = require('./danhSachFinish');

const VN = "AT TIME ZONE 'Asia/Ho_Chi_Minh'";
const T0 = `(($1::date)::timestamp ${VN})`;
const T1 = `(($2::date + 1)::timestamp ${VN})`;
const NGAY = (x) => `to_char((${x} ${VN})::date, 'YYYY-MM-DD')`;

// Dòng audit MỚI NHẤT của 1 cặp hành động cho mỗi phần in ứng viên (`ung`).
const moiNhat = (hanhDong) => `SELECT DISTINCT ON (a.id_ban_ghi) a.id_ban_ghi, a.hanh_dong, a.thoi_gian,
    a.gia_tri_moi->>'ly_do' AS ly_do, nd.ho_ten
  FROM audit_log a LEFT JOIN nguoi_dung nd ON nd.id = a.nguoi_thuc_hien_id
  WHERE a.ten_bang = '${AUDIT_FINISH}' AND a.hanh_dong IN (${hanhDong.map((h) => `'${h}'`).join(',')})
    AND a.id_ban_ghi IN (SELECT phan_in_id::text FROM ung)
  ORDER BY a.id_ban_ghi, a.thoi_gian DESC`;

// Tập ứng viên theo chế độ — mỗi chế độ chỉ dùng tham số của nó (Postgres báo lỗi tham số thừa không xác định kiểu).
const UNG = {
  FINISH: `SELECT ${PIN_CUA_TEM} AS phan_in_id FROM tem t JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
      JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
     WHERE t.da_tich_giao AND t.trang_thai <> 'HUY' AND t.tg_tich_giao >= ${T0} AND t.tg_tich_giao < ${T1}
       AND ($3::boolean OR t.ma_tem NOT LIKE 'HT-%')
    UNION SELECT a.id_ban_ghi::uuid FROM audit_log a WHERE a.ten_bang = '${AUDIT_FINISH}' AND a.hanh_dong = 'CHUYEN_FINISH'
       AND a.thoi_gian >= ${T0} AND a.thoi_gian < ${T1}`,
  CHUA: `SELECT dv.phan_in_id FROM phieu_san_xuat ps JOIN lenh_sx_dot_vai l ON l.lenh_san_xuat_id = ps.lenh_san_xuat_id
      JOIN dot_vai_ve dv ON dv.id = l.dot_vai_ve_id
     WHERE ps.trang_thai = 'HOAN_TAT' AND ps.tg_kt >= ${T0} AND ps.tg_kt < ${T1}
    UNION SELECT x.id_ban_ghi::uuid FROM (SELECT DISTINCT ON (a.id_ban_ghi) a.id_ban_ghi, a.hanh_dong FROM audit_log a
       WHERE a.ten_bang = '${AUDIT_FINISH}' AND a.hanh_dong IN ('MO_DIEU_KIEN', 'DONG_DIEU_KIEN')
       ORDER BY a.id_ban_ghi, a.thoi_gian DESC) x WHERE x.hanh_dong = 'MO_DIEU_KIEN'`,
  IDS: 'SELECT unnest($1::uuid[])',
};

async function sqlFinish(ung) {
  const chuyenTem = await chuyenTemSql();
  const pll = (await coPhanLoaiLoi())
    ? 'UNION ALL SELECT p.tem_id, COALESCE(p.updated_date, p.created_date) FROM phan_loai_loi p WHERE COALESCE(p.sl_huy_luc_luu, 0) > 0'
    : '';
  return `WITH ung AS MATERIALIZED (SELECT DISTINCT u.phan_in_id FROM (${ung}) u(phan_in_id) WHERE u.phan_in_id IS NOT NULL),
    lenh AS MATERIALIZED (
      SELECT DISTINCT dv.phan_in_id, ls.id, ls.trang_thai FROM ung JOIN dot_vai_ve dv ON dv.phan_in_id = ung.phan_in_id
        JOIN lenh_sx_dot_vai l ON l.dot_vai_ve_id = dv.id JOIN lenh_san_xuat ls ON ls.id = l.lenh_san_xuat_id AND ls.trang_thai <> 'HUY'),
    lx AS (
      SELECT lenh.phan_in_id, count(*)::int AS so_lenh, count(*) FILTER (WHERE NOT ph.xong)::int AS so_lenh_chua_xong,
             max(ph.tg_kt) AS tg_hoan_tat
        FROM lenh CROSS JOIN LATERAL (
          SELECT (lenh.trang_thai IN ('SAN_XUAT', 'HOAN_TAT') AND bool_or(p.trang_thai = 'HOAN_TAT') IS TRUE
                  AND NOT COALESCE(bool_or(p.trang_thai = 'DANG_CHAY'), false)) AS xong,
                 max(p.tg_kt) FILTER (WHERE p.trang_thai = 'HOAN_TAT') AS tg_kt
            FROM phieu_san_xuat p WHERE p.lenh_san_xuat_id = lenh.id) ph
       GROUP BY lenh.phan_in_id),
    ta AS MATERIALIZED (
      SELECT z.* FROM (SELECT t.id, t.so_luong, t.sl_chenh_lech, t.sl_kcs_dat, t.sl_kcs_sua, t.sl_kcs_huy, t.sl_sua_dat,
            t.sl_sua_huy, t.sl_oqc_dat, t.sl_sua_tach, t.tem_goc_id, t.cong_doan_dau, t.da_tich_giao, t.tg_tich_giao,
            ${chuyenTem} AS chuyen_id, ${PIN_CUA_TEM} AS phan_in_id
          FROM tem t JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
         WHERE t.trang_thai <> 'HUY' AND ${LENH_DOT} IN (SELECT id FROM lenh) OFFSET 0) z
       WHERE z.phan_in_id IN (SELECT phan_in_id FROM ung)),
    ag AS (
      SELECT t.phan_in_id, count(*)::int AS so_tem, sum(COALESCE(t.so_luong, 0))::int AS slin,
        sum(GREATEST(${conKcsSql('t.')}, 0))::int AS con_kcs,
        count(*) FILTER (WHERE t.tem_goc_id IS NULL AND (t.sl_kcs_sua + t.sl_kcs_huy) > 0 AND NOT ${vaoSuaDuocSql('t')})::int AS chua_phan_loai,
        sum(GREATEST(t.sl_kcs_sua - t.sl_sua_dat - t.sl_sua_huy, 0))::int AS con_sua,
        sum(GREATEST(${CON_OQC}, 0))::int AS con_oqc,
        count(*) FILTER (WHERE COALESCE(t.sl_oqc_dat, 0) > 0 AND NOT t.da_tich_giao)::int AS chua_tich,
        COALESCE(sum(t.sl_oqc_dat) FILTER (WHERE t.da_tich_giao), 0)::int AS sl_dat,
        max(t.tg_tich_giao) FILTER (WHERE t.da_tich_giao) AS tg_tich,
        sum(CASE WHEN t.tem_goc_id IS NULL THEN t.sl_kcs_sua + t.sl_kcs_huy ELSE 0 END)::int AS ton_cuoi,
        sum(t.sl_sua_dat)::int AS sua_dat,
        sum(t.sl_sua_huy + CASE WHEN t.tem_goc_id IS NULL THEN t.sl_kcs_huy ELSE 0 END)::int AS sua_huy
        FROM ta t GROUP BY t.phan_in_id),
    ch AS (
      SELECT t.phan_in_id, COALESCE(json_agg(DISTINCT jsonb_build_object('ma_chuyen', cs.ma_chuyen, 'ten_chuyen', cs.ten_chuyen,
               'ma_loai_chuyen', lc.ma_loai)) FILTER (WHERE cs.id IS NOT NULL), '[]') AS chuyen,
             string_agg(DISTINCT cs.ma_chuyen, ', ') AS ma_chuyen
        FROM ta t LEFT JOIN chuyen_san_xuat cs ON cs.id = t.chuyen_id LEFT JOIN loai_chuyen lc ON lc.id = cs.loai_chuyen_id
       GROUP BY t.phan_in_id),
    kq AS (
      SELECT ta.phan_in_id, max(e.tg) AS tg FROM ta JOIN (
          SELECT s.tem_id, s.created_date AS tg FROM sua s WHERE ${notCancelledQc('s', 'sua')} ${pll}
        ) e ON e.tem_id = ta.id GROUP BY ta.phan_in_id),
    tc AS (${moiNhat(['CHUYEN_FINISH', 'HUY_CHUYEN_FINISH'])}),
    md AS (${moiNhat(['MO_DIEU_KIEN', 'DONG_DIEU_KIEN'])})
    SELECT ung.phan_in_id, ${PIN_INFO}, pin.luong_sx, ${SLNV('pin.id')} AS slnv,
      COALESCE(lx.so_lenh, 0) AS so_lenh, COALESCE(lx.so_lenh_chua_xong, 0) AS so_lenh_chua_xong,
      lx.tg_hoan_tat, ${NGAY('lx.tg_hoan_tat')} AS ngay_hoan_tat,
      COALESCE(ag.so_tem, 0) AS so_tem, COALESCE(ag.slin, 0) AS slin, COALESCE(ag.con_kcs, 0) AS con_kcs,
      COALESCE(ag.chua_phan_loai, 0) AS chua_phan_loai, COALESCE(ag.con_sua, 0) AS con_sua, COALESCE(ag.con_oqc, 0) AS con_oqc,
      COALESCE(ag.chua_tich, 0) AS chua_tich, COALESCE(ag.sl_dat, 0) AS sl_dat, ag.tg_tich, ${NGAY('ag.tg_tich')} AS ngay_tich,
      COALESCE(ag.ton_cuoi, 0) AS ton_cuoi, COALESCE(ag.sua_dat, 0) AS sua_dat, COALESCE(ag.sua_huy, 0) AS sua_huy,
      COALESCE(ch.chuyen, '[]') AS chuyen, ch.ma_chuyen,
      to_char((SELECT min(hv.han_giao_hang) FROM dot_vai_ve hv WHERE hv.phan_in_id = ung.phan_in_id
        AND hv.trang_thai NOT IN ('DA_GOP', 'DA_HUY')), 'YYYY-MM-DD') AS han_giao_hang,
      ${NGAY('kq.tg')} AS ngay_cap_nhat_ket_qua,
      CASE WHEN tc.hanh_dong = 'CHUYEN_FINISH' THEN jsonb_build_object('tg', tc.thoi_gian, 'ngay', ${NGAY('tc.thoi_gian')},
        'ly_do', tc.ly_do, 'nguoi', tc.ho_ten) END AS chuyen_finish,
      CASE WHEN md.hanh_dong = 'MO_DIEU_KIEN' THEN jsonb_build_object('tg', md.thoi_gian, 'ly_do', md.ly_do,
        'nguoi', md.ho_ten) END AS mo_dieu_kien
    FROM ung JOIN phan_in pin ON pin.id = ung.phan_in_id ${JOIN_PIN}
    LEFT JOIN lx ON lx.phan_in_id = ung.phan_in_id LEFT JOIN ag ON ag.phan_in_id = ung.phan_in_id
    LEFT JOIN ch ON ch.phan_in_id = ung.phan_in_id LEFT JOIN kq ON kq.phan_in_id = ung.phan_in_id
    LEFT JOIN tc ON tc.id_ban_ghi = ung.phan_in_id::text LEFT JOIN md ON md.id_ban_ghi = ung.phan_in_id::text
    WHERE pin.dang_hoat_dong`;
}

// Đọc + chấm điểm. `db` = client trong transaction (kiểm lại trước khi ghi) hoặc mặc định pool.
async function docFinish({ cheDo, tuNgay, denNgay, gomHeThong = false, ids = [] }, db = { query }) {
  const ma = UNG[cheDo] ? cheDo : 'FINISH';
  if (ma === 'IDS' && !ids.length) return [];
  const thamSo = ma === 'IDS' ? [ids] : ma === 'FINISH' ? [tuNgay, denNgay, !!gomHeThong] : [tuNgay, denNgay];
  const sql = await sqlFinish(UNG[ma]);
  const { rows } = await db.query(sql.replace(/\s+/g, ' '), thamSo);
  // `mo_dieu_kien` SQL = {tg, ly_do, nguoi} | null ⇒ giữ ở `mo_dieu_kien_info`; `danhGiaFinish` đặt lại thành true/false.
  return rows.map((r) => ({ ...r, mo_dieu_kien_info: r.mo_dieu_kien || null, ...danhGiaFinish(r) }));
}

// Dòng hiển thị (giữ đủ cột của tờ "DANH SÁCH FINISH" như bản cũ): `ngay` = ngày finish (chế độ FINISH) hoặc ngày chạy hoàn
//   tất gần nhất (chế độ CHUA) · Sgiao = SL đạt đã tích giao · SL còn lại = chờ sửa.
function dongHienThi(r, cheDo) {
  const ngay = cheDo === 'CHUA' ? r.ngay_hoan_tat : r.ngay_finish;
  const tay = r.chuyen_finish;
  return {
    ...r,
    ngay,
    sgiao: r.sl_dat,
    sl_con_lai: r.con_sua,
    chenh_lech: (Number(r.sl_dat) || 0) - (Number(r.so_luong_don_hang) || 0),
    so_ngay_ton_dong: soNgay(ngay, r.han_giao_hang),
    ghi_chu: r.finish
      ? (tay ? `Chuyển finish${tay.nguoi ? ` (${tay.nguoi})` : ''}: ${tay.ly_do || ''}` : '')
      : ghiChuThieu(r, r),
  };
}

const sapXep = (a, b) => {
  const k = (r) => [r.ngay || '', r.ten_khach_hang || '', r.ma_don_hang || '', r.ma_hang || '', r.ma_phan || ''];
  const x = k(a); const y = k(b);
  for (let i = 0; i < x.length; i += 1) { const c = x[i].localeCompare(y[i], 'vi'); if (c) return c; }
  return 0;
};

// Danh sách cho modal (chế độ FINISH | CHUA) + khối MỤC TIÊU của ngày tiêu đề (giữ như bản cũ).
function danhSachFinishPhanIn(tuNgay, denNgay, gomHeThong = false, cheDo = 'FINISH') {
  const cd = cheDo === 'CHUA' ? 'CHUA' : 'FINISH';
  return nhoDoc('danh-sach-finish-7dk', { tuNgay, denNgay, he: gomHeThong ? 1 : 0, cd }, async () => {
    const [rows, mucTieu] = await Promise.all([docFinish({ cheDo: cd, tuNgay, denNgay, gomHeThong }), docMucTieu(denNgay)]);
    const giu = cd === 'CHUA'
      ? rows.filter((r) => !r.finish)
      : rows.filter((r) => r.finish && r.ngay_finish && r.ngay_finish >= tuNgay && r.ngay_finish <= denNgay);
    return {
      meta: { tu_ngay: tuNgay, den_ngay: denNgay, ngay_tieu_de: denNgay, gom_he_thong: !!gomHeThong, che_do: cd },
      nguon: 'SX',
      items: giu.map((r) => dongHienThi(r, cd)).sort(sapXep),
      muc_tieu: mucTieu.map((r) => ({ ...r, so_luong_don_hang: Number(r.so_luong_don_hang) || 0, slnv: Number(r.slnv) || 0 })),
    };
  }, 15000);
}

// ─── Trang admin "Mở điều kiện finish": theo khoảng ngày chạy hoàn tất (như chế độ CHUA) hoặc TÌM theo code phần / TDTHĐH
//   (mọi trạng thái — để thấy cả phần in đã Chuyển finish mà hủy). Tìm ≤ 100 phần in.
async function danhSachMoDieuKien({ tuNgay, denNgay, q }) {
  const tim = String(q || '').trim();
  if (tim.length >= 3) {
    const { rows } = await query(`SELECT pin.id FROM phan_in pin WHERE pin.dang_hoat_dong
      AND (pin.ma_phan ILIKE $1 OR ${sqlKhopMa('pin.barcode', '$2')}) ORDER BY pin.ma_phan LIMIT 100`.replace(/\s+/g, ' '),
    [`%${tim.replace(/[%_\\]/g, (c) => `\\${c}`)}%`, tim]);
    const items = await docFinish({ cheDo: 'IDS', ids: rows.map((r) => r.id) });
    return { items: items.map((r) => dongHienThi(r, 'CHUA')).sort(sapXep), tim: true };
  }
  const items = (await docFinish({ cheDo: 'CHUA', tuNgay, denNgay })).filter((r) => !r.finish);
  return { items: items.map((r) => dongHienThi(r, 'CHUA')).sort(sapXep), tim: false };
}

// ─── GHI ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const chuanLyDo = (lyDo) => {
  const s = String(lyDo || '').trim();
  if (!s) throw new AppError('Nhập lý do', { status: 422, errorCode: 'NO_LY_DO' });
  if (s.length > 500) throw new AppError('Lý do tối đa 500 ký tự', { status: 422, errorCode: 'LY_DO_QUA_DAI' });
  return s;
};

// Khóa theo phần in (2 người bấm cùng lúc) rồi đọc LẠI trạng thái trong transaction trước khi ghi.
async function trongKhoa(phanInId, fn) {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('finish:' || $1::text))", [phanInId]);
    const [r] = await docFinish({ cheDo: 'IDS', ids: [phanInId] }, client);
    if (!r) throw new AppError('Không tìm thấy phần in (hoặc đã bị hủy)', { status: 404, errorCode: 'NOT_FOUND' });
    return fn(client, r);
  });
}

// ⚠ `clock_timestamp()` (không phải CURRENT_TIMESTAMP = giờ ĐẦU transaction): trạng thái = dòng MỚI NHẤT theo `thoi_gian`,
//   2 dòng cùng giờ thì không phân được dòng nào sau.
async function ghiAudit(client, phanInId, hanhDong, giaTriMoi, actorId) {
  await client.query(`INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
    VALUES ($1, $2, $3, $4::jsonb, $5, clock_timestamp(), $5)`.replace(/\s+/g, ' '),
  [AUDIT_FINISH, String(phanInId), hanhDong, JSON.stringify(giaTriMoi), actorId]);
}

const daDoi = () => sockets.emit('quality:updated', { finish: true });

// Ảnh chụp số lúc ghi (để tra lại vì sao được chuyển).
const anhChup = (r) => ({
  ma_phan: r.ma_phan, sl_dat: Number(r.sl_dat) || 0, sldh: Number(r.so_luong_don_hang) || 0, thieu: r.thieu,
  so_lenh: r.so_lenh, con_kcs: r.con_kcs, chua_phan_loai: r.chua_phan_loai, con_sua: r.con_sua, con_oqc: r.con_oqc,
  chua_tich: r.chua_tich,
});

// "Chuyển finish" — người dùng (quyền ở route) bấm ở modal Danh sách finish, chế độ Chưa finish.
async function chuyenFinish(phanInId, lyDo, actorId) {
  const ly = chuanLyDo(lyDo);
  const kq = await trongKhoa(phanInId, async (client, r) => {
    if (r.finish) throw new AppError(`Phần in ${r.ma_phan} đã finish`, { status: 409, errorCode: 'DA_FINISH' });
    if (!r.duoc_chuyen) {
      throw new AppError(`Chưa đủ điều kiện chuyển finish: ${ghiChuThieu(r, r) || 'chưa chạy hoàn tất'}`,
        { status: 409, errorCode: 'CHUA_DU_DIEU_KIEN', details: r.thieu });
    }
    await ghiAudit(client, phanInId, 'CHUYEN_FINISH', { ly_do: ly, mo_dieu_kien: !!r.mo_dieu_kien, ...anhChup(r) }, actorId);
    return { phan_in_id: phanInId, ma_phan: r.ma_phan };
  });
  daDoi();
  return kq;
}

// Admin: hủy 1 lần Chuyển finish (phần in về tính theo điều kiện).
async function huyChuyenFinish(phanInId, lyDo, actorId) {
  const ly = chuanLyDo(lyDo);
  const kq = await trongKhoa(phanInId, async (client, r) => {
    if (!r.chuyen_finish) throw new AppError('Phần in không được chuyển finish tay', { status: 409, errorCode: 'KHONG_CHUYEN_TAY' });
    await ghiAudit(client, phanInId, 'HUY_CHUYEN_FINISH', { ly_do: ly, ma_phan: r.ma_phan, chuyen_luc: r.chuyen_finish.tg }, actorId);
    return { phan_in_id: phanInId, ma_phan: r.ma_phan };
  });
  daDoi();
  return kq;
}

// Admin: mở / đóng điều kiện — mở ⇒ người dùng bấm được Chuyển finish chỉ cần đã chạy hoàn tất.
async function datMoDieuKien(phanInId, mo, lyDo, actorId) {
  const ly = chuanLyDo(lyDo);
  const kq = await trongKhoa(phanInId, async (client, r) => {
    if (mo) {
      if (r.finish) throw new AppError(`Phần in ${r.ma_phan} đã finish`, { status: 409, errorCode: 'DA_FINISH' });
      if (!r.dk.CHAY) {
        throw new AppError(`Phần in ${r.ma_phan} chưa xác nhận chạy hoàn tất — chưa mở được`,
          { status: 409, errorCode: 'CHUA_CHAY_HOAN_TAT' });
      }
      if (r.mo_dieu_kien) throw new AppError('Phần in đang mở điều kiện rồi', { status: 409, errorCode: 'DA_MO' });
    } else if (!r.mo_dieu_kien) throw new AppError('Phần in đang không mở điều kiện', { status: 409, errorCode: 'CHUA_MO' });
    await ghiAudit(client, phanInId, mo ? 'MO_DIEU_KIEN' : 'DONG_DIEU_KIEN', { ly_do: ly, ...anhChup(r) }, actorId);
    return { phan_in_id: phanInId, ma_phan: r.ma_phan, mo: !!mo };
  });
  daDoi();
  return kq;
}

module.exports = { docFinish, danhSachFinishPhanIn, danhSachMoDieuKien, chuyenFinish, huyChuyenFinish, datMoDieuKien };
