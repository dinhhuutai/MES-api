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
//     Khung sửa ở trang Checkpoint & Checklist (`READY_THEO_GIO`). Cảnh báo trước vẫn lấy của trạm.
//
// (2) TEST RUN — theo GIỜ SẢN XUẤT KẾ HOẠCH của PKH (`lenh_san_xuat.tg_bd_kh`):
//     · hạn Test Run = tg_bd_kh − 60 phút  ⇒ quá hạn = ĐỎ
//     · từ tg_bd_kh − 120 phút               ⇒ VÀNG (cảnh báo trước 60 phút so với hạn)
//     ⇒ sla_phut = phút từ lúc vào Test Run tới hạn; canh_bao = 60.
//     · lệnh chưa đặt GIỜ SX ⇒ ngày SX kế hoạch lúc 07:30; không có cả ngày ⇒ SLA trạm TEST_RUN như cũ.
//     · ⚠ TỐI THIỂU `toi_thieu_phut` (mặc định 120) kể từ lúc Release 1 đưa lệnh xuống (08/10/2026, người dùng
//       chốt): sla_phut = MAX(toi_thieu, phút tới hạn) ⇒ lệnh release sát/qua giờ SX vẫn có 2 giờ rồi mới nghẽn
//       (đo prod 08/10: 17/108 lệnh chờ test đỏ NGAY lúc vào trạm vì hạn đã qua trước khi lệnh được tạo).
//       Mốc vào = `lenh_san_xuat.created_date` (bản đồ nghẽn + `siSoTram.DV.TEST_RUN`). 0 = không gia hạn.
//     · Lệnh bị Test Run trả về Kế hoạch rồi xác nhận lại ⇒ tối thiểu tính LẠI từ lúc xác nhận lại — luật (6).
//
// (3) QC READY (checklist QC_XAC_NHAN) — theo GIỜ KỸ THUẬT XÁC NHẬN XONG (mốc vào hàng đợi QC, giờ VN):
//     · 16:30 ≤ giờ < 24:00 ⇒ 16 giờ (960 phút) — KT xong cuối ca thì QC làm sáng hôm sau
//     · còn lại           ⇒ SLA cấu hình của checklist QC_XAC_NHAN như cũ
//     (chốt 25/09/2026). Khung sửa ở trang Checkpoint & Checklist (`QC_READY_THEO_GIO`).
//     ⚠ Tính theo giờ ĐỒNG HỒ liên tục (không trừ giờ nghỉ): KT xong 10:00 ⇒ 11:00 nghẽn (SLA 60p).
//
// (4) ⚠⚠⚠ READY KỸ THUẬT — THEO HẠN GIAO CỦA ĐỢT VẢI (chốt 25/09/2026, THAY luật (1) khi có hạn giao):
//     · còn ≤ 1 ngày tới hạn giao (từ 00:00 ngày H−1, giờ VN) mà chưa xác nhận đủ ⇒ ĐỎ
//     · còn 2 ngày (từ 00:00 ngày H−2)                                              ⇒ VÀNG
//     Ví dụ hạn 26: ngày 25 đỏ, ngày 24 vàng. Quy về cặp số quen thuộc: sla_phut = phút từ lúc vào
//     READY tới 00:00 ngày H−1 (tối thiểu 1), canh_bao = 1440. Đợt KHÔNG có hạn giao ⇒ lùi về luật (1).
//     ⚠ Hạn giao phải là của ĐÚNG ĐỢT đang chờ (đợt bổ sung ≠ đợt số lượng đã release).
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// ⚠⚠ CẤU HÌNH ĐƯỢC (mig 109, 30/09/2026): các con số của 4 luật trên nay sửa ở *Hệ thống › Checkpoint &
// Checklist* (khối "SLA theo giờ"), lưu bảng `cai_dat_sla_gio`. `MAC_DINH` dưới đây = đúng giá trị đã chốt
// (và = seed mig 109) ⇒ thiếu bảng/dòng/giá trị hỏng thì dùng mặc định (fail-open đúng hướng: giữ luật cũ).
//   · Các hàm dựng SQL/JS ĐỌC `cfg` LÚC GỌI (không đóng băng lúc nạp module) ⇒ lưu xong có hiệu lực ngay.
//   · `napCauHinh()` chạy lúc khởi động + mỗi `NAP_LAI_MS` (tiến trình BE khác tự bắt kịp) + ngay sau khi lưu.
//   · Giá trị được CHÈN THẲNG vào SQL ⇒ `chuanHoa()` kiểm chặt (số nguyên, `HH:MM`) cả lúc LƯU lẫn lúc ĐỌC.
//   · `bat=false` ⇒ luật tắt, về SLA cấu hình của trạm/checklist (READY tắt luật hạn giao ⇒ về luật giờ lên MES).
// ─────────────────────────────────────────────────────────────────────────────
const VN = "AT TIME ZONE 'Asia/Ho_Chi_Minh'";
const NAP_LAI_MS = 60 * 1000;

const MAC_DINH = {
  READY_THEO_HAN_GIAO: { bat: true, gia_tri: { do_ngay: 1, vang_ngay: 2 } },
  READY_THEO_GIO: { bat: true, gia_tri: { khung: [{ tu: '07:30', den: '15:00', phut: 480 }, { tu: '15:00', den: '20:30', phut: 1260 }] } },
  // ⚠ '24:00' là giá trị `time` HỢP LỆ trong Postgres (= cuối ngày) ⇒ `t < '24:00'` phủ tới 23:59:59.
  QC_READY_THEO_GIO: { bat: true, gia_tri: { khung: [{ tu: '16:30', den: '24:00', phut: 960 }] } },
  // ⚠⚠ GIỜ SX KẾ HOẠCH = `tg_bd_kh`; THIẾU (đo prod 24/09: 117/163 lệnh chờ test chỉ có NGÀY) ⇒ lấy
  //   `ngay_ke_hoach` lúc `gio_sx_mac_dinh` (giờ mặc định của form Release 1).
  TEST_RUN_THEO_GIO_SX: { bat: true, gia_tri: { truoc_sx_phut: 60, canh_bao_phut: 60, gio_sx_mac_dinh: '07:30', toi_thieu_phut: 120 } },
};
const MA_SLA = Object.keys(MAC_DINH);

const hhmm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
const RE_GIO = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const soNguyen = (v, min, max) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : null; };

// Kiểm + chuẩn hóa `gia_tri` của 1 luật. Sai ⇒ ném Error (thông điệp tiếng Việt, dùng lại ở service khi LƯU).
function chuanHoa(ma, g) {
  const v = g || {};
  if (ma === 'READY_THEO_GIO' || ma === 'QC_READY_THEO_GIO') {
    const khung = Array.isArray(v.khung) ? v.khung : [];
    if (khung.length > 6) throw new Error('Tối đa 6 khung giờ');
    const ra = khung.map((k, i) => {
      const tu = String(k.tu || '').trim(); const den = String(k.den || '').trim();
      if (!RE_GIO.test(tu) || tu === '24:00' || !RE_GIO.test(den)) throw new Error(`Khung ${i + 1}: giờ phải dạng HH:MM (đến tối đa 24:00)`);
      if (hhmm(tu) >= hhmm(den)) throw new Error(`Khung ${i + 1}: "từ" phải trước "đến"`);
      const phut = soNguyen(k.phut, 1, 10080);
      if (phut == null) throw new Error(`Khung ${i + 1}: số phút phải là số nguyên 1–10080`);
      return { tu, den, phut };
    }).sort((a, b) => hhmm(a.tu) - hhmm(b.tu));
    for (let i = 1; i < ra.length; i += 1) {
      if (hhmm(ra[i].tu) < hhmm(ra[i - 1].den)) throw new Error(`Khung ${ra[i - 1].tu}–${ra[i - 1].den} và ${ra[i].tu}–${ra[i].den} chồng nhau`);
    }
    return { khung: ra };
  }
  if (ma === 'READY_THEO_HAN_GIAO') {
    const doNgay = soNguyen(v.do_ngay, 0, 30); const vangNgay = soNguyen(v.vang_ngay, 0, 30);
    if (doNgay == null || vangNgay == null) throw new Error('Số ngày phải là số nguyên 0–30');
    if (vangNgay < doNgay) throw new Error('Ngày vàng phải ≥ ngày đỏ');
    return { do_ngay: doNgay, vang_ngay: vangNgay };
  }
  if (ma === 'TEST_RUN_THEO_GIO_SX') {
    const truoc = soNguyen(v.truoc_sx_phut, 0, 1440); const cb = soNguyen(v.canh_bao_phut, 0, 1440);
    const gio = String(v.gio_sx_mac_dinh || '').trim();
    // Khóa thêm 08/10/2026 — dòng đã lưu trước đó (seed mig 109) chưa có ⇒ dùng mặc định, KHÔNG coi là hỏng.
    const thieuToiThieu = v.toi_thieu_phut == null || v.toi_thieu_phut === '';
    const toiThieu = thieuToiThieu ? MAC_DINH.TEST_RUN_THEO_GIO_SX.gia_tri.toi_thieu_phut : soNguyen(v.toi_thieu_phut, 0, 1440);
    if (truoc == null || cb == null || toiThieu == null) throw new Error('Số phút phải là số nguyên 0–1440');
    if (!RE_GIO.test(gio) || gio === '24:00') throw new Error('Giờ SX mặc định phải dạng HH:MM');
    return { truoc_sx_phut: truoc, canh_bao_phut: cb, gio_sx_mac_dinh: gio, toi_thieu_phut: toiThieu };
  }
  throw new Error(`Luật SLA lạ: ${ma}`);
}

// Cấu hình ĐANG CHẠY (RAM). Mọi hàm bên dưới đọc từ đây.
let cfg = JSON.parse(JSON.stringify(MAC_DINH));

// Áp các dòng đọc từ DB; dòng hỏng ⇒ giữ mặc định của luật đó (log 1 dòng, không ném).
function apDung(rows) {
  const moi = JSON.parse(JSON.stringify(MAC_DINH));
  for (const r of rows || []) {
    if (!MAC_DINH[r.ma]) continue;
    try { moi[r.ma] = { bat: r.bat !== false, gia_tri: chuanHoa(r.ma, r.gia_tri) }; }
    catch (e) { console.warn(`[sla] cấu hình ${r.ma} hỏng, dùng mặc định: ${e.message}`); }
  }
  cfg = moi;
}

// Nạp từ DB. Thiếu bảng (chưa chạy mig 109) / lỗi mạng ⇒ giữ cấu hình đang có (fail-open).
async function napCauHinh() {
  try {
    const { query } = require('../config/db'); // require muộn: tránh vòng phụ thuộc lúc nạp module
    const { rows } = await query('SELECT ma, bat, gia_tri FROM cai_dat_sla_gio');
    apDung(rows);
  } catch (e) {
    if (!/cai_dat_sla_gio/.test(e.message || '')) console.warn('[sla] không nạp được cấu hình SLA theo giờ:', e.message);
  }
  return cfg;
}
let hen = null;
function batDauNapDinhKy() {
  if (hen) return;
  napCauHinh();
  hen = setInterval(napCauHinh, NAP_LAI_MS);
  if (hen.unref) hen.unref();
}
const layCauHinh = () => JSON.parse(JSON.stringify(cfg));

// ── Đọc cấu hình đang chạy ──
const khungReady = () => (cfg.READY_THEO_GIO.bat ? cfg.READY_THEO_GIO.gia_tri.khung : []);
const khungQc = () => (cfg.QC_READY_THEO_GIO.bat ? cfg.QC_READY_THEO_GIO.gia_tri.khung : []);
const hanBat = () => cfg.READY_THEO_HAN_GIAO.bat;
const hanDoNgay = () => cfg.READY_THEO_HAN_GIAO.gia_tri.do_ngay;
const hanCanhBao = () => (cfg.READY_THEO_HAN_GIAO.gia_tri.vang_ngay - cfg.READY_THEO_HAN_GIAO.gia_tri.do_ngay) * 1440;
const testBat = () => cfg.TEST_RUN_THEO_GIO_SX.bat;
// Phải xong Test Run trước giờ SX bao nhiêu phút. Luật tắt ⇒ null (người gọi dùng SLA trạm).
const testRunTruocSxPhut = () => (testBat() ? cfg.TEST_RUN_THEO_GIO_SX.gia_tri.truoc_sx_phut : null);
const gioSxMacDinh = () => cfg.TEST_RUN_THEO_GIO_SX.gia_tri.gio_sx_mac_dinh;
// SLA Test Run tối thiểu (phút từ lúc vào trạm). Không bao giờ < 1 (0 = "không tính SLA").
const testRunToiThieuPhut = () => Math.max(1, Number(cfg.TEST_RUN_THEO_GIO_SX.gia_tri.toi_thieu_phut) || 0);

const gioSxKhSql = (tgBdKhCol, ngayKhCol) =>
  `COALESCE(${tgBdKhCol}, ((${ngayKhCol})::date + time '${gioSxMacDinh()}') ${VN})`;

// ── SQL ──
// `tgCol` = mốc đợt vải lên MES; `macDinh` = biểu thức SLA trạm (fallback).
function slaKhungSql(khung, tgCol, macDinh) {
  if (!khung.length) return `(${macDinh})`;
  const t = `(${tgCol} ${VN})::time`;
  const nhanh = khung.map((k) => `WHEN ${t} >= '${k.tu}' AND ${t} < '${k.den}' THEN ${Number(k.phut)}`).join(' ');
  return `(CASE WHEN ${tgCol} IS NULL THEN ${macDinh} ${nhanh} ELSE ${macDinh} END)`;
}
const slaReadySql = (tgCol, macDinh) => slaKhungSql(khungReady(), tgCol, macDinh);
// `tgCol` = mốc Kỹ thuật xác nhận XONG (vào hàng đợi QC); `macDinh` = SLA checklist QC_XAC_NHAN.
const slaQcReadySql = (tgCol, macDinh) => slaKhungSql(khungQc(), tgCol, macDinh);

// Mốc ĐỎ của READY theo hạn giao = 00:00 (giờ VN) ngày (hạn − do_ngay).
const mocDoReadySql = (hanCol) => `(((${hanCol})::date - ${Number(hanDoNgay())}) + time '00:00') ${VN}`;
// `hanCol` = hạn giao (DATE) của đợt; `macDinh` = SLA theo giờ lên MES (luật (1)) khi thiếu hạn.
// ⚠ Luật hạn giao TẮT ⇒ coi như mọi đợt thiếu hạn (về luật (1)). Người gọi dùng `mocDoReadySql` trực tiếp
//   (siso) phải tự gác bằng `hanBat()` — xem `siso.repository.batDauNghenSql`.
function slaReadyHanSql(tgVaoCol, hanCol, tgLenMesCol, macDinh) {
  if (!hanBat()) return slaReadySql(tgLenMesCol, macDinh);
  return `(CASE WHEN ${hanCol} IS NULL OR ${tgVaoCol} IS NULL THEN ${slaReadySql(tgLenMesCol, macDinh)}
    ELSE GREATEST(1, floor(EXTRACT(EPOCH FROM (${mocDoReadySql(hanCol)} - ${tgVaoCol})) / 60))::int END)`;
}
const canhBaoReadyHanSql = (hanCol, macDinh) => (hanBat()
  ? `(CASE WHEN ${hanCol} IS NULL THEN ${macDinh} ELSE ${Number(hanCanhBao())} END)`
  : `(${macDinh})`);

// `tgVaoCol` = lúc vào Test Run; `tgBdKhCol` = giờ SX kế hoạch; `macDinh` = SLA trạm TEST_RUN.
// sla = MAX(tối thiểu, phút tới hạn) — xem luật (2).
function slaTestRunSql(tgVaoCol, tgBdKhCol, macDinh) {
  if (!testBat()) return `(${macDinh})`;
  return `(CASE WHEN ${tgBdKhCol} IS NULL OR ${tgVaoCol} IS NULL THEN ${macDinh}
    ELSE GREATEST(${testRunToiThieuPhut()}, floor(EXTRACT(EPOCH FROM ((${tgBdKhCol} - interval '${Number(testRunTruocSxPhut())} minutes') - ${tgVaoCol})) / 60))::int END)`;
}
function canhBaoTestRunSql(tgBdKhCol, macDinh) {
  if (!testBat()) return `(${macDinh})`;
  return `(CASE WHEN ${tgBdKhCol} IS NULL THEN ${macDinh} ELSE ${Number(cfg.TEST_RUN_THEO_GIO_SX.gia_tri.canh_bao_phut)} END)`;
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
const slaReady = (tg, macDinh) => slaKhung(khungReady(), tg, macDinh);

// Ngày YYYY-MM-DD của hạn giao. node-pg trả cột DATE thành Date lúc 00:00 GIỜ MÁY CHỦ ⇒ đọc thành phần
// LOCAL (đừng toISOString — lùi 1 ngày ở UTC+7). Chuỗi thì cắt 10 ký tự đầu.
function ngayHan(han) {
  if (!han) return null;
  if (han instanceof Date) {
    if (Number.isNaN(han.getTime())) return null;
    return [han.getFullYear(), han.getMonth() + 1, han.getDate()];
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(han));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
// Mốc ĐỎ (ms) = 00:00 giờ VN (UTC+7, không DST) ngày hạn − do_ngay. Luật tắt ⇒ null.
function mocDoReady(han) {
  if (!hanBat()) return null;
  const n = ngayHan(han);
  return n ? Date.UTC(n[0], n[1] - 1, n[2] - hanDoNgay()) - 7 * 3600000 : null;
}
// Luật (4) cho service: trả { sla, canhBao }. Thiếu hạn / thiếu mốc vào / luật tắt ⇒ luật (1).
function slaReadyHan(tgVao, han, tgLenMes, macDinh, canhBaoMacDinh) {
  const moc = mocDoReady(han);
  const vao = tgVao ? new Date(tgVao).getTime() : NaN;
  if (moc == null || Number.isNaN(vao)) return { sla: slaReady(tgLenMes, macDinh), canhBao: canhBaoMacDinh };
  return { sla: Math.max(1, Math.floor((moc - vao) / 60000)), canhBao: hanCanhBao() };
}
const slaQcReady = (tg, macDinh) => slaKhung(khungQc(), tg, macDinh);
// Luật (2) cho service — gương `slaTestRunSql`. `tgBdKh` = giờ SX kế hoạch (đã lùi về ngày KH + giờ mặc định).
function slaTestRun(tgVao, tgBdKh, macDinh) {
  const vao = msOf(tgVao); const bd = msOf(tgBdKh);
  if (!testBat() || Number.isNaN(vao) || Number.isNaN(bd)) return macDinh;
  const han = bd - testRunTruocSxPhut() * 60000;
  return Math.max(testRunToiThieuPhut(), Math.floor((han - vao) / 60000));
}

// ─────────────────────────────────────────────────────────────────────────────
// (5) GIA HẠN KHI BỊ TRẢ VỀ KỸ THUẬT (07/10/2026, người dùng chốt): phần in bị trạm khác trả về KT (mốc
//     `tech.ktTraVeSql`) thì KT có ÍT NHẤT `TRA_VE_KT_GIA_HAN_PHUT` phút kể từ lúc bị trả về mới tính nghẽn —
//     hạn đỏ = MUỘN HƠN giữa (hạn theo luật (4)/(1), lúc trả về + 60′). Không có thì READY theo hạn giao đỏ
//     NGAY khi hàng sát hạn bị trả về ⇒ KT bị bắt nhập lý do nghẽn cho việc vừa nhận.
//   · Chỉ áp khi lần trả về NẰM SAU mốc vào READY của dòng (đợt mới về sau lần trả về cũ thì không hưởng).
//   · Hằng số trong code (chưa đưa lên trang Checkpoint & Checklist).
// ─────────────────────────────────────────────────────────────────────────────
const TRA_VE_KT_GIA_HAN_PHUT = 60;
const msOf = (v) => { if (!v) return NaN; const t = new Date(v).getTime(); return t; };
// JS: `sla` = số phút (tính từ `tgVao`) theo luật thường; trả số phút đã gia hạn.
function giaHanTraVeKt(sla, tgVao, traVe) {
  const vao = msOf(tgVao); const tv = msOf(traVe);
  if (sla == null || Number.isNaN(vao) || Number.isNaN(tv) || tv < vao) return sla;
  return Math.max(sla, Math.ceil((tv + TRA_VE_KT_GIA_HAN_PHUT * 60000 - vao) / 60000));
}
// SQL: cùng luật trên biểu thức `slaSql` (phút từ `tgVaoCol`), `traVeCol` = mốc trả về KT (có thể NULL).
const giaHanTraVeKtSql = (slaSql, tgVaoCol, traVeCol) => `(CASE WHEN ${traVeCol} IS NOT NULL AND ${tgVaoCol} IS NOT NULL
    AND ${traVeCol} >= ${tgVaoCol} THEN GREATEST(${slaSql}, ceil(EXTRACT(EPOCH FROM (${traVeCol} + interval '${TRA_VE_KT_GIA_HAN_PHUT} minutes' - ${tgVaoCol})) / 60)::int)
    ELSE ${slaSql} END)`;

// ─────────────────────────────────────────────────────────────────────────────
// (6) TEST RUN — XÁC NHẬN LẠI SAU KHI BỊ TRẢ VỀ KẾ HOẠCH (09/10/2026, người dùng chốt): lệnh bị Test Run trả về
//     Kế hoạch rồi Kế hoạch "Xác nhận Release 1" lại (mốc `traVeKeHoach.MOC_XAC_NHAN_LAI_KH_SQL`) thì tối thiểu
//     `toi_thieu_phut` của luật (2) tính LẠI từ lúc xác nhận lại — hạn đỏ = MUỘN HƠN giữa (hạn luật (2), lúc xác
//     nhận lại + tối thiểu). Không có thì lệnh quay về Test Run đỏ NGAY (2 giờ tính từ lúc tạo lệnh đã hết).
//   · Mốc VÀO trạm giữ `created_date` ⇒ dải Theo dõi / "nghẽn từ" / Thời gian trạm không đổi số đo thời gian ở.
//   · Luật (2) tắt hoặc tối thiểu = 0 ⇒ không gia hạn. Chỉ áp khi lần xác nhận lại nằm sau mốc vào.
// ─────────────────────────────────────────────────────────────────────────────
const toiThieuGoc = () => (testBat() ? Math.max(0, Number(cfg.TEST_RUN_THEO_GIO_SX.gia_tri.toi_thieu_phut) || 0) : 0);
// JS: `sla` = phút (tính từ `tgVao`) theo luật (2); trả số phút đã gia hạn.
function giaHanTestRunLai(sla, tgVao, xnLai) {
  const toiThieu = toiThieuGoc();
  const vao = msOf(tgVao); const xn = msOf(xnLai);
  if (!toiThieu || sla == null || Number.isNaN(vao) || Number.isNaN(xn) || xn < vao) return sla;
  return Math.max(sla, Math.ceil((xn + toiThieu * 60000 - vao) / 60000));
}
// SQL: cùng luật trên biểu thức `slaSql`; `xnLaiCol` = mốc xác nhận lại (có thể NULL) — nên là CỘT đã tính sẵn
// (được nhắc 3 lần), đừng truyền subquery thô.
function giaHanTestRunLaiSql(slaSql, tgVaoCol, xnLaiCol) {
  const toiThieu = toiThieuGoc();
  if (!toiThieu) return slaSql;
  return `(CASE WHEN ${xnLaiCol} IS NOT NULL AND ${tgVaoCol} IS NOT NULL AND ${xnLaiCol} >= ${tgVaoCol}
    THEN GREATEST(${slaSql}, ceil(EXTRACT(EPOCH FROM (${xnLaiCol} + interval '${Number(toiThieu)} minutes' - ${tgVaoCol})) / 60)::int)
    ELSE ${slaSql} END)`;
}

module.exports = {
  TRA_VE_KT_GIA_HAN_PHUT, giaHanTraVeKt, giaHanTraVeKtSql, giaHanTestRunLai, giaHanTestRunLaiSql,
  // cấu hình (mig 109)
  MAC_DINH, MA_SLA, chuanHoa, apDung, napCauHinh, batDauNapDinhKy, layCauHinh,
  hanBat, testRunTruocSxPhut, gioSxKhSql,
  mocDoReadySql, slaReadyHanSql, canhBaoReadyHanSql,
  mocDoReady, slaReadyHan,
  slaReadySql, slaQcReadySql, slaTestRunSql, canhBaoTestRunSql, slaReady, slaQcReady, slaTestRun, phutTrongNgayVN,
};
