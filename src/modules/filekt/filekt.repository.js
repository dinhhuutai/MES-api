'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// GHI NHẬN FILE PHẦN IN XUỐNG PHÒNG KỸ THUẬT (17/11/2026, mig 136) — SQL + LUẬT KHỚP MÃ.
// Phòng bán hàng đưa file (HSKT / Bảng TDTHĐH) xuống Phòng KT ⇒ quét mã vạch trên giấy ⇒ 1 dòng `file_kt_quet` (giờ quét =
//   thời gian thực tế). Khớp được phần in ⇒ dòng `file_kt_quet_phan_in`; chưa khớp ⇒ CHO_GHEP, đồng bộ ERP sau đó TỰ GHÉP.
//
// LUẬT KHỚP (`MATCH_CTE` — dùng chung lúc quét lẫn lúc tự ghép, đừng chép):
//   · TDTHDH  (11 số)  ⇒ `phan_in.barcode` (DANH SÁCH ngăn phẩy ⇒ `sqlKhopMa`, không `=`).
//   · HSKT    (12 số)  ⇒ 11 SỐ ĐẦU `ho_so_ky_thuat.barcode_hskt` (số cuối = phương án in, đổi được) ⇒ MỌI phần in đang gắn hồ sơ.
//   · CODE_PHAN (khác) ⇒ `phan_in.ma_phan` không phân biệt hoa thường (QR code phần; 2 màu mực = 2 phần in ⇒ ghép cả 2).
//   Chỉ phần in `dang_hoat_dong`. Lượt HỦY không ghép. Tự ghép xét lượt quét trong `NGAY_GHEP` ngày — gồm cả lượt ĐÃ ghép
//   (mã HSKT phủ nhiều code phần: phần in lên MES sau vẫn nhận đúng giờ file xuống KT của hồ sơ).
// "File xuống KT" của phần in = lượt quét SỚM NHẤT (chưa hủy) có ghép phần in đó.
// ⚠ Mọi câu gộp 1 dòng (IPS), không `--` trong chuỗi SQL.
// ─────────────────────────────────────────────────────────────────────────────

const { query, withTransaction } = require('../../config/db');
const { sqlKhopMa } = require('../../utils/maPhanIn');
const { mauTim } = require('../../utils/timKiem');

const q1 = (sql) => sql.replace(/\s+/g, ' ').trim();
const NGAY_GHEP = 180;
const VN = "AT TIME ZONE 'Asia/Ho_Chi_Minh'";

// Bảng có chưa (mig 136). Có rồi thì nhớ luôn; chưa có thì 60 giây hỏi lại (chạy migration xong không phải restart).
let coBangCache = null;
let coBangHan = 0;
async function coBang() {
  if (coBangCache === true || (coBangCache === false && Date.now() < coBangHan)) return coBangCache;
  const { rows } = await query("SELECT to_regclass('public.file_kt_quet') IS NOT NULL AND to_regclass('public.file_kt_quet_phan_in') IS NOT NULL AS co");
  coBangCache = !!rows[0].co;
  coBangHan = Date.now() + 60000;
  return coBangCache;
}

// Loại mã theo DẠNG (máy quét gửi nguyên chuỗi): 11 số = TDTHĐH · 12 số = HSKT · còn lại = code phần.
function loaiMa(ma) {
  if (/^\d{11}$/.test(ma)) return 'TDTHDH';
  if (/^\d{12}$/.test(ma)) return 'HSKT';
  return 'CODE_PHAN';
}

// Cặp (lượt quét, phần in) khớp — `q` = tập lượt quét (CTE có id, ma_quet, loai_ma).
const MATCH_CTE = q1(`m AS (
    SELECT q.id AS quet_id, p.id AS phan_in_id FROM q
      JOIN phan_in p ON q.loai_ma = 'TDTHDH' AND p.dang_hoat_dong AND p.barcode LIKE '%' || q.ma_quet || '%'
       AND ${sqlKhopMa('p.barcode', 'q.ma_quet')}
    UNION
    SELECT q.id, p.id FROM q
      JOIN ho_so_ky_thuat h ON q.loai_ma = 'HSKT' AND h.barcode_hskt ~ '^[0-9]{12}$' AND left(h.barcode_hskt, 11) = left(q.ma_quet, 11)
      JOIN hskt_phan_in hp ON hp.hskt_id = h.id AND hp.dang_hoat_dong
      JOIN phan_in p ON p.id = hp.phan_in_id AND p.dang_hoat_dong
    UNION
    SELECT q.id, p.id FROM q
      JOIN phan_in p ON q.loai_ma = 'CODE_PHAN' AND p.dang_hoat_dong AND upper(btrim(p.ma_phan)) = upper(q.ma_quet))`);

// Ghép lượt quét ↔ phần in còn thiếu + đổi CHO_GHEP ⇒ DA_GHEP. `quetId` null = mọi lượt trong `NGAY_GHEP` ngày.
// Trả { so_cap_moi, so_luot_moi_ghep, luot: [{ id, ma_quet }] } (luot = lượt vừa từ CHO_GHEP sang DA_GHEP).
async function ghepTx(client, { quetId = null, cach = 'TU_DONG', actorId = null } = {}) {
  const { rows: cap } = await client.query(q1(`
    WITH q AS (SELECT id, ma_quet, loai_ma FROM file_kt_quet
                WHERE trang_thai <> 'HUY' AND ($1::uuid IS NULL OR id = $1::uuid)
                  AND tg_quet > now() - make_interval(days => $4::int)),
         ${MATCH_CTE}
    INSERT INTO file_kt_quet_phan_in (quet_id, phan_in_id, cach_ghep, tg_ghep, created_date, created_by)
    SELECT m.quet_id, m.phan_in_id, $2, now(), now(), $3::uuid FROM m
    ON CONFLICT (quet_id, phan_in_id) DO NOTHING
    RETURNING quet_id`), [quetId, cach, actorId, NGAY_GHEP]);
  const { rows: luot } = await client.query(q1(`
    UPDATE file_kt_quet q SET trang_thai = 'DA_GHEP', tg_ghep = now(), updated_date = now(), updated_by = $2::uuid
     WHERE q.trang_thai = 'CHO_GHEP' AND ($1::uuid IS NULL OR q.id = $1::uuid)
       AND EXISTS (SELECT 1 FROM file_kt_quet_phan_in x WHERE x.quet_id = q.id)
    RETURNING q.id, q.ma_quet`), [quetId, actorId]);
  return { so_cap_moi: cap.length, so_luot_moi_ghep: luot.length, luot };
}

// Tự ghép (sau đồng bộ ERP / nút "Ghép lại"). Chưa có bảng ⇒ bỏ qua.
async function ghepTuDong(actorId = null) {
  if (!(await coBang())) return { so_cap_moi: 0, so_luot_moi_ghep: 0, luot: [], chua_migration: true };
  return withTransaction(async (client) => {
    // 2 lượt ghép chạy cùng lúc (job đồng bộ + nút) ⇒ xếp hàng, khỏi đụng UNIQUE giữa chừng.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('file_kt_ghep'))");
    return ghepTx(client, { cach: 'TU_DONG', actorId });
  });
}

// Thông tin phần in để hiện (khách · đơn · mã hàng · màu / kích · ngày lên MES) — alias `p`.
const PIN_COT = `p.id, p.ma_phan, p.mau_in, p.mau_vai, p.kich_vai, p.kich_phim, p.created_date AS tg_len_mes,
  kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang`;
const PIN_JOIN = `LEFT JOIN ma_hang mh ON mh.id = p.ma_hang_id LEFT JOIN don_hang dh ON dh.id = mh.don_hang_id
  LEFT JOIN khach_hang kh ON kh.id = dh.khach_hang_id`;

// Ghi 1 lượt quét + ghép ngay. Trả lượt quét + phần in khớp + các lượt quét TRƯỚC của cùng mã (chưa hủy).
async function ghiQuet({ ma, loai, ghiChu = null, actorId }) {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('file_kt_ghep'))");
    const { rows: [luot] } = await client.query(q1(`
      INSERT INTO file_kt_quet (ma_quet, loai_ma, tg_quet, nguoi_quet_id, ghi_chu, created_date, created_by)
      VALUES ($1, $2, now(), $3::uuid, $4, now(), $3::uuid) RETURNING id, ma_quet, loai_ma, tg_quet`), [ma, loai, actorId, ghiChu]);
    await ghepTx(client, { quetId: luot.id, cach: 'KHI_QUET', actorId });
    const { rows: pin } = await client.query(q1(`
      SELECT ${PIN_COT} FROM file_kt_quet_phan_in x JOIN phan_in p ON p.id = x.phan_in_id ${PIN_JOIN}
       WHERE x.quet_id = $1 ORDER BY p.ma_phan`), [luot.id]);
    const { rows: truoc } = await client.query(q1(`
      SELECT q.tg_quet, nd.ho_ten AS nguoi FROM file_kt_quet q LEFT JOIN nguoi_dung nd ON nd.id = q.nguoi_quet_id
       WHERE q.ma_quet = $1 AND q.id <> $2 AND q.trang_thai <> 'HUY' ORDER BY q.tg_quet`), [ma, luot.id]);
    return { ...luot, trang_thai: pin.length ? 'DA_GHEP' : 'CHO_GHEP', phan_in: pin, quet_truoc: truoc };
  });
}

// Bộ lọc chung của danh sách lượt quét (trừ trạng thái — để đếm chip).
function locQuet({ tuNgay, denNgay, search }, p) {
  const dk = [];
  if (tuNgay) { p.push(tuNgay); dk.push(`(q.tg_quet ${VN})::date >= $${p.length}::date`); }
  if (denNgay) { p.push(denNgay); dk.push(`(q.tg_quet ${VN})::date <= $${p.length}::date`); }
  const m = mauTim(search);
  if (m) {
    p.push(m);
    const n = `$${p.length}`;
    dk.push(`(q.ma_quet ~* ${n} OR COALESCE(q.ghi_chu, '') ~* ${n} OR nd.ho_ten ~* ${n} OR EXISTS (
      SELECT 1 FROM file_kt_quet_phan_in xs JOIN phan_in ps ON ps.id = xs.phan_in_id
        LEFT JOIN ma_hang mhs ON mhs.id = ps.ma_hang_id LEFT JOIN don_hang dhs ON dhs.id = mhs.don_hang_id
        LEFT JOIN khach_hang khs ON khs.id = dhs.khach_hang_id
       WHERE xs.quet_id = q.id AND (ps.ma_phan ~* ${n} OR dhs.ma_don_hang ~* ${n} OR mhs.ma_hang ~* ${n} OR khs.ten_khach_hang ~* ${n})))`);
  }
  return dk;
}

// LỊCH SỬ QUÉT — mới nhất trước. Mỗi dòng mang tối đa 30 phần in đã ghép + số lần mã này đã được quét (chưa hủy).
async function dsQuet({ tuNgay = '', denNgay = '', search = '', trangThai = '', offset = 0, limit = 20 }) {
  const p = [];
  const dk = locQuet({ tuNgay, denNgay, search }, p);
  const FROM = 'FROM file_kt_quet q LEFT JOIN nguoi_dung nd ON nd.id = q.nguoi_quet_id';
  const WHERE = dk.length ? `WHERE ${dk.join(' AND ')}` : '';
  const dem = (await query(q1(`SELECT q.trang_thai, count(*)::int AS so ${FROM} ${WHERE} GROUP BY 1`), p)).rows;
  const pd = [...p];
  let dkTt = '';
  if (['CHO_GHEP', 'DA_GHEP', 'HUY'].includes(trangThai)) { pd.push(trangThai); dkTt = `${WHERE ? 'AND' : 'WHERE'} q.trang_thai = $${pd.length}`; }
  pd.push(limit, offset);
  const { rows } = await query(q1(`
    SELECT q.id, q.ma_quet, q.loai_ma, q.tg_quet, q.trang_thai, q.tg_ghep, q.ghi_chu, q.ly_do_huy, q.tg_huy,
           nd.ho_ten AS nguoi_quet, ndh.ho_ten AS nguoi_huy,
           (SELECT count(*) FROM file_kt_quet q2 WHERE q2.ma_quet = q.ma_quet AND q2.trang_thai <> 'HUY')::int AS so_lan_quet_ma,
           (SELECT count(*) FROM file_kt_quet_phan_in x WHERE x.quet_id = q.id)::int AS so_phan_in,
           COALESCE((SELECT json_agg(z ORDER BY z.ma_phan) FROM (
              SELECT ${PIN_COT}, x.cach_ghep, x.tg_ghep FROM file_kt_quet_phan_in x JOIN phan_in p ON p.id = x.phan_in_id ${PIN_JOIN}
               WHERE x.quet_id = q.id ORDER BY p.ma_phan LIMIT 30) z), '[]'::json) AS phan_in
      ${FROM} LEFT JOIN nguoi_dung ndh ON ndh.id = q.nguoi_huy_id ${WHERE} ${dkTt}
     ORDER BY q.tg_quet DESC, q.id
     LIMIT $${pd.length - 1} OFFSET $${pd.length}`), pd);
  const demMap = { CHO_GHEP: 0, DA_GHEP: 0, HUY: 0 };
  dem.forEach((r) => { demMap[r.trang_thai] = r.so; });
  const tong = demMap.CHO_GHEP + demMap.DA_GHEP + demMap.HUY;
  const total = ['CHO_GHEP', 'DA_GHEP', 'HUY'].includes(trangThai) ? demMap[trangThai] : tong;
  return { rows, total, dem: { '': tong, ...demMap } };
}

// THEO PHẦN IN — mỗi phần in đã ghép: giờ file xuống KT (lượt quét sớm nhất chưa hủy) · người quét · số lượt · giờ lên MES.
//   Lọc ngày theo GIỜ FILE XUỐNG KT.
async function dsPhanIn({ tuNgay = '', denNgay = '', search = '', offset = 0, limit = 20 }) {
  const p = [];
  const dk = [];
  if (tuNgay) { p.push(tuNgay); dk.push(`(f.tg_file_kt ${VN})::date >= $${p.length}::date`); }
  if (denNgay) { p.push(denNgay); dk.push(`(f.tg_file_kt ${VN})::date <= $${p.length}::date`); }
  const m = mauTim(search);
  if (m) {
    p.push(m);
    const n = `$${p.length}`;
    dk.push(`(p.ma_phan ~* ${n} OR dh.ma_don_hang ~* ${n} OR mh.ma_hang ~* ${n} OR kh.ten_khach_hang ~* ${n} OR COALESCE(p.barcode, '') ~* ${n})`);
  }
  const WITH_F = `WITH f AS (
      SELECT x.phan_in_id, min(q.tg_quet) AS tg_file_kt, count(DISTINCT q.id)::int AS so_luot
        FROM file_kt_quet_phan_in x JOIN file_kt_quet q ON q.id = x.quet_id AND q.trang_thai <> 'HUY'
       GROUP BY x.phan_in_id)`;
  const FROM = `FROM f JOIN phan_in p ON p.id = f.phan_in_id ${PIN_JOIN} ${dk.length ? `WHERE ${dk.join(' AND ')}` : ''}`;
  const [{ total }] = (await query(q1(`${WITH_F} SELECT count(*)::int AS total ${FROM}`), p)).rows;
  const pd = [...p, limit, offset];
  const { rows } = await query(q1(`${WITH_F}
    SELECT ${PIN_COT}, f.tg_file_kt, f.so_luot,
           (SELECT json_build_object('ma_quet', q.ma_quet, 'loai_ma', q.loai_ma, 'nguoi', nd.ho_ten, 'cach_ghep', x.cach_ghep)
              FROM file_kt_quet_phan_in x JOIN file_kt_quet q ON q.id = x.quet_id AND q.trang_thai <> 'HUY'
              LEFT JOIN nguoi_dung nd ON nd.id = q.nguoi_quet_id
             WHERE x.phan_in_id = p.id ORDER BY q.tg_quet LIMIT 1) AS luot_dau
      ${FROM}
     ORDER BY f.tg_file_kt DESC, p.ma_phan LIMIT $${pd.length - 1} OFFSET $${pd.length}`), pd);
  return { rows, total };
}

// Hủy MỀM 1 lượt quét (quét nhầm). Giữ dòng ghép làm vết; mọi chỗ tính đã lọc `trang_thai <> 'HUY'`.
async function huyQuet(id, lyDo, actorId) {
  const { rows } = await query(q1(`
    UPDATE file_kt_quet SET trang_thai = 'HUY', ly_do_huy = $2, tg_huy = now(), nguoi_huy_id = $3::uuid,
           updated_date = now(), updated_by = $3::uuid
     WHERE id = $1::uuid AND trang_thai <> 'HUY' RETURNING id, ma_quet`), [id, lyDo, actorId]);
  return rows[0] || null;
}

async function layQuet(id) {
  const { rows } = await query('SELECT id, ma_quet, trang_thai FROM file_kt_quet WHERE id = $1::uuid', [id]);
  return rows[0] || null;
}

module.exports = { coBang, loaiMa, ghiQuet, ghepTuDong, dsQuet, dsPhanIn, huyQuet, layQuet, NGAY_GHEP };
