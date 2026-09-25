'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SLA KHÔNG CỐ ĐỊNH — 2 LUẬT NGHIỆP VỤ (chốt 24/09/2026). NGUỒN LUẬT DUY NHẤT: sửa ở đây, mọi nơi
// tính nghẽn (bản đồ nghẽn dashboard · màn READY · bảng theo dõi · Thời gian trạm) đổi theo.
//
// Cả 2 luật đều quy về đúng cặp số mà hệ vốn dùng — `sla_phut` (tính từ lúc vào trạm) + `canh_bao_
// truoc_phut` — nên cách tô đỏ/vàng (`utils/sla.js slaStatus` · FE `evalSla`) KHÔNG phải đổi gì.
//
// (1) READY — KHUÔN / FILM / MỰC: SLA theo GIỜ ĐỢT VẢI LÊN MES (giờ VN):
//     · 07:30 ≤ giờ < 15:00  ⇒ 8 giờ  (480 phút)  — trong ngày phải xong
//     · 15:00 ≤ giờ < 20:30  ⇒ 21 giờ (1260 phút) — trước 12:00 trưa hôm sau
//     · ngoài 2 khung trên   ⇒ SLA cấu hình của trạm READY như cũ (người dùng chưa chốt khung đêm)
//     Thêm/sửa khung = sửa mảng `KHUNG_SLA_READY`. Cảnh báo trước vẫn lấy của trạm.
//
// (2) TEST RUN — theo GIỜ SẢN XUẤT KẾ HOẠCH của PKH (`lenh_san_xuat.tg_bd_kh`):
//     · hạn Test Run = tg_bd_kh − 60 phút  ⇒ quá hạn = ĐỎ
//     · từ tg_bd_kh − 120 phút               ⇒ VÀNG (cảnh báo trước 60 phút so với hạn)
//     ⇒ sla_phut = phút từ lúc vào Test Run tới hạn; canh_bao = 60.
//     · lệnh chưa đặt GIỜ SX ⇒ ngày SX kế hoạch lúc 07:30; không có cả ngày ⇒ SLA trạm TEST_RUN như cũ.
//     · hạn đã qua ngay lúc vào trạm ⇒ sla = 1 phút (không để 0 — 0 nghĩa là "không tính SLA").
//
// (3) QC READY (checklist QC_XAC_NHAN) — theo GIỜ KỸ THUẬT XÁC NHẬN XONG (mốc vào hàng đợi QC, giờ VN):
//     · 16:30 ≤ giờ < 24:00 ⇒ 16 giờ (960 phút) — KT xong cuối ca thì QC làm sáng hôm sau
//     · còn lại           ⇒ SLA cấu hình của checklist QC_XAC_NHAN như cũ
//     (chốt 25/09/2026). Thêm/sửa khung = sửa mảng `KHUNG_SLA_QC`.
// ─────────────────────────────────────────────────────────────────────────────

const VN = "AT TIME ZONE 'Asia/Ho_Chi_Minh'";

const KHUNG_SLA_READY = [
  { tu: '07:30', den: '15:00', phut: 480 },
  { tu: '15:00', den: '20:30', phut: 1260 },
];

// ⚠ '24:00' là giá trị `time` HỢP LỆ trong Postgres (= cuối ngày) ⇒ `t < '24:00'` phủ tới 23:59:59.
const KHUNG_SLA_QC = [
  { tu: '16:30', den: '24:00', phut: 960 },
];

const TEST_RUN_TRUOC_SX_PHUT = 60;  // phải xong Test Run trước giờ SX bao nhiêu phút
const TEST_RUN_CANH_BAO_PHUT = 60;   // vàng sớm hơn hạn bao nhiêu phút (⇒ 2 giờ trước giờ SX)
// ⚠⚠ GIỜ SX KẾ HOẠCH = `tg_bd_kh`; THIẾU (đo prod 24/09: 117/163 lệnh chờ test chỉ có NGÀY) ⇒ lấy
//   `ngay_ke_hoach` lúc `GIO_SX_MAC_DINH` (giờ mặc định của form Release 1). Bản đầu lùi thẳng về SLA
//   trạm nên lệnh kế hoạch ngày 27/09 tạo sáng 24/09 đã bị tô đỏ sau 4 giờ — người dùng báo "chưa đúng".
const GIO_SX_MAC_DINH = '07:30';
const gioSxKhSql = (tgBdKhCol, ngayKhCol) =>
  `COALESCE(${tgBdKhCol}, ((${ngayKhCol})::date + time '${GIO_SX_MAC_DINH}') ${VN})`;

const hhmm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };

// ── SQL ──
// `tgCol` = mốc đợt vải lên MES; `macDinh` = biểu thức SLA trạm (fallback).
function slaKhungSql(khung, tgCol, macDinh) {
  const t = `(${tgCol} ${VN})::time`;
  const nhanh = khung.map((k) => `WHEN ${t} >= '${k.tu}' AND ${t} < '${k.den}' THEN ${Number(k.phut)}`).join(' ');
  return `(CASE WHEN ${tgCol} IS NULL THEN ${macDinh} ${nhanh} ELSE ${macDinh} END)`;
}
const slaReadySql = (tgCol, macDinh) => slaKhungSql(KHUNG_SLA_READY, tgCol, macDinh);
// `tgCol` = mốc Kỹ thuật xác nhận XONG (vào hàng đợi QC); `macDinh` = SLA checklist QC_XAC_NHAN.
const slaQcReadySql = (tgCol, macDinh) => slaKhungSql(KHUNG_SLA_QC, tgCol, macDinh);

// `tgVaoCol` = lúc vào Test Run; `tgBdKhCol` = giờ SX kế hoạch; `macDinh` = SLA trạm TEST_RUN.
function slaTestRunSql(tgVaoCol, tgBdKhCol, macDinh) {
  return `(CASE WHEN ${tgBdKhCol} IS NULL OR ${tgVaoCol} IS NULL THEN ${macDinh}
    ELSE GREATEST(1, floor(EXTRACT(EPOCH FROM ((${tgBdKhCol} - interval '${TEST_RUN_TRUOC_SX_PHUT} minutes') - ${tgVaoCol})) / 60))::int END)`;
}
function canhBaoTestRunSql(tgBdKhCol, macDinh) {
  return `(CASE WHEN ${tgBdKhCol} IS NULL THEN ${macDinh} ELSE ${TEST_RUN_CANH_BAO_PHUT} END)`;
}

// ── JS (cùng luật, cho chỗ tính ở service) ──
// Giờ VN của 1 mốc, không phụ thuộc múi giờ máy chủ.
function phutTrongNgayVN(tg) {
  if (!tg) return null;
  const d = new Date(tg);
  if (Number.isNaN(d.getTime())) return null;
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d);
  const g = Number(p.find((x) => x.type === 'hour').value);
  const m = Number(p.find((x) => x.type === 'minute').value);
  return g * 60 + m;
}
function slaKhung(khung, tg, macDinh) {
  const p = phutTrongNgayVN(tg);
  if (p == null) return macDinh;
  const k = khung.find((x) => p >= hhmm(x.tu) && p < hhmm(x.den));
  return k ? k.phut : macDinh;
}
const slaReady = (tg, macDinh) => slaKhung(KHUNG_SLA_READY, tg, macDinh);
const slaQcReady = (tg, macDinh) => slaKhung(KHUNG_SLA_QC, tg, macDinh);

module.exports = {
  KHUNG_SLA_READY, KHUNG_SLA_QC, TEST_RUN_TRUOC_SX_PHUT, TEST_RUN_CANH_BAO_PHUT, GIO_SX_MAC_DINH, gioSxKhSql,
  slaReadySql, slaQcReadySql, slaTestRunSql, canhBaoTestRunSql, slaReady, slaQcReady, phutTrongNgayVN,
};
