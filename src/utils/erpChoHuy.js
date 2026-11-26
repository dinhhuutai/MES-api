'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// HÀNG CHỜ BÁO ERP HỦY PHIẾU IN TEM (SF0) (26/11/2026, người dùng: "in tem bị lỗi rồi hủy thì không gửi tới API ERP được
//   ⇒ cái hủy phải nằm trong hàng chờ, sau khi tem in gọi thành công tới API thì mới gọi API hủy của tem đó").
//
// Lỗi cũ: `erpHuy.baoHuy` chỉ báo hủy những IDMES ĐÃ GỬI THÀNH CÔNG ngay lúc hủy. Nếu lúc đó lượt SF0 còn đang chạy (ERP
//   chậm + các lượt POST xếp hàng 1 lượt / lúc ⇒ 40–80 giây) hoặc đã lỗi rồi được gửi lại sau (bằng tay / hàng đợi) ⇒ lúc hủy
//   "chưa từng gửi ERP" ⇒ bỏ qua hủy; SF0 thành công SAU ĐÓ ⇒ ERP giữ phiếu của tem MES đã hủy (đo prod 26/11: 5 tem —
//   152608075061 · 080277 · 079905 · 086348 · 086682 — SF0 thành công sau lúc hủy, không có lượt báo hủy nào).
//
// HÀNG CHỜ (không bảng mới, không migration — trạng thái suy từ `audit_log`):
//   · Tem ĐANG CHỜ HỦY = `tem.trang_thai = 'HUY'` + sự kiện cuối trong (HUY_IN_TEM, MO_LAI_TEM_IN) là `HUY_IN_TEM`.
//     Mở lại tem ⇒ ra khỏi hàng chờ (SF0 gửi lại khi mở lại KHÔNG bị hủy theo). Hủy lại ⇒ vào lại.
//   · IDMES CẦN HỦY của tem đó = IDMES có lượt SF0 thành công MỚI HƠN lượt báo hủy thành công cuối của chính IDMES đó (hoặc
//     chưa báo hủy lần nào) ⇒ SF0 gửi lại sau khi đã báo hủy (ghi đè / tạo lại phiếu bên ERP) thì báo hủy lại.
//   · Người hủy / lý do / ngày hủy lấy từ dòng `HUY_IN_TEM` (ngày hủy = lúc hủy thật ở MES, không phải lúc gửi).
// 3 chỗ kích hoạt (`xuLy` khóa theo tem, gọi chồng thì chạy lại 1 lần sau lượt đang chạy ⇒ không gửi trùng):
//   1. Lúc hủy tem (`production.service cancelPrintTem`) — như cũ.
//   2. NGAY SAU MỖI dòng SF0 thành công được ghi (`erpApiLog.ghiLog` / ghi bù ở nền) — lượt lúc in, "Gửi lại" bằng tay,
//      hàng đợi tự gửi lại, mở lại tem… đều đi qua đây.
//   3. Job hàng đợi tự gửi lại (`jobs/erpTuGuiLai.job.js`, mỗi 5 phút, chỉ máy chủ): (a) SF0 của tem đang chờ hủy mà lượt gửi
//      mới nhất LỖI ⇒ VẪN gửi lại (bỏ luật "tem HUY thì thôi") — thành công thì (2) báo hủy ngay; (b) quét lưới an toàn: tem
//      chờ hủy (hủy trong N ngày) còn IDMES cần hủy ⇒ báo hủy (vd máy chủ khởi động lại giữa chừng, lượt hủy lỗi).
//   Lượt báo hủy lỗi ⇒ job thử lại tới `tuGuiLaiToiDa` lần / IDMES (đếm dòng `ERP_GUI_HUY_IDMES_LOI` sau lượt SF0 thành công
//     cuối); hết lượt vẫn còn nút "Gửi lại" ở Lịch sử API.
// API hủy đang TẮT ⇒ chưa gửi, tem nằm lại hàng chờ — bật lại thì job gửi.
// CHƯA áp cho kênh khác (KCS · Sửa · OQC · phân loại lỗi · phiếu giao · tem gia công) — vẫn `erpHuy.baoHuy` như cũ.
// ─────────────────────────────────────────────────────────────────────────────

const env = require('../config/env');
const { query } = require('../config/db');

const KENH = 'IN_TEM';
const MA_GUI = 'ERP_GHI_IN_TEM';
const laUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));

// IDMES của dòng SF0 thành công — cùng biểu thức `erpHuy.idMesDaGui` (hình dạng JSON đổi qua từng giai đoạn).
const IDM_GUI = `COALESCE(a.gia_tri_moi->'gui'->>'IDMES', a.gia_tri_moi->'gui'->>'IDMes', a.gia_tri_moi->'payload'->>'IDMES', a.gia_tri_moi->>'id_mes')`;
// Dòng báo hủy của kênh in tem (`id_ban_ghi` = tem; PLL cũng gắn tem ⇒ lọc `Nguon`, dòng thiếu `Nguon` coi như của tem in).
const LA_HUY_IN_TEM = `x.ten_bang = 'erp_api' AND x.id_ban_ghi = s.tem_id AND x.gia_tri_moi->'gui'->>'IDMES' = s.idm
   AND COALESCE(x.gia_tri_moi->'gui'->>'Nguon', '${KENH}') = '${KENH}'`;
// Lúc lượt báo hủy BẮT ĐẦU gọi (= giờ ghi dòng − `thoi_gian_ms`). Lượt hủy chỉ "sau" lượt SF0 khi BẮT ĐẦU sau lúc SF0 có kết quả:
//   2 lời gọi chạy chồng (mở lại tem rồi hủy ngay — ca 152608086682 26/11) thì không biết ERP xử lý cái nào trước ⇒ báo hủy lại.
//   Báo hủy lặp cùng IDMES ERP vẫn trả thành công (rv = 0, đo prod 26/11) ⇒ dư 1 lượt là vô hại.
const BD_HUY = `(x.thoi_gian - make_interval(secs => COALESCE(NULLIF(x.gia_tri_moi->>'thoi_gian_ms', '')::numeric, 0) / 1000))`;

// Cột báo hủy ERP của tem cho *Danh sách tem in* (LATERAL `herp` trên alias tem `t`, chỉ tính ở tem gốc HUY — tem khác
//   bỏ qua nhờ one-time filter): `co_sf0` = có IDMES SF0 (gửi thành công hay lỗi) ⇒ nút "Hủy lại ERP" · `chua_huy` = còn
//   IDMES chưa có lượt báo hủy thành công BẮT ĐẦU sau lượt gửi cuối của nó (gồm IDMES chỉ có lượt lỗi — timeout có thể đã
//   tạo phiếu) ⇒ dấu "ERP chưa hủy".
const HUY_ERP_LATERAL = (t = 't') => `LEFT JOIN LATERAL (
    SELECT count(*) > 0 AS co_sf0,
           bool_or(NOT EXISTS (SELECT 1 FROM audit_log x WHERE x.ten_bang = 'erp_api' AND x.id_ban_ghi = ${t}.id::text
                     AND x.hanh_dong = 'ERP_GUI_HUY_IDMES' AND x.gia_tri_moi->'gui'->>'IDMES' = s.idm
                     AND COALESCE(x.gia_tri_moi->'gui'->>'Nguon', '${KENH}') = '${KENH}'
                     AND (x.thoi_gian - make_interval(secs => COALESCE(NULLIF(x.gia_tri_moi->>'thoi_gian_ms', '')::numeric, 0) / 1000)) >= s.tg)) AS chua_huy
      FROM (SELECT ${IDM_GUI} AS idm, max(a.thoi_gian) AS tg FROM audit_log a
             WHERE a.ten_bang = 'tem' AND a.id_ban_ghi = ${t}.id::text AND a.hanh_dong IN ('${MA_GUI}', '${MA_GUI}_LOI')
             GROUP BY 1) s
     WHERE ${t}.trang_thai = 'HUY' AND ${t}.tem_goc_id IS NULL AND s.idm ~ '^[0-9]{6,10}$') herp ON true`;

// Điều kiện "tem đang chờ hủy" trên CTE có cột `tem_id` (text) — dùng chung mọi câu.
const DANG_CHO_HUY_JOIN = (alias) => `
  JOIN tem t ON t.id = ${alias}.tem_id::uuid AND t.trang_thai = 'HUY'
  JOIN LATERAL (SELECT e.hanh_dong, e.thoi_gian, e.gia_tri_moi, e.nguoi_thuc_hien_id FROM audit_log e
     WHERE e.ten_bang = 'tem' AND e.id_ban_ghi = ${alias}.tem_id AND e.hanh_dong IN ('HUY_IN_TEM', 'MO_LAI_TEM_IN')
     ORDER BY e.thoi_gian DESC LIMIT 1) h ON h.hanh_dong = 'HUY_IN_TEM'`;

// Các IDMES cần báo hủy của những tem đang chờ hủy. Nguồn tem: `temIds` (danh sách) hoặc `soNgay` (tem hủy trong N ngày —
//   1 lần quét `audit_log` theo `hanh_dong`, cùng kiểu câu của hàng đợi tự gửi lại).
// Trả [{ tem_id, ma_tem, idm, tg_gui, so_loi, tg_huy, ly_do, nguoi_huy_id }].
async function dsCanHuy({ temIds = null, soNgay = null } = {}) {
  let nguon; const p = [];
  if (temIds) {
    const ids = [...new Set(temIds.map(String))].filter(laUuid);
    if (!ids.length) return [];
    p.push(ids);
    nguon = 'SELECT unnest($1::text[]) AS tem_id';
  } else {
    p.push(Math.max(1, Number(soNgay) || env.erp.tuGuiLaiSoNgay));
    nguon = `SELECT DISTINCT id_ban_ghi AS tem_id FROM audit_log
      WHERE ten_bang = 'tem' AND hanh_dong = 'HUY_IN_TEM' AND thoi_gian > now() - make_interval(days => $1::int)
        AND id_ban_ghi ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;
  }
  const sql = `
    WITH c AS MATERIALIZED (${nguon}),
    q AS MATERIALIZED (
      SELECT c.tem_id, t.ma_tem, h.thoi_gian AS tg_huy, h.gia_tri_moi->>'ly_do' AS ly_do, h.nguoi_thuc_hien_id AS nguoi_huy_id
        FROM c ${DANG_CHO_HUY_JOIN('c')}),
    s AS (
      SELECT q.tem_id, ${IDM_GUI} AS idm, max(a.thoi_gian) AS tg_gui
        FROM q JOIN audit_log a ON a.ten_bang = 'tem' AND a.id_ban_ghi = q.tem_id AND a.hanh_dong = '${MA_GUI}'
       GROUP BY 1, 2)
    SELECT s.tem_id, q.ma_tem, s.idm, s.tg_gui, q.tg_huy, q.ly_do, q.nguoi_huy_id,
           (SELECT count(*) FROM audit_log x WHERE ${LA_HUY_IN_TEM}
               AND x.hanh_dong = 'ERP_GUI_HUY_IDMES_LOI' AND x.thoi_gian > s.tg_gui)::int AS so_loi
      FROM s JOIN q ON q.tem_id = s.tem_id
     WHERE s.idm ~ '^[0-9]{6,10}$'
       AND NOT EXISTS (SELECT 1 FROM audit_log x WHERE ${LA_HUY_IN_TEM}
                          AND x.hanh_dong = 'ERP_GUI_HUY_IDMES' AND ${BD_HUY} >= s.tg_gui)
     ORDER BY s.tem_id, s.tg_gui`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), p);
  return rows;
}

// Hàng đợi tự gửi lại: trong các lượt SF0 đang LỖI (`rows` của `caidatapi.repository.hangDoiTuGuiLai`), lượt nào thuộc tem
//   đang chờ hủy mà IDMES chưa được báo hủy thành công SAU lần gửi lỗi đó ⇒ phải gửi lại (để rồi báo hủy). Trả Set `audit_id`.
async function luotGuiLaiDeHuy(rows = []) {
  const ds = rows.filter((r) => r.ma === MA_GUI && laUuid(r.id_ban_ghi) && r.idm);
  if (!ds.length) return new Set();
  const { rows: kq } = await query(`
    WITH r AS (SELECT * FROM unnest($1::text[], $2::text[], $3::timestamptz[], $4::text[]) AS r(tem_id, idm, tg, audit_id))
    SELECT r.audit_id FROM r ${DANG_CHO_HUY_JOIN('r')}
     WHERE NOT EXISTS (SELECT 1 FROM audit_log x WHERE x.ten_bang = 'erp_api' AND x.id_ban_ghi = r.tem_id
              AND x.hanh_dong = 'ERP_GUI_HUY_IDMES' AND x.gia_tri_moi->'gui'->>'IDMES' = r.idm
              AND COALESCE(x.gia_tri_moi->'gui'->>'Nguon', '${KENH}') = '${KENH}' AND ${BD_HUY} > r.tg)`.replace(/\s+/g, ' '),
  [ds.map((r) => String(r.id_ban_ghi)), ds.map((r) => String(r.idm)),
    ds.map((r) => new Date(r.thoi_gian).toISOString()), ds.map((r) => String(r.audit_id))]);
  return new Set(kq.map((r) => String(r.audit_id)));
}

// 1 lượt xử lý 1 tem: báo hủy mọi IDMES cần hủy (còn lượt thử). KHÔNG ném lỗi lên trên `xuLy`.
async function motLuot(temId) {
  const toiDa = env.erp.tuGuiLaiToiDa;
  const ds = await dsCanHuy({ temIds: [temId] });
  const lam = ds.filter((r) => r.so_loi < toiDa);
  if (!lam.length) return { tem_id: temId, can_huy: ds.length, da_gui: 0, thanh_cong: 0, het_luot: ds.length };
  const erpHuy = require('./erpHuy');
  const { tenDangNhap } = require('./erpApiChung');
  const NguoiHuy = await tenDangNhap(lam[0].nguoi_huy_id);
  const kq = { tem_id: temId, ma_tem: lam[0].ma_tem, can_huy: ds.length, da_gui: 0, thanh_cong: 0, het_luot: ds.length - lam.length };
  for (const r of lam) {
    // eslint-disable-next-line no-await-in-loop
    const g = await erpHuy.guiHuyIdMes(
      { IDMES: Number(r.idm), NgayHuy: r.tg_huy, NguoiHuy, Lydohuy: r.ly_do || '', Nguon: KENH },
      { idBanGhi: temId, maHien: r.ma_tem, actorId: r.nguoi_huy_id || null },
    );
    if (g.bo_qua) { kq.api_tat = true; break; } // API hủy đang tắt — nằm lại hàng chờ
    kq.da_gui += 1;
    if (g.ok) kq.thanh_cong += 1;
  }
  if (kq.da_gui) {
    console.log(`[cho-huy-in-tem] tem ${kq.ma_tem}: báo ERP hủy ${kq.thanh_cong}/${kq.da_gui} IDMES`
      + (kq.thanh_cong < kq.da_gui ? ' (còn lỗi — hàng đợi thử lại)' : ''));
  }
  return kq;
}

// Khóa theo tem (BE chạy 1 tiến trình): đang xử lý mà có lời gọi mới ⇒ đánh dấu chạy lại 1 lượt sau khi xong (lời gọi mới có
//   thể mang dòng SF0 thành công vừa ghi mà lượt đang chạy đã đọc hụt).
const dangChay = new Map();
function xuLy(temId) {
  const id = String(temId || '');
  if (!laUuid(id)) return Promise.resolve({ tem_id: id, bo_qua: true });
  const cu = dangChay.get(id);
  if (cu) { cu.lai = true; return cu.p; }
  const st = { lai: false, p: null };
  dangChay.set(id, st);
  st.p = (async () => {
    let kq = null;
    try {
      do { st.lai = false; kq = await motLuot(id); } while (st.lai); // eslint-disable-line no-await-in-loop
    } finally {
      dangChay.delete(id);
    }
    return kq;
  })();
  return st.p;
}

function xuLyNgam(temId) {
  xuLy(temId).catch((e) => console.error(`[cho-huy-in-tem] ✗ tem ${temId}: ${e.message}`));
}

// Gọi từ `erpApiLog` ngay sau khi ghi 1 dòng SF0 THÀNH CÔNG. Chỉ đọc 1 cột khi tem còn sống (đa số) ⇒ rẻ.
function sauGuiThanhCong(maApi, temId) {
  if (maApi !== MA_GUI || !laUuid(temId)) return;
  query("SELECT 1 FROM tem WHERE id = $1 AND trang_thai = 'HUY'", [String(temId)])
    .then(({ rows }) => { if (rows.length) xuLyNgam(temId); })
    .catch((e) => console.error(`[cho-huy-in-tem] ✗ Không kiểm được tem ${temId} sau lượt SF0: ${e.message}`));
}

// Lưới an toàn của job: tem chờ hủy (hủy trong `soNgay` ngày) còn IDMES cần hủy và còn lượt thử ⇒ xử lý tuần tự,
//   tối đa `toiDaTem` tem / chu kỳ.
async function quetHangCho({ soNgay = env.erp.tuGuiLaiSoNgay, toiDaTem = env.erp.tuGuiLaiMoiLuot } = {}) {
  const ds = await dsCanHuy({ soNgay });
  const conLuot = ds.filter((r) => r.so_loi < env.erp.tuGuiLaiToiDa);
  const tems = [...new Set(conLuot.map((r) => r.tem_id))];
  const kq = { tem_cho: new Set(ds.map((r) => r.tem_id)).size, idmes_cho: ds.length, da_xu_ly: 0, thanh_cong: 0, da_gui: 0 };
  for (const id of tems.slice(0, toiDaTem)) {
    let r = null;
    try {
      r = await xuLy(id); // eslint-disable-line no-await-in-loop
    } catch (e) {
      console.error(`[cho-huy-in-tem] ✗ tem ${id}: ${e.message}`);
    }
    kq.da_xu_ly += 1;
    kq.da_gui += (r && r.da_gui) || 0;
    kq.thanh_cong += (r && r.thanh_cong) || 0;
    if (r && r.api_tat) break;
  }
  return kq;
}

// ─── NÚT "HỦY LẠI ERP" (admin, *Danh sách tem in*) ──────────────────────────────────────────────────────────────
// Người dùng: "admin cho thêm nút hủy lại ở danh sách tem in, để khỏi mở lại rồi hủy". Báo ERP hủy LẠI MỌI IDMES SF0 của
//   1 tem ĐÃ HỦY ở MES — cả IDMES chỉ có lượt LỖI (timeout vẫn có thể đã tạo phiếu bên ERP) — bỏ qua luật "đã báo hủy rồi"
//   của hàng chờ. KHÔNG đổi gì ở MES (trạng thái tem, sổ cái, xe phơi); chỉ thêm dòng lịch sử API + vết `tem` · `HUY_LAI_ERP`.
//   Mọi tem gốc HUY (cả hủy GIÁN TIẾP — hủy lệnh kèm tem — vốn chưa báo ERP). Người hủy = admin bấm, ngày hủy = lúc bấm,
//   lý do trống ⇒ lý do lúc hủy tem. Báo hủy lặp ERP vẫn trả thành công (rv = 0). Chờ lượt hàng chờ đang chạy của tem xong
//   trước (không chạy chồng). Lỗi nghiệp vụ NÉM `AppError` (người bấm đang đứng chờ kết quả).
async function huyLai(temId, { actorId = null, lyDo = '' } = {}) {
  const AppError = require('./AppError');
  const id = String(temId || '');
  if (!laUuid(id)) throw new AppError('Tem không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const cu = dangChay.get(id);
  if (cu) await cu.p.catch(() => {});

  const { rows: [t] } = await query(`
    SELECT t.ma_tem, t.trang_thai, t.tem_goc_id,
           (SELECT e.gia_tri_moi->>'ly_do' FROM audit_log e WHERE e.ten_bang = 'tem' AND e.id_ban_ghi = t.id::text
              AND e.hanh_dong = 'HUY_IN_TEM' ORDER BY e.thoi_gian DESC LIMIT 1) AS ly_do_huy
      FROM tem t WHERE t.id = $1`.replace(/\s+/g, ' '), [id]);
  if (!t) throw new AppError('Tem không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (t.trang_thai !== 'HUY') {
    throw new AppError(`Tem ${t.ma_tem} chưa hủy ở MES — chỉ báo ERP hủy lại tem đã hủy`, { status: 409, errorCode: 'CHUA_HUY' });
  }
  if (t.tem_goc_id) throw new AppError('Tem con (17) không có phiếu in tem SF0', { status: 409, errorCode: 'TEM_CON' });

  const { rows: ds } = await query(`
    SELECT ${IDM_GUI} AS idm, bool_or(a.hanh_dong = '${MA_GUI}') AS da_ok, min(a.thoi_gian) AS tg
      FROM audit_log a WHERE a.ten_bang = 'tem' AND a.id_ban_ghi = $1 AND a.hanh_dong IN ('${MA_GUI}', '${MA_GUI}_LOI')
     GROUP BY 1 ORDER BY 3`.replace(/\s+/g, ' '), [id]);
  const dsIdm = ds.filter((r) => /^[0-9]{6,10}$/.test(String(r.idm || '')));
  if (!dsIdm.length) {
    throw new AppError(`Tem ${t.ma_tem} chưa từng gửi phiếu in tem sang ERP (không có IDMES) — không có gì để hủy`,
      { status: 409, errorCode: 'CHUA_GUI_ERP' });
  }

  const erpHuy = require('./erpHuy');
  const { tenDangNhap } = require('./erpApiChung');
  const NguoiHuy = await tenDangNhap(actorId);
  const ly = String(lyDo || '').trim() || t.ly_do_huy || 'Hủy lại';
  const NgayHuy = new Date();
  const ketQua = [];
  for (const r of dsIdm) {
    // eslint-disable-next-line no-await-in-loop
    const g = await erpHuy.guiHuyIdMes(
      { IDMES: Number(r.idm), NgayHuy, NguoiHuy, Lydohuy: ly, Nguon: KENH },
      { idBanGhi: id, maHien: t.ma_tem, actorId },
    );
    if (g.bo_qua) {
      throw new AppError('API "Báo ERP hủy chứng từ" đang TẮT ở Hệ thống › Cài đặt API', { status: 409, errorCode: 'API_DANG_TAT' });
    }
    ketQua.push({ id_mes: Number(r.idm), da_gui_thanh_cong: !!r.da_ok, ok: !!g.ok, loi: g.ok ? null : (g.error || 'ERP báo lỗi') });
  }
  const thanhCong = ketQua.filter((x) => x.ok).length;
  await query(
    `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ('tem', $1, 'HUY_LAI_ERP', $2::jsonb, $3, CURRENT_TIMESTAMP, $3)`.replace(/\s+/g, ' '),
    [id, JSON.stringify({ ma_tem: t.ma_tem, ly_do: ly, ket_qua: ketQua, thanh_cong: thanhCong }), actorId],
  ).catch((e) => console.error(`[cho-huy-in-tem] ✗ Không ghi được vết HUY_LAI_ERP tem ${t.ma_tem}: ${e.message}`));
  console.log(`[cho-huy-in-tem] admin báo ERP hủy lại tem ${t.ma_tem}: ${thanhCong}/${ketQua.length} IDMES`);
  return { ma_tem: t.ma_tem, tong: ketQua.length, thanh_cong: thanhCong, ket_qua: ketQua };
}

module.exports = {
  KENH, MA_GUI, HUY_ERP_LATERAL, dsCanHuy, luotGuiLaiDeHuy, xuLy, xuLyNgam, sauGuiThanhCong, quetHangCho, huyLai,
};
