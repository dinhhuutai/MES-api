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
  for (const x of ds) {
    const temId = String(x.temId);
    if (trung.has(temId)) { boQua.push({ tem_id: temId, ly_do: 'Tem đang chờ trong hàng đợi' }); continue; }
    const m = await LOAI[loai].moc(temId); // eslint-disable-line no-await-in-loop
    if (!m) { boQua.push({ tem_id: temId, ly_do: 'Tem không tồn tại' }); continue; }
    muc.push({ id: crypto.randomUUID(), loai, lo, tem_id: temId, ma_tem: m.ma_tem, moc: m.moc, body: locBody(loai, x.body) });
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

async function lamMot(m) {
  const cfg = LOAI[m.loai] || LOAI.KCS;
  let loi = false;
  try {
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
                  a.nguoi_thuc_hien_id AS nguoi_id
             FROM audit_log a
            WHERE a.ten_bang = '${TB}' AND a.hanh_dong = 'HANG_DOI_THEM'
              AND NOT EXISTS (SELECT 1 FROM audit_log b WHERE b.ten_bang = '${TB}' AND b.id_ban_ghi = a.id_ban_ghi
                               AND b.hanh_dong IN ${KET_THUC})
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

module.exports = { xep, danhSach, bo, startHangDoiJob, kich, LOAI, coQuyen };
