'use strict';

// ─── BÁO CÁO SẢN XUẤT NGÀY — đọc dữ liệu thô (02/10/2026) ─────────────────────────────────────────
// Luật + cách dựng 2 bảng: `utils/baoCaoSanXuat.js` (hàm thuần). Ở đây chỉ ĐỌC, ưu tiên TỐC ĐỘ:
//   · 2 lượt chờ nối tiếp: (1) phiếu chạm ngày D + loại ca các tuần  →  (2) tem · lệnh · phần in · chuyền ·
//     tổ chạy SONG SONG theo id phiếu/lệnh đã có. Mọi câu gửi 1 dòng (IPS), không `--` trong chuỗi SQL.
//   · Cache theo phiên bản dữ liệu (`utils/cacheDoc`, hạn 15 s) — in tem / mọi thao tác ghi xóa ngay; FE nghe socket
//     `production:updated` tự tải lại ⇒ máy khác in tem là số cộng thêm sau ~1–2 s.
// ⚠ Dò cột trước khi dùng (khuôn `phieuCoCotToIn`): `phieu_san_xuat.to_in_id` (084) · `tem.ngay_ca` (066) ·
//   `tem.dot_vai_ve_id` (095) · `tem.tem_goc_id` (091) — thiếu cột thì lùi về giá trị rỗng, không lỗi.

const { query } = require('../../config/db');
const { coCotChuyenTem } = require('../../utils/temChuyen');
const { dungBaoCaoSanXuat, khoaTuanIso, suyLoaiCaTuTem, ngayKe } = require('../../utils/baoCaoSanXuat');
const { NHOM_CA_RIENG, NHOM_CA_KHAC, khoaNhomCa, loaiCaChiTiet } = require('../../utils/ca');
const { thoInPhieuSql } = require('../../utils/thoIn');
const { coCotThoInKh } = require('../../utils/thoInKeHoach');
const { nhoDoc } = require('../../utils/cacheDoc');
const { temTrongKySql } = require('../../utils/ngaySxTem');

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
// Khung RỘNG để lấy phiếu (09/11/2026): tuần cài "ca trước" thì ngày D bắt đầu từ 18:00 hôm trước (ca Dài) / 22:00 (ca
//   Ngắn) — `utils/baoCaoSanXuat.js khungCa`. Lấy dư rồi hàm thuần cắt đúng khung của từng chuyền (phiếu ngoài khung ra 0).
const TRONG_NGAY_RONG = (cot) => `(${cot} >= ${KHUNG} - interval '12 hours' AND ${cot} < ${KHUNG} + interval '1 day')`;
// Bỏ dữ liệu SCRIPT hệ thống ghi (02/10/2026 `chay_den_giao_ton_san_xuat_truoc_0110.sql`): phiếu `[HỆ THỐNG…` +
// tem `HT-…` — không phải sản xuất thật (đo prod 08/10: 4.626 phiếu · 4.657 tem, đều dồn vào ngày 02/10).
const PHIEU_THAT = "COALESCE(ps.ghi_chu, '') NOT LIKE '[HỆ THỐNG%'";
const TEM_THAT = "t.ma_tem NOT LIKE 'HT-%'";
// Tem thuộc ngày D: ngày ca = D; tem cũ chưa có ngày ca thì theo lúc in — luật chung `utils/ngaySxTem.js`.
const TEM_CUA_NGAY = (coNgayCa) => (coNgayCa ? temTrongKySql('t', '$1') : TRONG_NGAY('t.created_date'));

// Phiếu có HOẠT ĐỘNG trong ngày: bấm chạy / bấm hoàn tất trong ngày, hoặc có tem của ngày. Phiếu treo
// `DANG_CHAY` từ hôm trước mà hôm nay không in gì ⇒ không lấy (xem `utils/baoCaoSanXuat.js`).
// 11/10/2026: kèm THỢ IN của phiếu (bảng "Theo thợ in") — phân công lúc chạy · thợ in kế hoạch của lệnh (mig 111)
//   · chuyền trưởng; luật chọn (chuyền Máy lấy chuyền trưởng, lấy người ĐẦU làm phụ trách) ở `utils/thoIn.js`.
async function docPhieu(ngay, { coTo, coNgayCa, coThoKh = false }) {
  const sql = `SELECT ps.id, ps.lenh_san_xuat_id AS lenh_id, COALESCE(ps.chuyen_id, ls.chuyen_id) AS chuyen_id,
      ps.tg_bd, ps.tg_kt, ${coTo ? 'ps.to_in_id' : 'NULL::uuid'} AS to_in_id,
      ps.chuyen_truong, ${thoInPhieuSql('ps.id')} AS tho_in, ${coThoKh ? 'ls.tho_in_kh' : 'NULL::text'} AS tho_in_kh
    FROM phieu_san_xuat ps
    JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
    WHERE ps.trang_thai <> 'HUY' AND ls.trang_thai <> 'HUY' AND ${PHIEU_THAT}
      AND NOT EXISTS (SELECT 1 FROM chuyen_san_xuat cs JOIN loai_chuyen lc ON lc.id = cs.loai_chuyen_id
                       WHERE cs.id = COALESCE(ps.chuyen_id, ls.chuyen_id) AND lc.ma_loai = 'GIA_CONG')
      AND (${TRONG_NGAY_RONG('ps.tg_bd')} OR ${TRONG_NGAY_RONG('ps.tg_kt')}
           OR EXISTS (SELECT 1 FROM tem t WHERE t.phieu_san_xuat_id = ps.id AND t.trang_thai <> 'HUY'
                       AND ${TEM_THAT} AND ${TEM_CUA_NGAY(coNgayCa)}))`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [ngay]);
  return rows;
}

// Mốc tuyệt đối từ (ngày ca + giờ SX nhập ở ô In tem). Ca đêm (C3 / D2) mà giờ < 06:00 ⇒ đã sang hôm sau.
// Tem không nhập giờ ⇒ lúc in tem.
// ⚠ 08/11/2026 — tuần cài "ca trước" (mig 125): mã ca đêm mang NGÀY KẾT THÚC ca (D2 ngày 08 = 18:00 ngày 07 → 06:00
//   ngày 08) ⇒ cách cộng trên ra mốc SAU lúc in tem đúng 1 ngày ⇒ lùi 1 ngày khi mốc giờ BĐ của tem > lúc in + 2 giờ
//   (hàng in xong mới in tem). Đoán theo dữ liệu, không đọc cài đặt — gương `production.repository duLieuGhiInTem`.
const NGAY_TEM = "COALESCE(t.ngay_ca, (t.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)";
const DEM_TEM = "upper(right(COALESCE(t.ma_ngay_ca, ''), 2)) IN ('C3', 'D2')";
const LUI_CA_TRUOC = `CASE WHEN ${DEM_TEM} AND t.gio_sx_bd IS NOT NULL
    AND ((${NGAY_TEM} + t.gio_sx_bd + CASE WHEN t.gio_sx_bd < time '06:00' THEN interval '1 day' ELSE interval '0' END)
         AT TIME ZONE 'Asia/Ho_Chi_Minh') > t.created_date + interval '2 hours'
    THEN interval '1 day' ELSE interval '0' END`;
const MOC_TEM = (cotGio) => `CASE WHEN ${cotGio} IS NULL THEN t.created_date
  ELSE ((${NGAY_TEM} + ${cotGio}
    + CASE WHEN ${DEM_TEM} AND ${cotGio} < time '06:00'
           THEN interval '1 day' ELSE interval '0' END - ${LUI_CA_TRUOC}) AT TIME ZONE 'Asia/Ho_Chi_Minh') END`;

// 26/10/2026: 1 dòng / TEM (trước GROUP BY phiếu × đợt × ca × giờ) — modal "bấm ô SL in thực tế" cần danh sách tem
//   (mã tem · mã ngày ca · giờ SX · người in). Vài trăm tem / ngày ⇒ payload vẫn nhỏ; phép cộng ở hàm thuần không đổi.
async function docTem(ngay, phieuIds, { coNgayCa, coDot, coGoc, coChuyenRieng }) {
  if (!phieuIds.length) return [];
  // `coNgayCa` (mig 066) mang theo cả `gio_sx_bd/gio_sx_kt` — cùng một migration.
  const tu = coNgayCa ? MOC_TEM('t.gio_sx_bd') : 't.created_date';
  const den = coNgayCa ? MOC_TEM('t.gio_sx_kt') : 't.created_date';
  const sql = `SELECT t.id, t.ma_tem, t.phieu_san_xuat_id AS phieu_id, ${coDot ? 't.dot_vai_ve_id' : 'NULL::uuid'} AS dot_vai_ve_id,
      ${coNgayCa ? 't.ma_ngay_ca' : 'NULL::text'} AS ma_ngay_ca,
      upper(right(COALESCE(${coNgayCa ? 't.ma_ngay_ca' : 'NULL'}, ''), 2)) AS ca_hint,
      EXTRACT(HOUR FROM t.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::int AS gio,
      t.so_luong::int AS so_luong, ${tu} AS tu_min, ${den} AS den_max, t.created_date AS tg_in,
      ${coChuyenRieng ? 't.chuyen_id' : 'NULL::uuid'} AS chuyen_rieng_id,
      ${coNgayCa ? "to_char(t.gio_sx_bd, 'HH24:MI')" : 'NULL'} AS gio_sx_bd, ${coNgayCa ? "to_char(t.gio_sx_kt, 'HH24:MI')" : 'NULL'} AS gio_sx_kt,
      (SELECT nd.ho_ten FROM nguoi_dung nd WHERE nd.id = t.created_by) AS nguoi_in
    FROM tem t
    WHERE t.phieu_san_xuat_id = ANY($2::uuid[]) AND t.trang_thai <> 'HUY' AND ${TEM_THAT} ${coGoc ? 'AND t.tem_goc_id IS NULL' : ''}
      AND ${TEM_CUA_NGAY(coNgayCa)}
    ORDER BY t.created_date`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [ngay, phieuIds]);
  return rows;
}

// `tg_chay_dau` = lần bấm Xác nhận chạy ĐẦU TIÊN của lệnh (phiếu chưa hủy, không tính phiếu script hệ thống) —
// kế hoạch của lệnh tính vào ngày đó (19/10/2026, xem `utils/baoCaoSanXuat.js`). Lệnh chạy lại sau "Ngừng lệnh
// chạy" vẫn giữ mốc đầu ⇒ không đếm kế hoạch 2 lần.
async function docLenh(lenhIds) {
  const { rows } = await query(
    `SELECT ls.id, ls.ma_lenh_san_xuat, ls.tg_bd_kh, ls.tg_kt_kh, to_char(ls.ngay_ke_hoach, 'YYYY-MM-DD') AS ngay_kh,
            ls.so_luong_release,
            (SELECT min(ps.tg_bd) FROM phieu_san_xuat ps WHERE ps.lenh_san_xuat_id = ls.id AND ps.trang_thai <> 'HUY'
               AND ${PHIEU_THAT}) AS tg_chay_dau
       FROM lenh_san_xuat ls WHERE ls.id = ANY($1::uuid[])`.replace(/\s+/g, ' '),
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

// Cấu hình ca của tuần ISO chứa ngày: { map, khoa } — đọc qua `planning.repository.caModeMap`, suy bằng
// `utils/ca.js loaiCaChiTiet` (CÙNG LUẬT mọi chỗ suy ca, gồm thừa hưởng tuần trước — 21/10/2026). Bảng chưa có ⇒ map rỗng.
// `khoaSau` = tuần của ngày D+1 (09/11/2026): ngày D kết thúc lúc ngày D+1 bắt đầu — D+1 ở tuần "ca trước" thì đêm D → D+1
//   thuộc D+1 (`utils/baoCaoSanXuat.js khungCa`).
async function loaiCaCuaNgay(ngay) {
  const khoa = khoaTuanIso(ngay);
  const khoaSau = khoaTuanIso(ngayKe(ngay));
  try {
    return { map: await require('../planning/planning.repository').caModeMap(), khoa, khoaSau };
  } catch { return { map: new Map(), khoa, khoaSau }; }
}

const duyNhat = (arr) => [...new Set(arr.filter(Boolean).map(String))];

const CACHE_MS = 15000;

async function dungMoi(ngay) {
  const [coTo, coNgayCa, coDot, coGoc] = await Promise.all([
    coCot('phieu_san_xuat', 'to_in_id'), coCot('tem', 'ngay_ca'), coCot('tem', 'dot_vai_ve_id'), coCot('tem', 'tem_goc_id'),
  ]);
  const coThoKh = await coCotThoInKh();
  const coChuyenRieng = await coCotChuyenTem();
  const [phieus, loaiCa] = await Promise.all([docPhieu(ngay, { coTo, coNgayCa, coThoKh }), loaiCaCuaNgay(ngay)]);
  const lenhIds = duyNhat(phieus.map((p) => p.lenh_id));
  const tems = phieus.length ? await docTem(ngay, phieus.map((p) => p.id), { coNgayCa, coDot, coGoc, coChuyenRieng }) : [];
  const [lenhs, pins, chuyens, tos] = phieus.length ? await Promise.all([
    docLenh(lenhIds),
    docPhanIn(lenhIds),
    // Kèm chuyền riêng của tem (Sửa tem đổi chuyền, mig 124) — `dungBaoCaoSanXuat` cộng SL in của tem đó sang chuyền này.
    docChuyen(duyNhat([...phieus.map((p) => p.chuyen_id), ...tems.map((t) => t.chuyen_rieng_id).filter(Boolean)])),
    coTo ? docTo(duyNhat(phieus.map((p) => p.to_in_id))) : [],
  ]) : [[], [], [], []];
  // Mọi loại chuyền suy qua `loaiCaChiTiet` (riêng ⇒ chung ⇒ thừa hưởng tuần trước; nhóm Khác chỉ theo riêng Khác,
  //   mặc định Hành chính). Riêng báo cáo: Máy/Bàn/Robot chưa TỪNG cài (mặc định) ⇒ suy từ mã ca trên tem như trước.
  const caTem = suyLoaiCaTuTem(tems) || 'NGAN';
  const loaiCaThat = (r, lc) => (r.nguon === 'MAC_DINH' && khoaNhomCa(lc) !== NHOM_CA_KHAC ? caTem : r.loaiCa);
  // 09/11/2026: kèm CA ĐÊM (ca trước / ca sau, mig 125) của ngày D và ngày D+1 ⇒ khung ngày của từng chuyền.
  const caTheoLoai = (lc) => {
    const r = loaiCaChiTiet(loaiCa.map, loaiCa.khoa, lc);
    const s = loaiCaChiTiet(loaiCa.map, loaiCa.khoaSau, lc);
    return { loaiCa: loaiCaThat(r, lc), caDem: r.caDem, loaiCaSau: loaiCaThat(s, lc), caDemSau: s.caDem };
  };
  const kq = dungBaoCaoSanXuat({ ngay, loaiCa: caTheoLoai, bayGio: Date.now(), phieus, tems, lenhs, pins, chuyens, tos });
  const daCai = ['', ...NHOM_CA_RIENG].some((g) => loaiCaChiTiet(loaiCa.map, loaiCa.khoa, g || null).nguon !== 'MAC_DINH');
  return { ...kq, loai_ca_da_cai: daCai };
}

// Nhiều người mở cùng lúc chỉ chạy 1 lượt (giữ PROMISE); lỗi thì bỏ cache ngay.
// ⚠ 29/10/2026 (người dùng hỏi "máy khác in tem thì bên đây có cộng thêm không"): cache RIÊNG 15 s cũ KHÔNG bị xóa khi
//   in tem ⇒ trang nghe socket tải lại sau 1,2 s vẫn nhận số CŨ, số mới chỉ hiện ở sự kiện kế tiếp sau 15 s (in xong mà
//   không ai làm gì nữa là đứng luôn). Nay dùng cache theo PHIÊN BẢN DỮ LIỆU (`utils/cacheDoc`) — mọi thao tác ghi / socket
//   làm nó hết hiệu lực ngay.
function baoCaoNgay(ngay) {
  return nhoDoc('bao-cao-san-xuat', { ngay }, () => dungMoi(ngay), CACHE_MS);
}

// `coCot` dùng chung với Báo cáo dừng chuyền (`./baoCaoDungChuyen.js`).
// Mảnh SQL dùng chung với Theo dõi theo tổ (`theoDoiTo.js`, 21/10/2026) — cùng tập tem / phiếu thật, cùng ngày SX.
module.exports = { baoCaoNgay, coCot, PHIEU_THAT, TEM_THAT, TEM_CUA_NGAY, MOC_TEM };
