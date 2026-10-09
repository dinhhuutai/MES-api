'use strict';

// ─── BÁO CÁO SỬA HÀNG (Sản xuất › Báo cáo sửa hàng, 09/10/2026) ───────────────────────────────────
// Hàm THUẦN — dữ liệu thô đọc ở `modules/production/baoCaoSuaHang.js`. Khuôn tờ xưởng "Báo cáo sửa hàng":
//   Dây chuyền (MTD · Bàn in · RB · MT · LG · MEP + Tổng cộng) ×
//   · KẾT QUẢ SỬA            : Tồn đầu · Nhận · Đã sửa · Chưa sửa
//   · KẾT QUẢ KIỂM HÀNG SỬA  : Tồn đầu · Nhận · Đạt · Hủy · Chưa kiểm
//   · TỒN SỬA                : Chưa sửa + Chưa kiểm
//   · NGHẼN                  : Hiện trạng (Phần · SL · Thời gian nghẽn) + Kết quả xử lý (Phần/SL xong · Phần/SL chưa)
//
// ⚠⚠ MES GHI SỬA 1 BƯỚC (người dùng chốt 09/10/2026): màn Sửa nhập luôn "sửa đạt / sửa hủy / hủy thẳng" — không có
//   bước "đã sửa xong, chờ kiểm" riêng ⇒ Đã sửa = đạt + hủy của lượt Sửa · Kiểm hàng sửa: Nhận = Đã sửa, Đạt = sửa đạt,
//   Hủy = sửa hủy (gồm hủy thẳng) · Tồn đầu kiểm + Chưa kiểm LUÔN 0 · Tồn sửa = Chưa sửa. Muốn tách 2 bước thì phải
//   đổi màn Sửa (chưa làm) — khi đó chỉ sửa khối "kiểm" ở đây.
//
// LUẬT (đơn vị = pcs của TEM GỐC; tem 17 chỉ là nhãn của phần sửa đạt, không có hàng chờ sửa):
//   · KỲ = ngày SX: tuNgay 06:00 → denNgay+1 06:00 giờ VN (cùng quy ước Báo cáo kiểm hàng / sản xuất của module).
//   · "Chờ sửa" của 1 tem dựng lại theo dòng thời gian SỰ KIỆN (sổ cái chỉ có số HIỆN TẠI):
//       + phần SỬA của từng lượt KCS có hư (hư − phần hủy của phiếu Phân loại lỗi chia theo lượt —
//         `baoCaoKiemHang.chiaHuyTheoLuot` ⇒ ô "Nhận" khớp cột "SL sửa" của Báo cáo kiểm hàng cùng kỳ)
//       + OQC trả về Sửa (`qc_tra_ve` OQC_SUA; SL = Σ sửa đạt các lượt − `sl_sua_dat` hiện tại, vì trả về chỉ
//         trừ ngược sổ cái, không lưu số)
//       ± hủy / mở lại tem sửa (audit `HUY_TEM_SUA` / `MO_TEM_SUA`, `gia_tri_moi.sl`)
//       − mỗi lượt Sửa chưa hủy xác nhận (đạt + hủy)
//     Còn lệch so với `con_sua` hiện tại (dữ liệu sửa tay / script) ⇒ 1 dòng ĐIỀU CHỈNH ở mốc vào sửa của tem —
//     nhờ đó "Chưa sửa" xem tới hôm nay = ĐÚNG tổng màn Sửa.
//   · Tồn đầu = chờ sửa lúc đầu kỳ · Nhận = mọi phát sinh tăng/giảm trong kỳ trừ lượt Sửa · Đã sửa = lượt Sửa trong kỳ ·
//     Chưa sửa = chờ sửa lúc cuối kỳ ⇒ BẤT BIẾN Tồn đầu + Nhận − Đã sửa = Chưa sửa (từng tem, từng dòng).
//   · Phân loại lỗi được áp NGƯỢC về lúc KCS (như Báo cáo kiểm hàng): ngày cũ chưa phân loại mà nay đã phân loại thì
//     số ngày cũ nhỏ đi đúng phần hủy.
//   · NGHẼN đo trên TEM (gương màn Sửa + bảng theo dõi Dashboard dòng Sửa): vào = `siSoTram.MOC_VAO_TEM.SUA` (KCS đầu có
//     hư), rời = lúc hết hàng chờ sửa, nghẽn từ vào + SLA trạm SUA. CHƯA xử lý = còn ở trạm cuối kỳ và đã quá SLA (đo tới
//     min(cuối kỳ, bây giờ)); ĐÃ xử lý = rời trạm trong kỳ lúc đã quá SLA. "Phần" đếm PHẦN IN (phần in có tem chưa ⇒
//     chưa; còn lại có tem xong ⇒ xong — như bảng theo dõi), "SL chưa" = chờ sửa cuối kỳ của tem chưa, "SL xong" = Đã sửa
//     trong kỳ của tem xong, "Thời gian nghẽn" = Σ giờ vượt SLA (mỗi phần in lấy tem vượt lâu nhất).
//     ⚠ Tem rời Sửa rồi QUAY LẠI (OQC trả về) vẫn đo từ mốc vào ĐẦU — y như màn Sửa (tô đỏ) đang đo.
//   · Dây chuyền = nhóm loại chuyền của chuyền chạy phiếu (`baoCaoSanXuat.nhomCuaLoai`); không rõ ⇒ "Khác".

const { nhomCuaLoai, NHOM } = require('./baoCaoSanXuat');
const { chiaHuyTheoLuot } = require('./baoCaoKiemHang');
const { congNgay } = require('./khoangNgay');

// Nhãn theo đúng tờ xưởng ("Bàn in" — Báo cáo sản xuất/kiểm hàng ghi "Banin").
const NHAN_RIENG = { BANIN: 'Bàn in' };
const DS_NHOM = NHOM.map((n) => ({ key: n.key, label: NHAN_RIENG[n.key] || n.label }));
const NHOM_KHAC = { key: 'KHAC', label: 'Khác' };

const GIO = 3600 * 1000;
const so = (v) => Math.round(Number(v) || 0);
const duong = (v) => Math.max(0, so(v));
const ms = (t) => (t == null || t === '' ? null : (typeof t === 'number' ? t : Date.parse(t)));
const mangJson = (v) => {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch { return []; }
};
// Ngày SX (06:00 → 06:00 giờ VN) của 1 mốc: giờ VN − 6h = UTC + 1h.
const ngaySx = (t) => (t == null ? null : new Date(t + GIO).toISOString().slice(0, 10));
const HUY_THANG_RE = /Hủy thẳng:\s*(\d+)/;
const soTuNhien = (a, b) => String(a || '').localeCompare(String(b || ''), 'vi', { numeric: true, sensitivity: 'base' });

// Mốc kỳ (ms): tuNgay 06:00 VN → denNgay+1 06:00 VN.
const mocKy = (tuNgay, denNgay) => ({
  tu: Date.parse(`${tuNgay}T06:00:00+07:00`),
  den: Date.parse(`${congNgay(denNgay, 1)}T06:00:00+07:00`),
});

// Dòng thời gian "chờ sửa" của 1 tem (thuần) ⇒ [{ t, d, loai, dat?, huy?, luot? }] đã sắp, Σ d = con_sua hiện tại.
function suKienTem(r) {
  const ev = [];
  const kcs = mangJson(r.kcs).map((k) => ({ tg: ms(k.tg), hu: duong(k.hu) })).filter((k) => k.tg != null);
  const coPhanLoai = r.pll_huy != null || r.pll_sua != null;
  const huyLuot = coPhanLoai ? chiaHuyTheoLuot(kcs, r.pll_huy) : kcs.map(() => 0);
  kcs.forEach((k, i) => { const d = k.hu - huyLuot[i]; if (d) ev.push({ t: k.tg, d, loai: 'KCS' }); });

  const sua = mangJson(r.sua).map((s) => ({ ...s, tg: ms(s.tg), dat: duong(s.dat), huy: duong(s.huy) }))
    .filter((s) => s.tg != null);
  sua.forEach((s) => ev.push({ t: s.tg, d: -(s.dat + s.huy), loai: 'SUA', dat: s.dat, huy: s.huy, luot: s }));

  mangJson(r.huy_tem).forEach((a) => {
    const t = ms(a.tg);
    const sl = duong(a.sl);
    if (t == null || !sl) return;
    ev.push({ t, d: a.hd === 'MO_TEM_SUA' ? sl : -sl, loai: 'TEM_SUA' });
  });

  // OQC trả về Sửa: SL không lưu — suy = Σ sửa đạt các lượt − sửa đạt còn trên sổ cái; chia đều các lần trả về.
  const traVe = mangJson(r.tra_ve).map(ms).filter((t) => t != null).sort((a, b) => a - b);
  const slTraVe = Math.max(0, sua.reduce((s, x) => s + x.dat, 0) - duong(r.sl_sua_dat));
  if (traVe.length && slTraVe) {
    const moi = Math.floor(slTraVe / traVe.length);
    traVe.forEach((t, i) => {
      const d = i === traVe.length - 1 ? slTraVe - moi * (traVe.length - 1) : moi;
      if (d) ev.push({ t, d, loai: 'TRA_VE' });
    });
  }

  // Khớp sổ cái hiện tại (màn Sửa): phần lệch ⇒ ĐIỀU CHỈNH ở mốc vào sửa.
  const conNay = Math.max(0, so(r.sl_kcs_sua) - so(r.sl_sua_dat) - so(r.sl_sua_huy));
  const lech = conNay - ev.reduce((s, e) => s + e.d, 0);
  if (lech) {
    const t0 = ms(r.tg_vao) ?? (ev.length ? Math.min(...ev.map((e) => e.t)) : null);
    if (t0 != null) ev.push({ t: t0, d: lech, loai: 'DIEU_CHINH' });
  }
  // Cùng mốc: phát sinh tăng trước, lượt sửa sau (số dư không âm giả).
  ev.sort((a, b) => a.t - b.t || b.d - a.d);
  return { ev, conNay, lech };
}

const rongSo = () => ({
  ton_dau: 0, nhan: 0, da_sua: 0, chua_sua: 0,
  kiem_ton_dau: 0, kiem_nhan: 0, kiem_dat: 0, kiem_huy: 0, chua_kiem: 0, ton_sua: 0,
  ng_sl_xong: 0, ng_sl_chua: 0, so_tem: 0,
});
const COT_CONG = ['ton_dau', 'nhan', 'da_sua', 'chua_sua', 'kiem_ton_dau', 'kiem_nhan', 'kiem_dat', 'kiem_huy',
  'chua_kiem', 'ton_sua', 'ng_sl_xong', 'ng_sl_chua'];

// Gom 1 tập tem ⇒ 1 dòng (cột SL cộng thẳng; cột "Phần" + giờ nghẽn tính theo PHẦN IN của tập).
function gomDong(tems) {
  const x = rongSo();
  const pin = new Map(); // phần in → { chua, xong, gio }
  tems.forEach((t) => {
    COT_CONG.forEach((k) => { x[k] += t[k]; });
    x.so_tem += 1;
    if (!t.nghen) return;
    t._pin.forEach((p) => {
      const o = pin.get(p) || { chua: false, xong: false, gio: 0 };
      if (t.nghen === 'CHUA') o.chua = true; else o.xong = true;
      o.gio = Math.max(o.gio, t.gio_nghen);
      pin.set(p, o);
    });
  });
  let phanChua = 0; let phanXong = 0; let gio = 0;
  pin.forEach((o) => {
    if (o.chua) phanChua += 1; else if (o.xong) phanXong += 1;
    gio += o.gio;
  });
  return {
    ...x,
    ng_phan: phanChua + phanXong, ng_sl: x.ng_sl_xong + x.ng_sl_chua, ng_gio: Math.round(gio * 100) / 100,
    ng_phan_xong: phanXong, ng_phan_chua: phanChua,
  };
}

/**
 * @param {object} p
 * @param {string} p.tuNgay  YYYY-MM-DD
 * @param {string} p.denNgay YYYY-MM-DD
 * @param {number|null} p.slaPhut SLA trạm SUA (phút) của workflow hiện hành; null/0 ⇒ không đo nghẽn
 * @param {number} [p.bayGio] ms (mặc định Date.now())
 * @param {Array} p.rows 1 dòng / TEM GỐC từng có hàng sửa — xem `modules/production/baoCaoSuaHang.js`
 */
function dungBaoCaoSuaHang({ tuNgay, denNgay, slaPhut = null, bayGio = Date.now(), rows = [] }) {
  const { tu, den } = mocKy(tuNgay, denNgay);
  const mocDo = Math.min(den, bayGio);
  const sla = Number(slaPhut) > 0 ? Number(slaPhut) : null;

  const tems = [];
  const luot = [];
  let soTemLech = 0;
  rows.forEach((r) => {
    const { ev, conNay, lech } = suKienTem(r);
    const t = {
      tem_id: r.tem_id, ma_tem: r.ma_tem, ma_lenh_san_xuat: r.ma_lenh_san_xuat || null,
      ma_chuyen: r.ma_chuyen || null, ten_chuyen: r.ten_chuyen || null, nhom: nhomCuaLoai(r.ma_loai_chuyen),
      ma_phan: r.ma_phan || null, khach: r.khach || null, po: r.po || null, ma_hang: r.ma_hang || null,
      mau_vai: r.mau_vai || null,
      ...rongSo(), nhan_kcs: 0, nhan_tra_ve: 0, nhan_khac: 0, huy_thang: 0, so_luot_sua: 0, con_hien_tai: conNay,
    };
    ev.forEach((e) => {
      if (e.t < tu) { t.ton_dau += e.d; return; }
      if (e.t >= den) return;
      if (e.loai === 'SUA') {
        t.da_sua += e.dat + e.huy;
        t.kiem_dat += e.dat;
        t.kiem_huy += e.huy;
        t.so_luot_sua += 1;
        const ht = Number((HUY_THANG_RE.exec(e.luot.ghi_chu || '') || [])[1]) || 0;
        t.huy_thang += ht;
        luot.push({
          id: e.luot.id, tem_id: r.tem_id, tg: new Date(e.t).toISOString(), ngay_sx: ngaySx(e.t),
          dat: e.dat, huy: e.huy, huy_thang: ht, nguoi_sua: e.luot.nguoi_sua || null,
          nguoi_xac_nhan: e.luot.nguoi || null, ghi_chu: e.luot.ghi_chu || null,
        });
        return;
      }
      t.nhan += e.d;
      if (e.loai === 'KCS') t.nhan_kcs += e.d;
      else if (e.loai === 'TRA_VE') t.nhan_tra_ve += e.d;
      else t.nhan_khac += e.d;
    });
    t.chua_sua = t.ton_dau + t.nhan - t.da_sua;
    // MES ghi sửa 1 bước ⇒ hàng đã sửa = đã kiểm (xem đầu file).
    t.kiem_nhan = t.da_sua;
    t.ton_sua = t.chua_sua + t.chua_kiem;

    // Nghẽn — đồng hồ từ mốc vào sửa ĐẦU của tem (như màn Sửa). Còn ở trạm cuối kỳ ⇔ còn chờ sửa cuối kỳ;
    // rời trạm trong kỳ = lần giảm cuối cùng TRONG kỳ đưa chờ sửa về 0.
    const vao = ms(r.tg_vao) ?? (ev.length ? ev[0].t : null);
    const bd = sla != null && vao != null ? vao + sla * 60000 : null;
    const giam = ev.filter((e) => e.d < 0);
    const raCuoi = conNay > 0 || !giam.length ? null : giam[giam.length - 1].t;
    const raKy = t.chua_sua > 0 ? null : (giam.filter((e) => e.t >= tu && e.t < den).pop() || {}).t ?? null;
    t.tg_vao = vao != null ? new Date(vao).toISOString() : null;
    t.tg_ra = raCuoi != null ? new Date(Math.max(raCuoi, vao ?? raCuoi)).toISOString() : null;
    t.tg_bat_dau_nghen = bd != null ? new Date(bd).toISOString() : null;
    t.nghen = null; t.gio_nghen = 0;
    if (bd != null && vao < den) {
      if (t.chua_sua > 0) {
        if (mocDo > bd) { t.nghen = 'CHUA'; t.gio_nghen = (mocDo - bd) / GIO; t.ng_sl_chua = t.chua_sua; }
      } else if (raKy != null && raKy > bd) {
        t.nghen = 'XONG'; t.gio_nghen = (raKy - bd) / GIO; t.ng_sl_xong = t.da_sua;
      }
    }
    t.gio_nghen = Math.round(t.gio_nghen * 100) / 100;
    const pins = Array.isArray(r.phan_in_ids) ? r.phan_in_ids.filter(Boolean).map(String) : [];
    t._pin = pins.length ? pins : [`tem:${r.tem_id}`];

    const coSo = t.ton_dau || t.nhan || t.da_sua || t.chua_sua || t.nghen;
    if (!coSo) return;
    if (lech) soTemLech += 1;
    tems.push(t);
  });

  // Gom dây chuyền → chuyền. Đủ 6 dây chuyền của tờ xưởng (kể cả dòng trống) + "Khác" khi có số.
  const theoNhom = new Map();
  tems.forEach((t) => {
    if (!theoNhom.has(t.nhom)) theoNhom.set(t.nhom, []);
    theoNhom.get(t.nhom).push(t);
  });
  const dsNhom = [...DS_NHOM, ...(theoNhom.has('KHAC') ? [NHOM_KHAC] : [])];
  const theoDayChuyen = dsNhom.map((n) => {
    const ds = theoNhom.get(n.key) || [];
    const theoChuyen = new Map();
    ds.forEach((t) => {
      const k = t.ma_chuyen || '—';
      if (!theoChuyen.has(k)) theoChuyen.set(k, { ma_chuyen: t.ma_chuyen, ten_chuyen: t.ten_chuyen, tems: [] });
      theoChuyen.get(k).tems.push(t);
    });
    return {
      nhom: n.key, ten: n.label, ...gomDong(ds),
      chuyen: [...theoChuyen.values()].sort((a, b) => soTuNhien(a.ma_chuyen, b.ma_chuyen))
        .map((c) => ({ ma_chuyen: c.ma_chuyen, ten_chuyen: c.ten_chuyen, ...gomDong(c.tems) })),
    };
  });

  const tenNhom = Object.fromEntries(dsNhom.map((n) => [n.key, n.label]));
  const temTheoId = new Map(tems.map((t) => [String(t.tem_id), t]));
  const chiTietLuot = luot.filter((l) => temTheoId.has(String(l.tem_id))).map((l) => {
    const t = temTheoId.get(String(l.tem_id));
    return {
      ...l, ma_tem: t.ma_tem, ma_chuyen: t.ma_chuyen, nhom: t.nhom, ten_nhom: tenNhom[t.nhom] || t.nhom,
      ma_lenh_san_xuat: t.ma_lenh_san_xuat, ma_phan: t.ma_phan, khach: t.khach, po: t.po, ma_hang: t.ma_hang, mau_vai: t.mau_vai,
    };
  }).sort((a, b) => Date.parse(b.tg) - Date.parse(a.tg));

  return {
    tu_ngay: tuNgay,
    den_ngay: denNgay,
    sla_phut: sla,
    moc_do: new Date(mocDo).toISOString(),
    so_tem_lech: soTemLech,
    tong: gomDong(tems),
    theo_day_chuyen: theoDayChuyen,
    chi_tiet: tems.map(({ _pin, ...t }) => ({ ...t, ten_nhom: tenNhom[t.nhom] || t.nhom }))
      .sort((a, b) => (b.chua_sua - a.chua_sua) || soTuNhien(a.ma_chuyen, b.ma_chuyen) || soTuNhien(a.ma_tem, b.ma_tem)),
    chi_tiet_luot: chiTietLuot,
  };
}

module.exports = { dungBaoCaoSuaHang, suKienTem, mocKy };
