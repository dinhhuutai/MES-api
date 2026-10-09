'use strict';

// ─── BÁO CÁO SẢN XUẤT NGÀY — đọc dữ liệu thô (02/10/2026) ─────────────────────────────────────────
// Luật + cách dựng 2 bảng: `utils/baoCaoSanXuat.js` (hàm thuần). Ở đây chỉ ĐỌC, ưu tiên TỐC ĐỘ:
//   · 2 lượt chờ nối tiếp: (1) phiếu chạm ngày D + loại ca các tuần  →  (2) tem · lệnh · phần in · chuyền ·
//     tổ chạy SONG SONG theo id phiếu/lệnh đã có. Mọi câu gửi 1 dòng (IPS), không `--` trong chuỗi SQL.
//   · Cache trong RAM 15s theo ngày (FE nghe socket `production:updated` tự tải lại — 15s là độ trễ tối đa).
// ⚠ Dò cột trước khi dùng (khuôn `phieuCoCotToIn`): `phieu_san_xuat.to_in_id` (084) · `tem.ngay_ca` (066) ·
//   `tem.dot_vai_ve_id` (095) · `tem.tem_goc_id` (091) — thiếu cột thì lùi về giá trị rỗng, không lỗi.

const { query } = require('../../config/db');
const { dungBaoCaoSanXuat, khoaTuanIso, suyLoaiCaTuTem } = require('../../utils/baoCaoSanXuat');
const { NHOM_CA_RIENG, NHOM_CA_KHAC, CA_KHAC_MAC_DINH, khoaNhomCa } = require('../../utils/ca');

const daCo = new Map();
async function coCot(bang, cot) {
  const k = `${bang}.${cot}`;
  if (daCo.get(k)) return true;
  const { rows } = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2 LIMIT 1`,
    [bang, cot]
  );
  if (rows.length) daCo.set(k, true);
  return rows.length > 0;
}

// Mốc đầu ngày D (06:00 giờ VN) dựng trong SQL — không new Date() ở JS (server có thể khác múi giờ).
const KHUNG = "(($1::date + time '06:00') AT TIME ZONE 'Asia/Ho_Chi_Minh')";

const TRONG_NGAY = (cot) => `(${cot} >= ${KHUNG} AND ${cot} < ${KHUNG} + interval '1 day')`;
// Bỏ dữ liệu SCRIPT hệ thống ghi (02/10/2026 `chay_den_giao_ton_san_xuat_truoc_0110.sql`): phiếu `[HỆ THỐNG…` +
// tem `HT-…` — không phải sản xuất thật (đo prod 08/10: 4.626 phiếu · 4.657 tem, đều dồn vào ngày 02/10).
const PHIEU_THAT = "COALESCE(ps.ghi_chu, '') NOT LIKE '[HỆ THỐNG%'";
const TEM_THAT = "t.ma_tem NOT LIKE 'HT-%'";
// Tem thuộc ngày D: ngày ca = D; tem cũ chưa có ngày ca thì theo lúc in.
const TEM_CUA_NGAY = (coNgayCa) => (coNgayCa
  ? `(t.ngay_ca = $1::date OR (t.ngay_ca IS NULL AND ${TRONG_NGAY('t.created_date')}))`
  : TRONG_NGAY('t.created_date'));

// Phiếu có HOẠT ĐỘNG trong ngày: bấm chạy / bấm hoàn tất trong ngày, hoặc có tem của ngày. Phiếu treo
// `DANG_CHAY` từ hôm trước mà hôm nay không in gì ⇒ không lấy (xem `utils/baoCaoSanXuat.js`).
async function docPhieu(ngay, { coTo, coNgayCa }) {
  const sql = `SELECT ps.id, ps.lenh_san_xuat_id AS lenh_id, COALESCE(ps.chuyen_id, ls.chuyen_id) AS chuyen_id,
      ps.tg_bd, ps.tg_kt, ${coTo ? 'ps.to_in_id' : 'NULL::uuid'} AS to_in_id
    FROM phieu_san_xuat ps
    JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
    WHERE ps.trang_thai <> 'HUY' AND ls.trang_thai <> 'HUY' AND ${PHIEU_THAT}
      AND NOT EXISTS (SELECT 1 FROM chuyen_san_xuat cs JOIN loai_chuyen lc ON lc.id = cs.loai_chuyen_id
                       WHERE cs.id = COALESCE(ps.chuyen_id, ls.chuyen_id) AND lc.ma_loai = 'GIA_CONG')
      AND (${TRONG_NGAY('ps.tg_bd')} OR ${TRONG_NGAY('ps.tg_kt')}
           OR EXISTS (SELECT 1 FROM tem t WHERE t.phieu_san_xuat_id = ps.id AND t.trang_thai <> 'HUY'
                       AND ${TEM_THAT} AND ${TEM_CUA_NGAY(coNgayCa)}))`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [ngay]);
  return rows;
}

// Mốc tuyệt đối từ (ngày ca + giờ SX nhập ở ô In tem). Ca đêm (C3 / D2) mà giờ < 06:00 ⇒ đã sang hôm sau.
// Tem không nhập giờ ⇒ lúc in tem.
const MOC_TEM = (cotGio) => `CASE WHEN ${cotGio} IS NULL THEN t.created_date
  ELSE ((COALESCE(t.ngay_ca, (t.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) + ${cotGio}
    + CASE WHEN upper(right(COALESCE(t.ma_ngay_ca, ''), 2)) IN ('C3', 'D2') AND ${cotGio} < time '06:00'
           THEN interval '1 day' ELSE interval '0' END) AT TIME ZONE 'Asia/Ho_Chi_Minh') END`;

async function docTem(ngay, phieuIds, { coNgayCa, coDot, coGoc }) {
  if (!phieuIds.length) return [];
  // `coNgayCa` (mig 066) mang theo cả `gio_sx_bd/gio_sx_kt` — cùng một migration.
  const tu = coNgayCa ? MOC_TEM('t.gio_sx_bd') : 't.created_date';
  const den = coNgayCa ? MOC_TEM('t.gio_sx_kt') : 't.created_date';
  const sql = `SELECT t.phieu_san_xuat_id AS phieu_id, ${coDot ? 't.dot_vai_ve_id' : 'NULL::uuid'} AS dot_vai_ve_id,
      upper(right(COALESCE(${coNgayCa ? 't.ma_ngay_ca' : 'NULL'}, ''), 2)) AS ca_hint,
      EXTRACT(HOUR FROM t.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::int AS gio,
      SUM(t.so_luong)::int AS so_luong, min(${tu}) AS tu_min, max(${den}) AS den_max
    FROM tem t
    WHERE t.phieu_san_xuat_id = ANY($2::uuid[]) AND t.trang_thai <> 'HUY' AND ${TEM_THAT} ${coGoc ? 'AND t.tem_goc_id IS NULL' : ''}
      AND ${TEM_CUA_NGAY(coNgayCa)}
    GROUP BY 1, 2, 3, 4`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [ngay, phieuIds]);
  return rows;
}

async function docLenh(lenhIds) {
  const { rows } = await query(
    `SELECT id, ma_lenh_san_xuat, tg_bd_kh, tg_kt_kh, to_char(ngay_ke_hoach, 'YYYY-MM-DD') AS ngay_kh, so_luong_release
       FROM lenh_san_xuat WHERE id = ANY($1::uuid[])`.replace(/\s+/g, ' '),
    [lenhIds]
  );
  return rows;
}

// Phần in của lệnh (+ đợt vải để quy tem có `dot_vai_ve_id` về đúng phần in). Lệnh ép ủi in kiếng đọc đợt
// vải của lệnh liên kết (`lenh_lien_ket_id`) — cùng luật `production.repository.duLieuGhiInTem`.
async function docPhanIn(lenhIds) {
  const { rows } = await query(
    `SELECT ls.id AS lenh_id, pin.id AS phan_in_id, pin.ma_phan, SUM(lsd.so_luong)::int AS sl,
            array_agg(dv.id) AS dot_ids, kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang,
            pin.mau_vai, pin.kich_vai, pin.kich_phim
       FROM lenh_san_xuat ls
       JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = COALESCE(ls.lenh_lien_ket_id, ls.id)
       JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
       JOIN phan_in pin ON pin.id = dv.phan_in_id
       LEFT JOIN ma_hang mh ON mh.id = pin.ma_hang_id
       LEFT JOIN don_hang dh ON dh.id = mh.don_hang_id
       LEFT JOIN khach_hang kh ON kh.id = dh.khach_hang_id
      WHERE ls.id = ANY($1::uuid[])
      GROUP BY ls.id, pin.id, pin.ma_phan, kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang, pin.mau_vai, pin.kich_vai, pin.kich_phim`
      .replace(/\s+/g, ' '),
    [lenhIds]
  );
  return rows;
}

async function docChuyen(ids) {
  if (!ids.length) return [];
  const { rows } = await query(
    `SELECT cs.id, cs.ma_chuyen, cs.ten_chuyen, lc.ma_loai FROM chuyen_san_xuat cs
       LEFT JOIN loai_chuyen lc ON lc.id = cs.loai_chuyen_id WHERE cs.id = ANY($1::uuid[])`.replace(/\s+/g, ' '),
    [ids]
  );
  return rows;
}

async function docTo(ids) {
  if (!ids.length) return [];
  const { rows } = await query('SELECT id, ma_to, ten_to FROM to_in WHERE id = ANY($1::uuid[])', [ids]);
  return rows;
}

// Loại ca ĐÃ CÀI cho tuần ISO của ngày: { chung, rieng: {MAY|BAN|ROBOT: loại ca} } (mig 112 — đọc qua
// `planning.repository.caModeMap`, cùng nguồn mọi chỗ suy ca). Chưa cài / bảng chưa có ⇒ chung null (bên gọi
// suy từ tem).
async function loaiCaCuaNgay(ngay) {
  try {
    const map = await require('../planning/planning.repository').caModeMap();
    const khoa = khoaTuanIso(ngay);
    const rieng = {};
    NHOM_CA_RIENG.forEach((lc) => { if (map.has(`${khoa}|${lc}`)) rieng[lc] = map.get(`${khoa}|${lc}`); });
    return { chung: map.get(khoa) || null, rieng };
  } catch { return { chung: null, rieng: {} }; }
}

const duyNhat = (arr) => [...new Set(arr.filter(Boolean).map(String))];

const CACHE_MS = 15000;
const cache = new Map(); // ngay → { het, hua }

async function dungMoi(ngay) {
  const [coTo, coNgayCa, coDot, coGoc] = await Promise.all([
    coCot('phieu_san_xuat', 'to_in_id'), coCot('tem', 'ngay_ca'), coCot('tem', 'dot_vai_ve_id'), coCot('tem', 'tem_goc_id'),
  ]);
  const [phieus, loaiCa] = await Promise.all([docPhieu(ngay, { coTo, coNgayCa }), loaiCaCuaNgay(ngay)]);
  const lenhIds = duyNhat(phieus.map((p) => p.lenh_id));
  const [tems, lenhs, pins, chuyens, tos] = phieus.length ? await Promise.all([
    docTem(ngay, phieus.map((p) => p.id), { coNgayCa, coDot, coGoc }),
    docLenh(lenhIds),
    docPhanIn(lenhIds),
    docChuyen(duyNhat(phieus.map((p) => p.chuyen_id))),
    coTo ? docTo(duyNhat(phieus.map((p) => p.to_in_id))) : [],
  ]) : [[], [], [], [], []];
  const caChung = loaiCa.chung || suyLoaiCaTuTem(tems) || 'NGAN';
  // Mig 112: chuyền Máy/Bàn/Robot có cài riêng ⇒ chia ca theo cài riêng, không thì CHUNG; loại khác (nhóm KHAC —
  // Gia công, Máy tròn, Logo, Ép) ⇒ cài riêng của nhóm, mặc định Hành chính (09/10/2026) — gương `utils/ca.js loaiCaCua`.
  const caTheoLoai = (lc) => {
    const k = khoaNhomCa(lc);
    if (k === NHOM_CA_KHAC) return loaiCa.rieng[NHOM_CA_KHAC] || CA_KHAC_MAC_DINH;
    return (k && loaiCa.rieng[k]) || caChung;
  };
  const kq = dungBaoCaoSanXuat({ ngay, loaiCa: caTheoLoai, bayGio: Date.now(), phieus, tems, lenhs, pins, chuyens, tos });
  return { ...kq, loai_ca_da_cai: !!loaiCa.chung || Object.keys(loaiCa.rieng).length > 0 };
}

// Lưu PROMISE (không lưu kết quả) ⇒ nhiều người mở cùng lúc chỉ chạy 1 lượt; lỗi thì bỏ cache ngay.
async function baoCaoNgay(ngay) {
  const now = Date.now();
  const c = cache.get(ngay);
  if (c && c.het > now) return c.hua;
  const hua = dungMoi(ngay);
  cache.set(ngay, { het: now + CACHE_MS, hua });
  hua.catch(() => cache.delete(ngay));
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  return hua;
}

// `coCot` dùng chung với Báo cáo dừng chuyền (`./baoCaoDungChuyen.js`).
module.exports = { baoCaoNgay, coCot };
