'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// HÀNG ĐỢI TÍCH TEM (19/11/2026, người dùng: "tích tem KCS, Phân loại lỗi, Nhận sửa, Sửa — lưu nhiều tem cùng lúc mà xoay lâu
//   sau 5 s thì đưa những tem đó vào hàng đợi, hệ thống tự chạy từng tem, thông báo người dùng đã chạy thành công; ở Hệ thống
//   có trang quản lý hàng đợi").
// Bảng Tích tem lưu thẳng từng tem như cũ; quá `HANG_DOI_SAU_MS` (FE) mà còn tem ⇒ gửi PHẦN CÒN LẠI 1 lần vào đây ⇒ máy chủ
//   chạy ĐÚNG service của màn (cùng mọi chốt chặn / ERP / tem 17) từng tem, bằng TÀI KHOẢN người xếp.
//
// LƯU Ở `audit_log` (không migration) — `ten_bang = 'hang_doi_tem'`, `id_ban_ghi` = mã mục (uuid), CHỈ GHI THÊM:
//   HANG_DOI_THEM  gia_tri_moi = { loai, lo, tem_id, ma_tem, moc (số lúc xếp — chống ghi đôi), body, nguon }  ⇐ người xếp
//   HANG_DOI_XONG  gia_tri_moi = { ket_qua }                                                                    ⇐ máy chủ
//   HANG_DOI_LOI   gia_tri_moi = { loi, ma_loi }                                                                ⇐ máy chủ
//   HANG_DOI_BO    gia_tri_moi = { ly_do }                                                                      ⇐ người bỏ
//   Mục CHỜ = có THEM mà chưa có XONG / LOI / BO. Lỗi KHÔNG tự thử lại (lỗi do số liệu — làm lại tay rồi Bỏ).
//   `lo` = 1 lần xếp; lô hết mục chờ ⇒ thông báo chuông `HANG_DOI_XONG` cho người xếp + socket `hang-doi:xong-lo`.
// ⚠ CHỐNG GHI ĐÔI (máy chủ tắt ngang sau khi ghi mà chưa kịp ghi XONG / người khác vừa làm tem đó): mục mang `moc` = số
//   "còn" lúc xếp (KCS còn kiểm · Sửa đang sửa · Nhận sửa chờ nhận) ⇒ lệch ⇒ LỖI, không làm lần 2. Phân loại lỗi = GHI ĐÈ
//   phiếu ⇒ chạy lại vô hại, không cần mốc.
// ⚠ CHỈ 1 TIẾN TRÌNH CHẠY: khóa phiên `pg_try_advisory_lock` + chỉ chạy trên máy chủ (PGHOST cục bộ) hoặc khi
//   `HANG_DOI_JOB=true` (tên cũ `KCS_HANG_DOI_JOB` vẫn nhận) — máy dev trỏ DB production không chạy mục của xưởng.
// ⚠⚠ XÍCH THEO TEM (25/11/2026, người dùng: "phân loại lỗi đang trong hàng đợi, chưa kịp lưu thì bên sửa vẫn cho lên hàng
//   đợi; chạy theo thứ tự: tem phân loại lỗi chạy xong mới cho chạy tem sửa — những chỗ kia cũng làm vậy"): thứ tự bước
//   `THU_TU` = KCS → Phân loại lỗi → Nhận sửa → Sửa. Tem còn mục CHỜ ở bước TRƯỚC ⇒
//   · màn sau quét tem vẫn ra dòng với SỐ DỰ KIẾN sau khi các bước đó chạy (`duKien`, GET /hang-doi/du-kien) — xác nhận là
//     dòng đó vào THẲNG hàng đợi (không lưu thẳng được vì DB chưa có số);
//   · mục mới (mọi đường xếp) mang `sau_muc` = mục chờ cuối của tem + `moc` = số DỰ KIẾN (chống ghi đôi vẫn đúng); bộ chạy
//     KHÔNG lấy mục khi `sau_muc` còn chờ; `sau_muc` LỖI / BỎ ⇒ mục sau ghi LỖI "bước trước…" (không chạy trên số sai).
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const AppError = require('../../utils/AppError');
const env = require('../../config/env');
const { pool, query } = require('../../config/db');
const sockets = require('../../sockets');

const TB = 'hang_doi_tem';
const KET_THUC = "('HANG_DOI_XONG', 'HANG_DOI_LOI', 'HANG_DOI_BO')";
const TOI_DA_MOT_LAN = 200;
const NGHI_GIUA_TEM_MS = 200;
const CHU_KY_MS = 30 * 1000;
const KHOA = "hashtext('hang_doi_tem')";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const so = (v) => Number(v) || 0;
const loi409 = (msg) => new AppError(msg, { status: 409, errorCode: 'DA_DOI_HANG_DOI' });

// ─── Danh mục loại — mỗi loại = 1 màn Tích tem. `quyen` = quyền màn đó (route lưu lẻ). ───────────────────────────────
const qa = () => require('../quality/quality.service');
const qaRepo = () => require('../quality/quality.repository');
const LOAI = {
  KCS: {
    ten: 'Xác nhận KCS', quyen: 'KCS', trang: '/san-xuat/kcs',
    khoaBody: ['soLuongDat', 'soLuongHu', 'soLuongThieu', 'soLuongDu', 'soLuongMau', 'ghiChu', 'nguoiKiem', 'nguoiKiemId'],
    moc: async (temId) => { const t = await qaRepo().getTemLedger(temId); return t ? { ma_tem: t.ma_tem, moc: so(t.con_kcs) } : null; },
    // Kiểm mốc NGAY TRONG `recordKcs` (cùng chỗ khóa tem) — `conKcsMongDoi`.
    chay: async (m) => {
      const d = await qa().recordKcs(m.tem_id, { ...m.body, conKcsMongDoi: m.moc }, m.nguoi_id);
      return { kcs_id: d.kcs_id, ma_tem_17: d.ma_tem_17 || null, con_kcs: d.con_kcs };
    },
  },
  PHAN_LOAI_LOI: {
    ten: 'Phân loại lỗi', quyen: 'PHAN_LOAI_LOI', trang: '/san-xuat/phan-loai-loi',
    khoaBody: ['dong', 'ghiChu'],
    moc: async (temId) => { const t = await qaRepo().getTemLedger(temId); return t ? { ma_tem: t.ma_tem, moc: null } : null; },
    chay: async (m) => {
      const d = await require('../quality/phanloailoi.service').luu(m.tem_id, m.body, m.nguoi_id);
      return { tong_sua: d && d.tong_sua, tong_huy: d && d.tong_huy };
    },
  },
  NHAN_SUA: {
    ten: 'Nhận sửa', quyen: 'SUA', trang: '/san-xuat/sua',
    khoaBody: ['soLuong'],
    moc: async (temId) => {
      const t = await qaRepo().getTemLedger(temId);
      if (!t) return null;
      const [s] = await qaRepo().soSuaCuaTem([temId]);
      return { ma_tem: t.ma_tem, moc: so(s && s.cho_nhan) };
    },
    chay: async (m) => {
      const [s] = await qaRepo().soSuaCuaTem([m.tem_id]);
      if (so(s && s.cho_nhan) !== so(m.moc)) throw loi409(`Tem ${m.ma_tem} đã đổi số chờ nhận từ lúc xếp hàng đợi (${m.moc} → ${so(s && s.cho_nhan)}) — kiểm lại tem này`);
      const d = await require('../quality/nhansua.service').nhanSua({ items: [{ temId: m.tem_id, soLuong: so(m.body.soLuong) || so(m.moc) }] }, m.nguoi_id);
      return { so_luong: d.tong_sl };
    },
  },
  SUA: {
    ten: 'Xác nhận sửa', quyen: 'SUA', trang: '/san-xuat/sua',
    khoaBody: ['soLuongSuaDat', 'soLuongSuaHuy', 'soLuongHuyThang', 'ghiChu', 'nguoiSua', 'nguoiSuaId'],
    moc: async (temId) => {
      const t = await qaRepo().getTemLedger(temId);
      if (!t) return null;
      const [s] = await qaRepo().soSuaCuaTem([temId]);
      return { ma_tem: t.ma_tem, moc: so(s && s.dang_sua) };
    },
    chay: async (m) => {
      const d = await qa().recordSua(m.tem_id, { ...m.body, conSuaMongDoi: m.moc }, m.nguoi_id);
      return { sua_id: d && d.sua_id, ma_tem_17: (d && d.ma_tem_17) || null };
    },
  },
};

// ─── XÍCH THEO TEM ───────────────────────────────────────────────────────────
const THU_TU = ['KCS', 'PHAN_LOAI_LOI', 'NHAN_SUA', 'SUA'];
const viTri = (loai) => THU_TU.indexOf(loai);
const KHONG_KET_THUC = (a) => `NOT EXISTS (SELECT 1 FROM audit_log zk WHERE zk.ten_bang = '${TB}' AND zk.id_ban_ghi = ${a}.id_ban_ghi AND zk.hanh_dong IN ${KET_THUC})`;

// Mục CHỜ của các tem, cũ trước ⇒ Map tem_id → [{ id, loai, body, moc }].
async function mucChoTheoTem(temIds) {
  const m = new Map();
  if (!temIds.length) return m;
  const { rows } = await query(
    `SELECT a.id_ban_ghi AS id, a.gia_tri_moi->>'tem_id' AS tem_id, a.gia_tri_moi->>'loai' AS loai, a.gia_tri_moi->'body' AS body
       FROM audit_log a
      WHERE a.ten_bang = '${TB}' AND a.hanh_dong = 'HANG_DOI_THEM' AND a.gia_tri_moi->>'tem_id' = ANY($1::text[]) AND ${KHONG_KET_THUC('a')}
      ORDER BY a.thoi_gian, a.id`.replace(/\s+/g, ' '), [temIds.map(String)]);
  rows.forEach((r) => { const a = m.get(r.tem_id) || []; a.push({ ...r, body: r.body || {} }); m.set(r.tem_id, a); });
  return m;
}

// Số của tem SAU KHI các mục chờ `cho` (bước trước) chạy xong — cùng công thức sổ cái `utils/choSua.js` (đã nhận hiệu lực =
//   LEAST(GREATEST(sl_nhan_sua, đã xử lý), sl_kcs_sua)). KCS: hư ⇒ `sl_kcs_sua` (body KCS không có ô sửa riêng) · Phân loại
//   lỗi: GHI ĐÈ sửa / hủy · Nhận sửa: `sl_nhan_sua = đã nhận + SL` · Sửa: đã xử lý += đạt + hủy + hủy thẳng.
async function duKienSo(temId, cho) {
  const t = await qaRepo().getTemLedger(temId);
  if (!t) return null;
  const [s] = await qaRepo().soSuaCuaTem([temId]);
  let kcsSua = so(t.sl_kcs_sua);
  let kcsHuy = so(t.sl_kcs_huy);
  let nhan = s && s.sl_nhan_sua != null ? so(s.sl_nhan_sua) : kcsSua;
  let xuLy = so(t.sl_sua_dat) + so(t.sl_sua_huy);
  let daPll = !!(s && s.vao_sua_duoc);
  const tinh = () => {
    const daNhan = Math.min(Math.max(nhan, xuLy), kcsSua);
    return { daNhan, choNhan: Math.max(kcsSua - daNhan, 0), dangSua: Math.max(daNhan - xuLy, 0) };
  };
  for (const m of cho) {
    const b = m.body || {};
    if (m.loai === 'KCS') kcsSua += so(b.soLuongHu);
    else if (m.loai === 'PHAN_LOAI_LOI') {
      const d = Array.isArray(b.dong) ? b.dong : [];
      kcsSua = d.reduce((x, r) => x + so(r.soLuongSua), 0);
      kcsHuy = d.reduce((x, r) => x + so(r.soLuongHuy), 0);
      daPll = true;
    } else if (m.loai === 'NHAN_SUA') {
      const { daNhan, choNhan } = tinh();
      nhan = daNhan + Math.min(so(b.soLuong) || choNhan, choNhan);
    } else if (m.loai === 'SUA') xuLy += so(b.soLuongSuaDat) + so(b.soLuongSuaHuy) + so(b.soLuongHuyThang);
  }
  return { t, kcsSua, kcsHuy, hu: kcsSua + kcsHuy, daPll, ...tinh() };
}

// Mốc chống ghi đôi của mục loại `loai` khi chạy SAU các mục `truoc` — số dự kiến; `loi` = sau các bước trước vẫn không làm được.
function mocDuKien(loai, dk, tenTruoc) {
  if (loai === 'PHAN_LOAI_LOI') return dk.hu > 0 ? { moc: null } : { loi: `Sau ${tenTruoc} tem vẫn không có SL hư để phân loại` };
  if (loai === 'NHAN_SUA') {
    if (!dk.daPll) return { loi: `Sau ${tenTruoc} tem vẫn chưa phân loại lỗi — cần Phân loại lỗi trước` };
    return dk.choNhan > 0 ? { moc: dk.choNhan } : { loi: `Sau ${tenTruoc} tem không có phần chờ nhận sửa` };
  }
  if (loai === 'SUA') {
    if (dk.dangSua > 0) return { moc: dk.dangSua };
    return { loi: dk.choNhan > 0
      ? `Sau ${tenTruoc} tem còn ${dk.choNhan} chờ NHẬN SỬA — quét ở hộp "Nhận sửa" trước (cũng vào hàng đợi được)`
      : `Sau ${tenTruoc} tem không có phần đang sửa` };
  }
  return { loi: 'KCS là bước đầu — không xếp sau bước khác' };
}
const tenCacBuoc = (ds) => [...new Set(ds.map((m) => (LOAI[m.loai] || {}).ten || m.loai))].join(' → ');

/** Quét tem ở màn `loai` mà tem còn mục CHỜ ở bước trước ⇒ dòng DỰ KIẾN (cùng các trường màn đó đọc) hoặc `loi`.
 *  `{ row: null }` = tem không có bước trước đang chờ (FE giữ câu lỗi của màn). */
async function duKien(user, { loai, ma } = {}) {
  if (!LOAI[loai]) throw new AppError('Loại hàng đợi không hợp lệ', { status: 422, errorCode: 'LOAI_SAI' });
  if (!coQuyen(user.permissions, loai)) throw new AppError('Không có quyền thao tác màn này', { status: 403, errorCode: 'FORBIDDEN' });
  if (viTri(loai) <= 0) return { row: null };
  const ds = require('../../utils/temPrefix').maTemUngVien(String(ma || '').trim());
  if (!ds.length) return { row: null };
  const tem = await require('../quality/phanloailoi.repository').timTemDePhanLoai(ds);
  if (!tem || tem.trang_thai === 'HUY') return { row: null };
  const cho = (await mucChoTheoTem([tem.tem_id])).get(String(tem.tem_id)) || [];
  const truoc = cho.filter((m) => viTri(m.loai) >= 0 && viTri(m.loai) < viTri(loai));
  if (!truoc.length) return { row: null };
  const tenTruoc = tenCacBuoc(truoc);
  if (cho.some((m) => m.loai === loai)) return { loi: `Tem đã có trong hàng đợi ${LOAI[loai].ten} (sau ${tenTruoc})` };
  const dk = await duKienSo(tem.tem_id, truoc);
  if (!dk) return { row: null };
  const kq = mocDuKien(loai, dk, `${tenTruoc} (hàng đợi)`);
  if (kq.loi) return { loi: kq.loi };
  if (loai === 'PHAN_LOAI_LOI') {
    const { rows } = await query('SELECT 1 FROM phan_loai_loi WHERE tem_id = $1 LIMIT 1', [tem.tem_id]);
    if (rows.length) return { loi: `Tem đã có phiếu phân loại lỗi — đợi ${tenTruoc} trong hàng đợi chạy xong rồi sửa phiếu ở danh sách` };
  }
  const cuoi = truoc[truoc.length - 1];
  const row = {
    tem_id: tem.tem_id, ma_tem: tem.ma_tem, ten_khach_hang: tem.ten_khach_hang, ma_don_hang: tem.ma_don_hang, ma_hang: tem.ma_hang,
    ma_phan: tem.ma_phan, phan_list: tem.ma_phan, mau_vai: tem.mau_vai, kich_vai: tem.kich_vai, kich_phim: tem.kich_phim,
    qua_hang_doi: { muc_id: cuoi.id, loai_truoc: cuoi.loai, ten_truoc: tenTruoc },
  };
  if (loai === 'PHAN_LOAI_LOI') Object.assign(row, { sl_kcs_sua: dk.kcsSua, sl_kcs_huy: dk.kcsHuy, sl_hu: dk.hu });
  if (loai === 'NHAN_SUA') Object.assign(row, { cho_nhan: dk.choNhan });
  if (loai === 'SUA') Object.assign(row, { con_sua: dk.dangSua, dang_sua: dk.dangSua });
  return { row };
}

function duocChayTrenMayNay() {
  const v = String(process.env.HANG_DOI_JOB || process.env.KCS_HANG_DOI_JOB || '').trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return ['localhost', '127.0.0.1', '::1'].includes(String(env.db.host || '').toLowerCase());
}
const coQuyen = (perms, loai) => (perms || []).includes('*') || (perms || []).includes(LOAI[loai].quyen);
const locBody = (loai, b) => Object.fromEntries(LOAI[loai].khoaBody.filter((k) => b && b[k] !== undefined && b[k] !== null).map((k) => [k, b[k]]));

/** Xếp nhiều tem. `items` = [{ temId, body }]. Trả { so, lo, muc, bo_qua: [{ tem_id, ly_do }] }. */
async function xep(user, { loai, items, nguon = 'TICH_TEM' } = {}) {
  if (!LOAI[loai]) throw new AppError(`Loại hàng đợi không hợp lệ (${Object.keys(LOAI).join(' · ')})`, { status: 422, errorCode: 'LOAI_SAI' });
  if (!coQuyen(user.permissions, loai)) throw new AppError('Không có quyền thao tác màn này', { status: 403, errorCode: 'FORBIDDEN' });
  const ds = (Array.isArray(items) ? items : []).filter((x) => x && UUID_RE.test(String(x.temId || '')));
  if (!ds.length) throw new AppError('Không có tem nào để xếp hàng đợi', { status: 422, errorCode: 'EMPTY' });
  if (ds.length > TOI_DA_MOT_LAN) throw new AppError(`Tối đa ${TOI_DA_MOT_LAN} tem một lần`, { status: 422, errorCode: 'QUA_NHIEU' });
  const ids = [...new Set(ds.map((x) => String(x.temId)))];
  if (ids.length !== ds.length) throw new AppError('Có tem trùng trong danh sách', { status: 422, errorCode: 'TRUNG_TEM' });

  // Tem đang CHỜ (cùng loại) ⇒ không xếp lần 2.
  const { rows: dangCho } = await query(
    `SELECT a.gia_tri_moi->>'tem_id' AS tem_id FROM audit_log a
      WHERE a.ten_bang = '${TB}' AND a.hanh_dong = 'HANG_DOI_THEM' AND a.gia_tri_moi->>'loai' = $2
        AND a.gia_tri_moi->>'tem_id' = ANY($1::text[])
        AND NOT EXISTS (SELECT 1 FROM audit_log b WHERE b.ten_bang = '${TB}' AND b.id_ban_ghi = a.id_ban_ghi AND b.hanh_dong IN ${KET_THUC})`
      .replace(/\s+/g, ' '), [ids, loai]);
  const trung = new Set(dangCho.map((r) => r.tem_id));

  const lo = crypto.randomUUID();
  const muc = [];
  const boQua = [];
  // Xích theo tem: mục chờ của BƯỚC TRƯỚC (KCS → Phân loại lỗi → Nhận sửa → Sửa) ⇒ chạy sau mục cuối + mốc = số dự kiến.
  const choTem = await mucChoTheoTem(ids);
  for (const x of ds) {
    const temId = String(x.temId);
    if (trung.has(temId)) { boQua.push({ tem_id: temId, ly_do: 'Tem đang chờ trong hàng đợi' }); continue; }
    const truoc = (choTem.get(temId) || []).filter((c) => viTri(c.loai) >= 0 && viTri(c.loai) < viTri(loai));
    let m;
    let sau = null;
    if (truoc.length) {
      const dk = await duKienSo(temId, truoc); // eslint-disable-line no-await-in-loop
      if (!dk) { boQua.push({ tem_id: temId, ly_do: 'Tem không tồn tại' }); continue; }
      const tenTruoc = tenCacBuoc(truoc);
      const kq = mocDuKien(loai, dk, `${tenTruoc} (hàng đợi)`);
      if (kq.loi) { boQua.push({ tem_id: temId, ly_do: kq.loi }); continue; }
      m = { ma_tem: dk.t.ma_tem, moc: kq.moc };
      const cuoi = truoc[truoc.length - 1];
      sau = { sau_muc: cuoi.id, sau_loai: cuoi.loai };
    } else {
      m = await LOAI[loai].moc(temId); // eslint-disable-line no-await-in-loop
    }
    if (!m) { boQua.push({ tem_id: temId, ly_do: 'Tem không tồn tại' }); continue; }
    muc.push({ id: crypto.randomUUID(), loai, lo, tem_id: temId, ma_tem: m.ma_tem, moc: m.moc, body: locBody(loai, x.body), ...(sau || {}) });
  }
  if (muc.length) {
    await query(
      `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
       SELECT '${TB}', m->>'id', 'HANG_DOI_THEM', (m - 'id') || jsonb_build_object('nguon', $2::text),
              $3::uuid, clock_timestamp(), $3::uuid
         FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS x(m, i) ORDER BY i`.replace(/\s+/g, ' '),
      [JSON.stringify(muc), String(nguon).slice(0, 30), user.id]);
    sockets.emit('hang-doi:cap-nhat', { loai, them: muc.length });
    kich();
  }
  return { so: muc.length, lo, muc: muc.map(({ id, tem_id, ma_tem }) => ({ id, tem_id, ma_tem })), bo_qua: boQua };
}

const TT = { HANG_DOI_XONG: 'XONG', HANG_DOI_LOI: 'LOI', HANG_DOI_BO: 'BO' };

/** Danh sách: mục CHỜ (mọi lúc) + XONG / LỖI / BỎ trong `soGio` giờ. Lọc `loai`, `trangThai`, `lo`, `tim` (mã tem). */
async function danhSach({ loai = '', trangThai = '', lo = '', tim = '', soGio = 72 } = {}) {
  const dk = [`a.ten_bang = '${TB}'`, "a.hanh_dong = 'HANG_DOI_THEM'", '(k.hanh_dong IS NULL OR a.thoi_gian >= now() - ($1::int * interval \'1 hour\'))'];
  const p = [Math.min(24 * 90, Math.max(1, Number(soGio) || 72))];
  if (loai && LOAI[loai]) { p.push(loai); dk.push(`a.gia_tri_moi->>'loai' = $${p.length}`); }
  if (lo && UUID_RE.test(lo)) { p.push(lo); dk.push(`a.gia_tri_moi->>'lo' = $${p.length}`); }
  if (tim) { p.push(`%${String(tim).trim()}%`); dk.push(`a.gia_tri_moi->>'ma_tem' ILIKE $${p.length}`); }
  const { rows } = await query(
    `SELECT a.id_ban_ghi AS id, a.thoi_gian AS tg_xep, a.gia_tri_moi AS g, nd.ho_ten AS nguoi_xep, a.nguoi_thuc_hien_id AS nguoi_xep_id,
            k.hanh_dong AS ket_thuc, k.thoi_gian AS tg_xong, k.gia_tri_moi AS kq, nb.ho_ten AS nguoi_bo
       FROM audit_log a
       LEFT JOIN nguoi_dung nd ON nd.id = a.nguoi_thuc_hien_id
       LEFT JOIN LATERAL (SELECT b.hanh_dong, b.thoi_gian, b.gia_tri_moi, b.nguoi_thuc_hien_id FROM audit_log b
                           WHERE b.ten_bang = '${TB}' AND b.id_ban_ghi = a.id_ban_ghi AND b.hanh_dong IN ${KET_THUC}
                           ORDER BY b.thoi_gian DESC LIMIT 1) k ON true
       LEFT JOIN nguoi_dung nb ON nb.id = k.nguoi_thuc_hien_id AND k.hanh_dong = 'HANG_DOI_BO'
      WHERE ${dk.join(' AND ')}
      ORDER BY a.thoi_gian, a.id_ban_ghi LIMIT 2000`.replace(/\s+/g, ' '), p);
  let ds = rows.map((r) => {
    const g = r.g || {};
    const b = g.body || {};
    return {
      id: r.id, loai: g.loai || 'KCS', ten_loai: (LOAI[g.loai] || LOAI.KCS).ten, lo: g.lo || null, tem_id: g.tem_id, ma_tem: g.ma_tem,
      moc: g.moc, nguon: g.nguon, nguoi_xep: r.nguoi_xep, nguoi_xep_id: r.nguoi_xep_id, tg_xep: r.tg_xep, tg_xong: r.tg_xong,
      trang_thai: TT[r.ket_thuc] || 'CHO', loi: r.kq && r.kq.loi ? r.kq.loi : null, ket_qua: r.kq && r.kq.ket_qua ? r.kq.ket_qua : null,
      sau_muc: g.sau_muc || null, sau_ten: g.sau_loai ? (LOAI[g.sau_loai] || {}).ten || g.sau_loai : null,
      nguoi_bo: r.nguoi_bo, ly_do_bo: r.kq && r.ket_thuc === 'HANG_DOI_BO' ? r.kq.ly_do : null,
      tom_tat: tomTat(g.loai, b),
    };
  });
  const dem = { CHO: 0, LOI: 0, XONG: 0, BO: 0 };
  const demLoai = {};
  ds.forEach((m) => {
    dem[m.trang_thai] += 1;
    const d = demLoai[m.loai] || (demLoai[m.loai] = { CHO: 0, LOI: 0 });
    if (m.trang_thai === 'CHO' || m.trang_thai === 'LOI') d[m.trang_thai] += 1;
  });
  if (trangThai && dem[trangThai] !== undefined) ds = ds.filter((m) => m.trang_thai === trangThai);
  return {
    dang_chay: tt.dang_chay, dang_lam: tt.dangLam, chay_tren_may: duocChayTrenMayNay(),
    cho: dem.CHO, loi: dem.LOI, xong: dem.XONG, bo: dem.BO, theo_loai: demLoai,
    loai: Object.entries(LOAI).map(([ma, v]) => ({ ma, ten: v.ten })),
    ds,
  };
}

// Câu ngắn mô tả số đã nhập (cột "Nội dung" ở trang quản lý).
function tomTat(loai, b) {
  if (loai === 'PHAN_LOAI_LOI') {
    const d = Array.isArray(b.dong) ? b.dong : [];
    return `${d.length} dòng lỗi · sửa ${d.reduce((s, x) => s + so(x.soLuongSua), 0)} · hủy ${d.reduce((s, x) => s + so(x.soLuongHuy), 0)}`;
  }
  if (loai === 'NHAN_SUA') return `Nhận ${so(b.soLuong)}`;
  if (loai === 'SUA') return `Đạt ${so(b.soLuongSuaDat)} · hủy ${so(b.soLuongSuaHuy) + so(b.soLuongHuyThang)}${b.nguoiSua ? ` · ${b.nguoiSua}` : ''}`;
  return `Đạt ${so(b.soLuongDat)} · hư ${so(b.soLuongHu)}${so(b.soLuongThieu) ? ` · thiếu ${so(b.soLuongThieu)}` : ''}${b.nguoiKiem ? ` · ${b.nguoiKiem}` : ''}`;
}

/** Bỏ 1 mục CHỜ hoặc LỖI. Người xếp bỏ được mục của mình; quản trị ('*') bỏ được mọi mục. */
async function bo(user, id, lyDo = null) {
  if (!UUID_RE.test(String(id || ''))) throw new AppError('Mã mục không hợp lệ', { status: 422, errorCode: 'VALIDATION' });
  if (tt.dangLam === String(id)) throw new AppError('Mục này đang chạy — đợi vài giây', { status: 409, errorCode: 'DANG_CHAY' });
  const laAdmin = (user.permissions || []).includes('*');
  const { rowCount } = await query(
    `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     SELECT '${TB}', a.id_ban_ghi, 'HANG_DOI_BO', jsonb_build_object('ly_do', $3::text), $2::uuid, clock_timestamp(), $2::uuid
       FROM audit_log a
      WHERE a.ten_bang = '${TB}' AND a.id_ban_ghi = $1 AND a.hanh_dong = 'HANG_DOI_THEM'
        AND ($4::boolean OR a.nguoi_thuc_hien_id = $2::uuid)
        AND NOT EXISTS (SELECT 1 FROM audit_log b WHERE b.ten_bang = '${TB}' AND b.id_ban_ghi = $1
                         AND b.hanh_dong IN ('HANG_DOI_XONG', 'HANG_DOI_BO'))
      LIMIT 1`.replace(/\s+/g, ' '), [String(id), user.id, lyDo ? String(lyDo).slice(0, 200) : null, laAdmin]);
  if (!rowCount) throw new AppError('Mục không còn chờ / đã xong, hoặc không phải mục bạn xếp', { status: 409, errorCode: 'KHONG_BO_DUOC' });
  sockets.emit('hang-doi:cap-nhat', { bo: id });
  return { id };
}

// ─── Tiến trình chạy ─────────────────────────────────────────────────────────
const tt = { dang_chay: false, dangLam: null, kichLai: false };

async function ghiKetThuc(m, hd, moi) {
  await query(
    `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ('${TB}', $1, $2, $3::jsonb, $4::uuid, clock_timestamp(), $4::uuid)`.replace(/\s+/g, ' '),
    [m.id, hd, JSON.stringify(moi), m.nguoi_id]);
}

// Kết thúc của mục bước trước (`sau_muc`): 'HANG_DOI_XONG' | 'HANG_DOI_LOI' | 'HANG_DOI_BO' | null (còn chờ).
async function ketThucCua(id) {
  const { rows } = await query(
    `SELECT hanh_dong FROM audit_log WHERE ten_bang = '${TB}' AND id_ban_ghi = $1 AND hanh_dong IN ${KET_THUC} ORDER BY thoi_gian DESC LIMIT 1`, [id]);
  return rows[0] ? rows[0].hanh_dong : null;
}

async function lamMot(m) {
  const cfg = LOAI[m.loai] || LOAI.KCS;
  let loi = false;
  try {
    // Xích theo tem: bước trước LỖI / BỊ BỎ ⇒ số dự kiến không còn đúng ⇒ không chạy (người dùng làm lại tay rồi Bỏ).
    if (m.sau_muc) {
      const kt = await ketThucCua(m.sau_muc);
      if (kt !== 'HANG_DOI_XONG') {
        const ten = (LOAI[m.sau_loai] || {}).ten || 'bước trước';
        throw new AppError(`Bước trước (${ten}) của tem ${m.ma_tem} ${kt === 'HANG_DOI_BO' ? 'đã bị bỏ' : kt ? 'bị lỗi' : 'chưa chạy'} trong hàng đợi — làm lại tay bước đó rồi tới bước này`,
          { status: 409, errorCode: 'BUOC_TRUOC_LOI' });
      }
    }
    const kq = await cfg.chay(m);
    await ghiKetThuc(m, 'HANG_DOI_XONG', { ket_qua: kq || {} });
  } catch (e) {
    loi = true;
    await ghiKetThuc(m, 'HANG_DOI_LOI', { loi: String(e.message || 'Lỗi').slice(0, 500), ma_loi: e.errorCode || null });
  }
  sockets.emit('hang-doi:cap-nhat', { xong: m.id, loai: m.loai, loi });
  if (m.lo) await baoXongLo(m).catch((e) => console.error(`[hang-doi] ✗ báo xong lô: ${e.message}`));
}

// Lô hết mục chờ ⇒ thông báo người xếp (chuông + socket để màn đang mở hiện toast).
async function baoXongLo(m) {
  const { rows } = await query(
    `SELECT count(*) FILTER (WHERE k.hanh_dong IS NULL)::int AS cho, count(*) FILTER (WHERE k.hanh_dong = 'HANG_DOI_XONG')::int AS ok,
            count(*) FILTER (WHERE k.hanh_dong = 'HANG_DOI_LOI')::int AS loi,
            string_agg(a.gia_tri_moi->>'ma_tem', ', ' ORDER BY a.thoi_gian) FILTER (WHERE k.hanh_dong = 'HANG_DOI_LOI') AS tem_loi
       FROM audit_log a
       LEFT JOIN LATERAL (SELECT b.hanh_dong FROM audit_log b WHERE b.ten_bang = '${TB}' AND b.id_ban_ghi = a.id_ban_ghi
                           AND b.hanh_dong IN ${KET_THUC} ORDER BY b.thoi_gian DESC LIMIT 1) k ON true
      WHERE a.ten_bang = '${TB}' AND a.hanh_dong = 'HANG_DOI_THEM' AND a.gia_tri_moi->>'lo' = $1`.replace(/\s+/g, ' '), [m.lo]);
  const r = rows[0];
  if (!r || r.cho > 0) return;
  const ten = (LOAI[m.loai] || LOAI.KCS).ten;
  sockets.emit('hang-doi:xong-lo', { lo: m.lo, loai: m.loai, ten, user_id: m.nguoi_id, so_ok: r.ok, so_loi: r.loi, tem_loi: r.tem_loi });
  await require('../../utils/thongBaoHeThong').gui({
    maLoai: 'HANG_DOI_XONG',
    userIds: [m.nguoi_id],
    tieuDe: `Hàng đợi ${ten}: ${r.ok}/${r.ok + r.loi} tem đã chạy xong${r.loi ? ` · ${r.loi} lỗi` : ''}`,
    noiDung: r.loi
      ? `Tem lỗi: ${String(r.tem_loi || '').slice(0, 1500)} — mở trang Hàng đợi tích tem xem lý do, làm lại tay rồi bấm Bỏ.`
      : `Tất cả ${r.ok} tem bạn xếp vào hàng đợi ${ten} đã được hệ thống xác nhận thành công.`,
    trang: `/he-thong/hang-doi-tich-tem?lo=${m.lo}`,
    duLieu: { lo: m.lo, loai: m.loai, so_ok: r.ok, so_loi: r.loi },
  });
}

async function chay() {
  if (tt.dang_chay) { tt.kichLai = true; return; }
  if (!duocChayTrenMayNay()) return;
  tt.dang_chay = true;
  let client = null;
  let coKhoa = false;
  try {
    client = await pool.connect();
    const { rows } = await client.query(`SELECT pg_try_advisory_lock(${KHOA}) AS ok`);
    coKhoa = !!rows[0].ok;
    if (!coKhoa) return;
    do {
      tt.kichLai = false;
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const { rows: ds } = await client.query(
          `SELECT a.id_ban_ghi AS id, a.gia_tri_moi->>'loai' AS loai, a.gia_tri_moi->>'lo' AS lo, a.gia_tri_moi->>'tem_id' AS tem_id,
                  a.gia_tri_moi->>'ma_tem' AS ma_tem, a.gia_tri_moi->'moc' AS moc, a.gia_tri_moi->'body' AS body,
                  a.gia_tri_moi->>'sau_muc' AS sau_muc, a.gia_tri_moi->>'sau_loai' AS sau_loai,
                  a.nguoi_thuc_hien_id AS nguoi_id
             FROM audit_log a
            WHERE a.ten_bang = '${TB}' AND a.hanh_dong = 'HANG_DOI_THEM'
              AND NOT EXISTS (SELECT 1 FROM audit_log b WHERE b.ten_bang = '${TB}' AND b.id_ban_ghi = a.id_ban_ghi
                               AND b.hanh_dong IN ${KET_THUC})
              AND NOT EXISTS (SELECT 1 FROM audit_log p WHERE p.ten_bang = '${TB}' AND p.hanh_dong = 'HANG_DOI_THEM'
                               AND p.id_ban_ghi = a.gia_tri_moi->>'sau_muc' AND ${KHONG_KET_THUC('p')})
            ORDER BY a.thoi_gian, a.id LIMIT 1`.replace(/\s+/g, ' '));
        if (!ds.length) break;
        const m = { ...ds[0], body: ds[0].body || {}, moc: ds[0].moc == null ? null : Number(ds[0].moc) };
        tt.dangLam = m.id;
        try { await lamMot(m); } finally { tt.dangLam = null; } // eslint-disable-line no-await-in-loop
        await sleep(NGHI_GIUA_TEM_MS); // eslint-disable-line no-await-in-loop
      }
    } while (tt.kichLai);
  } catch (e) {
    console.error(`[hang-doi] ✗ ${e.message}`);
  } finally {
    if (client) {
      if (coKhoa) await client.query(`SELECT pg_advisory_unlock(${KHOA})`).catch(() => {});
      client.release();
    }
    tt.dang_chay = false;
  }
}

function kich() { setImmediate(() => { chay().catch(() => {}); }); }

let henGio = null;
function startHangDoiJob() {
  if (henGio) return;
  if (!duocChayTrenMayNay()) {
    console.log('[hang-doi] ⏸ Không chạy trên máy này (PGHOST không cục bộ — đặt HANG_DOI_JOB=true nếu đây là máy chủ)');
    return;
  }
  henGio = setInterval(kich, CHU_KY_MS);
  kich();
  console.log('[hang-doi] ▶ Chạy hàng đợi tích tem (KCS · Phân loại lỗi · Nhận sửa · Sửa)');
}

module.exports = { xep, duKien, danhSach, bo, startHangDoiJob, kich, LOAI, coQuyen, THU_TU };
