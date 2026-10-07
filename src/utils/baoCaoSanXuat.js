'use strict';

// ─── BÁO CÁO SẢN XUẤT NGÀY (Sản xuất › Báo cáo sản xuất, 02/10/2026) ─────────────────────────────
// Hàm THUẦN — dữ liệu thô lấy ở `modules/production/baoCaoSanXuat.js`. Dựng 2 bảng từ CÙNG một lượt dữ
// liệu (FE bật/tắt bảng không phải gọi lại API):
//   · Bảng 1 `theo_nhom`: nhóm chuyền (MTD · Banin · RB · MT · LG · MEP) cả xưởng — không tách tổ (07/10/2026).
//   · Bảng 2 `chi_tiet` : 1 dòng / (chuyền × phần in).
// Mỗi ô = 5 cột-nhóm Tổng · HC · CA1 · CA2 · CA3, mỗi cột-nhóm 4 số: kh (SL kế hoạch) · tt (SL in thực
// tế) · gk (số giờ KH) · gt (số giờ TT). FE tự tính % = tt/kh và C.lệch giờ = gt − gk.
//
// LUẬT (người dùng chốt 02/10/2026):
//   · Chỉ hàng ĐANG / ĐÃ IN trong ngày: phiếu chạy (≠ HUY) có giờ chạy cắt vào ngày, hoặc có tem ngày ca đó.
//     Lệnh có kế hoạch mà chưa chạy KHÔNG lên báo cáo. Chuyền gia công bị loại (không in ở xưởng).
//   · NGÀY D = các ca BẮT ĐẦU trong ngày D: 06:00 D → 06:00 D+1 (ca đêm C3/D2 qua nửa đêm vẫn thuộc D —
//     đúng quy ước mã ngày ca của tem). Chia ca theo loại ca của tuần ISO (`cai_dat_ca_tuan`, `utils/ca.js`):
//     NGAN CA1 06–14 · CA2 14–22 · CA3 22–06 · DAI CA1 06–18 · CA2 18–06 · HANH_CHINH cả ngày = HC.
//     Tuần chưa cài ⇒ suy từ mã ca trên tem trong ngày (`suyLoaiCaTuTem`), không có tem ⇒ NGAN.
//   · SL in TT = Σ `tem.so_luong` (tem 15 sống, không tính tem con 17) có `ngay_ca` = D, ca theo HẬU TỐ mã
//     ngày ca người in đã chọn (HC · C1/D1 · C2/D2 · C3); thiếu mã ⇒ suy từ giờ in tem.
//   · Số giờ TT = GIỜ CHẠY PHIẾU trong ngày, cắt theo từng ca — ⚠⚠ CHẶN BẰNG BẰNG CHỨNG IN TRONG NGÀY:
//       đầu  = sớm hơn của (Xác nhận chạy nếu rơi trong ngày) và "Từ giờ" tem đầu tiên trong ngày;
//       cuối = muộn hơn của (Chạy hoàn tất nếu rơi trong ngày) và "Đến giờ" tem cuối cùng trong ngày;
//       phiếu bắt đầu trong ngày, đang chạy, chưa in tem ⇒ tới bây giờ (tối đa hết ngày).
//     Lý do (đo prod 02/10/2026): ~40 phiếu TREO `DANG_CHAY` từ tháng 8–9 (không ai bấm Chạy hoàn tất, có
//     chuyền treo >10 phiếu cùng lúc) — tính thô "bắt đầu → bây giờ" là mỗi phiếu treo 24 giờ/ngày, mãi mãi.
//     Phiếu treo không in gì trong ngày ⇒ KHÔNG lên báo cáo ngày đó.
//   · SL KH / Số giờ KH = khoảng kế hoạch của lệnh (`tg_bd_kh` → `tg_kt_kh`) cắt theo ca của ngày D; SL chia
//     theo tỷ lệ giờ (kế hoạch nhiều ngày ⇒ ngày D chỉ nhận phần của D). Lệnh không có giờ KH mà ngày SX KH = D
//     ⇒ trọn SL vào ca chạy nhiều giờ nhất, giờ KH = 0.
//   · Lệnh nhiều phần in (gom set cũ): giờ chia ĐỀU cho các phần in; SL KH theo `lenh_sx_dot_vai` của từng
//     phần in; tem SX không lưu đợt vải ⇒ quy về phần in đầu (giới hạn đã biết, DATABASE.md §4).
//   · Kế hoạch của lệnh tính cho PHIẾU chạy nhiều giờ nhất trong ngày (lệnh đổi tổ giữa ngày không đếm đôi).

const { caFromHour, khoaTuanIso } = require('./ca');

const CA = ['HC', 'CA1', 'CA2', 'CA3'];
const NHOM = [
  { key: 'MTD', label: 'MTD' },
  { key: 'BANIN', label: 'Banin' },
  { key: 'RB', label: 'RB' },
  { key: 'MT', label: 'MT' },
  { key: 'LG', label: 'LG' },
  { key: 'MEP', label: 'MEP' },
];
const NHOM_KHAC = { key: 'KHAC', label: 'Khác' };
// Loại chuyền → nhóm. `MT` nhận cả mã ngắn phòng khi loại máy tròn được thêm tay với mã 'MT'.
const NHOM_THEO_LOAI = { MAY: 'MTD', BAN: 'BANIN', ROBOT: 'RB', MAY_TRON: 'MT', MT: 'MT', LOGO: 'LG', EP: 'MEP' };
const nhomCuaLoai = (maLoai) => NHOM_THEO_LOAI[String(maLoai || '').toUpperCase()] || 'KHAC';

const GIO = 3600 * 1000;
const VN_LECH = 7 * GIO; // giờ VN = UTC+7, không có giờ mùa hè

// Khung ca của ngày D (mốc ms tuyệt đối). D bắt đầu 06:00 giờ VN.
function khungCa(ngay, loaiCa) {
  const [y, m, d] = String(ngay).split('-').map(Number);
  const ws = Date.UTC(y, m - 1, d, 6) - VN_LECH;
  if (loaiCa === 'HANH_CHINH') return [{ ca: 'HC', a: ws, b: ws + 24 * GIO }];
  if (loaiCa === 'DAI') return [{ ca: 'CA1', a: ws, b: ws + 12 * GIO }, { ca: 'CA2', a: ws + 12 * GIO, b: ws + 24 * GIO }];
  return [
    { ca: 'CA1', a: ws, b: ws + 8 * GIO },
    { ca: 'CA2', a: ws + 8 * GIO, b: ws + 16 * GIO },
    { ca: 'CA3', a: ws + 16 * GIO, b: ws + 24 * GIO },
  ];
}

// `khoaTuanIso` (tuần ISO → khóa `nam-tuan` của `cai_dat_ca_tuan`) nay ở `utils/ca.js`, export lại bên dưới.

const chongLan = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const ms = (v) => (v == null ? null : new Date(v).getTime());

// Ca của tem: hậu tố mã ngày ca người in đã chọn; thiếu ⇒ suy từ giờ in tem theo loại ca của tuần.
function caCuaTem(hint, gio, loaiCa) {
  const h = String(hint || '').toUpperCase();
  if (h === 'HC' || h === 'TC') return 'HC';
  if (h === 'C1' || h === 'D1') return 'CA1';
  if (h === 'C2' || h === 'D2') return 'CA2';
  if (h === 'C3') return 'CA3';
  const nhan = caFromHour(gio, 0, loaiCa);
  if (nhan.startsWith('Hành chính')) return 'HC';
  return { 'Ca 1': 'CA1', 'Ca 2': 'CA2', 'Ca 3': 'CA3' }[nhan] || 'CA1';
}

// Tuần CHƯA cài loại ca (`cai_dat_ca_tuan` thiếu dòng) ⇒ suy từ mã ca người in đã chọn trên tem trong ngày
// (D1/D2 ⇒ DAI · HC ⇒ HANH_CHINH · C1/C2/C3 ⇒ NGAN, theo SỐ LƯỢT tem nhiều nhất). Không có tem ⇒ null.
// Ca thật 01/10/2026: tuần 40 chưa cài mà tem đều mang `D1` — chia ca NGAN sẽ lệch giờ với SL theo ca.
// `t.n` (tùy chọn) = trọng số của phần tử (dòng đã GROUP BY sẵn số tem — Báo cáo dừng chuyền); thiếu = 1.
function suyLoaiCaTuTem(tems = []) {
  const dem = { DAI: 0, HANH_CHINH: 0, NGAN: 0 };
  tems.forEach((t) => {
    const h = String(t.ca_hint || '').toUpperCase();
    const w = Number(t.n) > 0 ? Number(t.n) : 1;
    if (h === 'D1' || h === 'D2') dem.DAI += w;
    else if (h === 'HC' || h === 'TC') dem.HANH_CHINH += w;
    else if (/^C[123]$/.test(h)) dem.NGAN += w;
  });
  const [ten, so] = Object.entries(dem).sort((a, b) => b[1] - a[1])[0];
  return so > 0 ? ten : null;
}

const oRong = () => ({ kh: 0, tt: 0, gk: 0, gt: 0 });
const boRong = () => Object.fromEntries(CA.map((c) => [c, oRong()]));
function congBo(dich, nguon) {
  CA.forEach((c) => { ['kh', 'tt', 'gk', 'gt'].forEach((k) => { dich[c][k] += nguon[c][k]; }); });
}
const lam = (v, n = 4) => Math.round(v * 10 ** n) / 10 ** n;
// Bộ số gửi FE: thêm cột TONG = Σ các ca; làm tròn để gọn payload.
function xuatBo(bo) {
  const out = {};
  const tong = oRong();
  CA.forEach((c) => {
    const o = bo[c];
    out[c] = { kh: lam(o.kh, 2), tt: o.tt, gk: lam(o.gk), gt: lam(o.gt) };
    ['kh', 'tt', 'gk', 'gt'].forEach((k) => { tong[k] += o[k]; });
  });
  out.TONG = { kh: lam(tong.kh, 2), tt: tong.tt, gk: lam(tong.gk), gt: lam(tong.gt) };
  return out;
}
const coSo = (bo) => CA.some((c) => bo[c].kh || bo[c].tt || bo[c].gk || bo[c].gt);

// So mã tự nhiên: C2 < C10, M5 < M10A.
const soTuNhien = (a, b) => String(a || '').localeCompare(String(b || ''), 'vi', { numeric: true, sensitivity: 'base' });

// `loaiCa`: chuỗi (cả xưởng 1 loại ca) HOẶC hàm `(maLoaiChuyen) → loại ca` (mig 112 — tuần cài ca riêng cho
//   Máy/Bàn/Robot). Mỗi phiếu chia ca theo loại ca của CHUYỀN chạy phiếu đó. Ngày D luôn 06:00 → 06:00 với mọi
//   loại ca nên khung ngày (W0/W1) không đổi.
function dungBaoCaoSanXuat({
  ngay, loaiCa = 'NGAN', bayGio = Date.now(), phieus = [], tems = [], lenhs = [], pins = [], chuyens = [], tos = [],
}) {
  const loaiCaCuaLoai = typeof loaiCa === 'function' ? loaiCa : () => loaiCa;
  const khung = khungCa(ngay, loaiCaCuaLoai(null));
  const lenhById = new Map(lenhs.map((l) => [String(l.id), l]));
  const chuyenById = new Map(chuyens.map((c) => [String(c.id), c]));
  const toById = new Map(tos.map((t) => [String(t.id), t]));
  const loaiCaPhieu = (p) => loaiCaCuaLoai((chuyenById.get(String(p.chuyen_id)) || {}).ma_loai || null);
  const khungTheoLoai = new Map();
  const khungPhieu = (p) => {
    const lca = loaiCaPhieu(p);
    if (!khungTheoLoai.has(lca)) khungTheoLoai.set(lca, khungCa(ngay, lca));
    return khungTheoLoai.get(lca);
  };

  // Phần in của từng lệnh (sắp theo code phần ⇒ "phần in đầu" ổn định) + đợt vải → phần in.
  const pinsTheoLenh = new Map();
  pins.forEach((p) => {
    const k = String(p.lenh_id);
    if (!pinsTheoLenh.has(k)) pinsTheoLenh.set(k, []);
    pinsTheoLenh.get(k).push(p);
  });
  pinsTheoLenh.forEach((ds) => ds.sort((a, b) => soTuNhien(a.ma_phan, b.ma_phan)));
  const dsPin = (lenhId) => {
    const ds = pinsTheoLenh.get(String(lenhId));
    return ds && ds.length ? ds : [{ lenh_id: lenhId, phan_in_id: null, ma_phan: null, sl: 0, dot_ids: [] }];
  };

  // Đơn vị cộng dồn = (phiếu × phần in).
  const donVi = new Map();
  const dv = (phieu, pin) => {
    const k = `${phieu.id}|${pin.phan_in_id}`;
    if (!donVi.has(k)) donVi.set(k, { phieu, pin, bo: boRong() });
    return donVi.get(k);
  };

  // 1. Giờ chạy phiếu trong ngày (chặn bằng tem — xem đầu file), cắt theo ca, chia đều cho phần in của lệnh.
  const W0 = khung[0].a;
  const W1 = khung[khung.length - 1].b;
  const trongNgay = (x) => x != null && x >= W0 && x < W1;
  const temPhieu = new Map(); // phiếu → { tu: sớm nhất, den: muộn nhất } của tem trong ngày
  tems.forEach((t) => {
    const k = String(t.phieu_id);
    const tu = ms(t.tu_min);
    const den = ms(t.den_max);
    const cu = temPhieu.get(k) || { tu: null, den: null };
    if (tu != null) cu.tu = cu.tu == null ? tu : Math.min(cu.tu, tu);
    if (den != null) cu.den = cu.den == null ? den : Math.max(cu.den, den);
    temPhieu.set(k, cu);
  });
  const khoangChay = (p) => {
    const bd = ms(p.tg_bd);
    const kt = ms(p.tg_kt);
    const tm = temPhieu.get(String(p.id));
    let a = trongNgay(bd) ? bd : null;
    let b = trongNgay(kt) ? kt : null;
    if (tm && tm.tu != null) a = a == null ? tm.tu : Math.min(a, tm.tu);
    if (tm && tm.den != null) b = b == null ? tm.den : Math.max(b, tm.den);
    if (b == null && trongNgay(bd) && kt == null) b = Math.min(bayGio, W1); // mới chạy trong ngày, chưa in tem
    if (a == null || b == null) return null;
    a = Math.max(a, W0);
    b = Math.min(b, W1);
    return b > a ? [a, b] : null;
  };
  const gioPhieu = new Map(); // phiếu → tổng giờ trong ngày (chọn phiếu "chính" của lệnh)
  const phieuTheoLenh = new Map();
  phieus.forEach((p) => {
    const k = String(p.lenh_id);
    if (!phieuTheoLenh.has(k)) phieuTheoLenh.set(k, []);
    phieuTheoLenh.get(k).push(p);
    const kc = khoangChay(p);
    const ds = dsPin(p.lenh_id);
    let tong = 0;
    if (kc) {
      const [a, b] = kc;
      khungPhieu(p).forEach((w) => {
        const h = chongLan(a, b, w.a, w.b) / GIO;
        if (!h) return;
        tong += h;
        ds.forEach((pin) => { dv(p, pin).bo[w.ca].gt += h / ds.length; });
      });
    }
    gioPhieu.set(String(p.id), tong);
    ds.forEach((pin) => dv(p, pin)); // phiếu chỉ có tem (giờ chạy ngoài ngày) vẫn có dòng
  });

  // 2. SL in thực tế từ tem.
  const phieuById = new Map(phieus.map((p) => [String(p.id), p]));
  tems.forEach((t) => {
    const p = phieuById.get(String(t.phieu_id));
    if (!p) return;
    const ds = dsPin(p.lenh_id);
    const pin = (t.dot_vai_ve_id && ds.find((x) => (x.dot_ids || []).map(String).includes(String(t.dot_vai_ve_id)))) || ds[0];
    dv(p, pin).bo[caCuaTem(t.ca_hint, t.gio, loaiCaPhieu(p))].tt += Number(t.so_luong) || 0;
  });

  // 3. Kế hoạch của lệnh → phiếu chạy nhiều giờ nhất trong ngày.
  phieuTheoLenh.forEach((dsPhieu, lenhId) => {
    const l = lenhById.get(lenhId);
    if (!l) return;
    const chinh = [...dsPhieu].sort((x, y) => (gioPhieu.get(String(y.id)) - gioPhieu.get(String(x.id)))
      || (ms(y.tg_bd) - ms(x.tg_bd)))[0];
    const ds = dsPin(lenhId);
    const slPin = (pin) => (Number(pin.sl) || (ds.length === 1 ? Number(l.so_luong_release) || 0 : 0));
    const a = ms(l.tg_bd_kh);
    const b = ms(l.tg_kt_kh);
    if (a != null && b != null && b > a) {
      khungPhieu(chinh).forEach((w) => {
        const ov = chongLan(a, b, w.a, w.b);
        if (!ov) return;
        ds.forEach((pin) => {
          const o = dv(chinh, pin).bo[w.ca];
          o.kh += slPin(pin) * (ov / (b - a));
          o.gk += ov / GIO / ds.length;
        });
      });
    } else if (l.ngay_kh === ngay) {
      // Không có giờ KH: trọn SL vào ca chạy nhiều giờ nhất của phiếu chính (không có giờ chạy ⇒ ca đầu).
      const bo = dv(chinh, ds[0]).bo;
      const caChon = khungPhieu(chinh).map((w) => w.ca).sort((x, y) => bo[y].gt - bo[x].gt)[0];
      ds.forEach((pin) => { dv(chinh, pin).bo[caChon].kh += slPin(pin); });
    }
  });

  // 4. Bảng 2 — gom (chuyền × phần in).
  const dong2 = new Map();
  donVi.forEach(({ phieu, pin, bo }) => {
    const k = `${phieu.chuyen_id}|${pin.phan_in_id}`;
    if (!dong2.has(k)) {
      const c = chuyenById.get(String(phieu.chuyen_id)) || {};
      dong2.set(k, {
        ma_chuyen: c.ma_chuyen || '—', ten_chuyen: c.ten_chuyen || null, nhom: nhomCuaLoai(c.ma_loai),
        ma_phan: pin.ma_phan, khach: pin.ten_khach_hang || null, po: pin.ma_don_hang || null,
        ma_hang: pin.ma_hang || null, mau_vai: pin.mau_vai || null, kich_vai: pin.kich_vai || null,
        kich_phim: pin.kich_phim || null, to: new Set(), bo: boRong(),
      });
    }
    const r = dong2.get(k);
    congBo(r.bo, bo);
    const t = toById.get(String(phieu.to_in_id));
    if (t) r.to.add(t.ma_to);
  });
  const chiTiet = [...dong2.values()].filter((r) => coSo(r.bo))
    .sort((x, y) => soTuNhien(x.ma_chuyen, y.ma_chuyen) || soTuNhien(x.khach, y.khach)
      || soTuNhien(x.po, y.po) || soTuNhien(x.ma_phan, y.ma_phan))
    .map((r) => ({ ...r, to: [...r.to].sort(soTuNhien).join(', ') || null, m: xuatBo(r.bo), bo: undefined }));

  // 5. Bảng 1 — gom theo nhóm chuyền cho cả xưởng (07/10/2026 người dùng bỏ cột Tổ — trước đó tổ × nhóm).
  const theoNhom = new Map();
  const tongCong = boRong();
  donVi.forEach(({ phieu, bo }) => {
    const c = chuyenById.get(String(phieu.chuyen_id)) || {};
    const n = nhomCuaLoai(c.ma_loai);
    if (!theoNhom.has(n)) theoNhom.set(n, boRong());
    congBo(theoNhom.get(n), bo);
    congBo(tongCong, bo);
  });
  const dsNhom = [...NHOM, ...(theoNhom.has('KHAC') && coSo(theoNhom.get('KHAC')) ? [NHOM_KHAC] : [])];
  const bang1 = dsNhom.map((n) => ({ key: n.key, label: n.label, m: xuatBo(theoNhom.get(n.key) || boRong()) }));

  // `loai_ca` = loại ca CHUNG; `loai_ca_rieng` = loại chuyền cài khác chung (mig 112) để FE ghi rõ.
  const chung = loaiCaCuaLoai(null);
  const rieng = {};
  ['MAY', 'BAN', 'ROBOT'].forEach((lc) => { const v = loaiCaCuaLoai(lc); if (v !== chung) rieng[lc] = v; });
  return {
    ngay, loai_ca: chung, loai_ca_rieng: rieng, ca: CA,
    theo_nhom: bang1, tong: xuatBo(tongCong), chi_tiet: chiTiet,
  };
}

module.exports = { dungBaoCaoSanXuat, khungCa, khoaTuanIso, caCuaTem, nhomCuaLoai, suyLoaiCaTuTem, CA, NHOM };
