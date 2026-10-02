'use strict';

// ─── BÁO CÁO KẾT QUẢ KIỂM HÀNG (Sản xuất › Báo cáo kiểm hàng, 02/10/2026) ──────────────────────────
// Hàm THUẦN — dữ liệu thô đọc ở `modules/production/baoCaoKiemHang.js`. Khuôn tờ Excel xưởng đang dùng
// "KẾT QUẢ KIỂM TRA CLSP THEO DÂY CHUYỀN": Dây chuyền · SL kiểm · SL đạt · %Đạt · SL sửa · %Sửa · SL hủy ·
// %Hủy · %K.đạt (= (sửa + hủy) / kiểm). Đo trên tờ mẫu: SL kiểm = đạt + sửa + hủy ở MỌI dòng.
//
// LUẬT:
//   · Nguồn = từng LƯỢT KCS (`kcs`) chưa bị hủy xác nhận, tem chưa HUY. NGÀY = ngày SX của lúc nhập lượt
//     kiểm: 06:00 D → 06:00 D+1 (cùng quy ước Báo cáo sản xuất / Báo cáo dừng chuyền của module).
//   · SL kiểm của lượt = đạt + hư + hủy ghi thẳng tại KCS (`so_luong_huy` — chỉ dữ liệu cũ trước khi có
//     Phân loại lỗi). Mẫu (`so_luong_mau`) không vào công thức (y như cân đối KCS).
//   · HƯ chia SỬA / HỦY theo phiếu PHÂN LOẠI LỖI của tem (số chính thức — §6.5). Tem chưa phân loại ⇒ toàn bộ
//     hư là SỬA (đúng sổ cái: KCS dồn hết hư vào `sl_kcs_sua`). Phân loại hủy nhiều hơn tổng hư của tem ⇒ kẹp.
//   · Tem kiểm NHIỀU LƯỢT: phần hủy của tem chia cho các lượt theo tỷ lệ hư của từng lượt (làm tròn xuống),
//     phần lẻ dồn vào lượt CUỐI ⇒ Σ các lượt = đúng số của tem, kỳ nào chứa lượt nào thì nhận đúng phần đó.
//   · Dây chuyền = nhóm loại chuyền của chuyền chạy phiếu (MTD · Banin · RB · MT · LG · MEP — `nhomCuaLoai`
//     của Báo cáo sản xuất); không rõ loại ⇒ "Khác".

const { nhomCuaLoai, NHOM } = require('./baoCaoSanXuat');

const NHAN_NHOM = Object.fromEntries([...NHOM, { key: 'KHAC', label: 'Khác' }].map((n) => [n.key, n.label]));
const so = (v) => Math.max(0, Math.round(Number(v) || 0));
const tyLe = (tu, mau) => (mau > 0 ? tu / mau : null);

// Chia phần hủy của tem cho các lượt hư (thuần, có thể test riêng).
//   luot: [{ hu, tg }] cùng 1 tem · huyTem: số hủy đã phân loại · ⇒ mảng số hủy theo đúng thứ tự `luot`.
function chiaHuyTheoLuot(luot, huyTem) {
  const tongHu = luot.reduce((s, l) => s + so(l.hu), 0);
  const huy = Math.min(so(huyTem), tongHu);
  const kq = luot.map(() => 0);
  if (!huy || !tongHu) return kq;
  // Lượt cuối (muộn nhất) có hư nhận phần lẻ.
  const thuTu = luot.map((l, i) => i).filter((i) => so(luot[i].hu) > 0)
    .sort((a, b) => new Date(luot[a].tg) - new Date(luot[b].tg));
  let daChia = 0;
  thuTu.forEach((i, k) => {
    if (k === thuTu.length - 1) { kq[i] = huy - daChia; return; }
    kq[i] = Math.floor((so(luot[i].hu) * huy) / tongHu);
    daChia += kq[i];
  });
  return kq;
}

const tongRong = () => ({ sl_kiem: 0, sl_dat: 0, sl_sua: 0, sl_huy: 0, so_luot: 0, so_tem: 0 });
function chot(t) {
  return {
    ...t,
    ty_le_dat: tyLe(t.sl_dat, t.sl_kiem),
    ty_le_sua: tyLe(t.sl_sua, t.sl_kiem),
    ty_le_huy: tyLe(t.sl_huy, t.sl_kiem),
    ty_le_khong_dat: tyLe(t.sl_sua + t.sl_huy, t.sl_kiem),
  };
}
const cong = (a, l) => {
  a.sl_kiem += l.sl_kiem; a.sl_dat += l.sl_dat; a.sl_sua += l.sl_sua; a.sl_huy += l.sl_huy; a.so_luot += 1;
};

/**
 * @param {object} p
 * @param {string} p.tuNgay  YYYY-MM-DD
 * @param {string} p.denNgay YYYY-MM-DD
 * @param {Array}  p.rows    MỌI lượt KCS (chưa hủy) của các tem có lượt trong kỳ — kể cả lượt NGOÀI kỳ (để chia
 *                           hủy đúng theo tem), cờ `trong_ky` đánh dấu lượt thuộc kỳ.
 */
function dungBaoCaoKiemHang({ tuNgay, denNgay, rows = [] }) {
  // 1. Chia sửa/hủy theo tem.
  const theoTem = new Map();
  rows.forEach((r) => {
    const k = String(r.tem_id);
    if (!theoTem.has(k)) theoTem.set(k, []);
    theoTem.get(k).push(r);
  });
  const luot = [];
  theoTem.forEach((ds) => {
    const coPhanLoai = ds[0].pll_huy != null || ds[0].pll_sua != null;
    const huyTheoLuot = coPhanLoai
      ? chiaHuyTheoLuot(ds.map((r) => ({ hu: r.so_luong_loi, tg: r.tg_kiem })), ds[0].pll_huy)
      : ds.map(() => 0);
    ds.forEach((r, i) => {
      if (!r.trong_ky) return;
      const hu = so(r.so_luong_loi);
      const huyTaiKcs = so(r.so_luong_huy);
      const huyPl = huyTheoLuot[i];
      const l = {
        id: r.id, tem_id: r.tem_id, ma_tem: r.ma_tem, tg_kiem: r.tg_kiem, ngay_sx: r.ngay_sx,
        ma_chuyen: r.ma_chuyen || null, ten_chuyen: r.ten_chuyen || null,
        nhom: nhomCuaLoai(r.ma_loai_chuyen), ma_lenh_san_xuat: r.ma_lenh_san_xuat || null,
        ma_phan: r.ma_phan || null, khach: r.khach || null, po: r.po || null, ma_hang: r.ma_hang || null, mau_vai: r.mau_vai || null,
        nguoi_kiem: r.nguoi_kiem || null,
        sl_dat: so(r.so_luong_dat), sl_hu: hu,
        sl_sua: hu - huyPl, sl_huy: huyPl + huyTaiKcs,
        chua_phan_loai: hu > 0 && !coPhanLoai,
      };
      l.sl_kiem = l.sl_dat + l.sl_sua + l.sl_huy;
      luot.push(l);
    });
  });
  luot.sort((a, b) => new Date(b.tg_kiem) - new Date(a.tg_kiem));

  // 2. Gom dây chuyền → chuyền.
  const nhom = new Map();
  const tong = tongRong();
  const temTong = new Set();
  luot.forEach((l) => {
    if (!nhom.has(l.nhom)) nhom.set(l.nhom, { ...tongRong(), chuyen: new Map(), tem: new Set() });
    const n = nhom.get(l.nhom);
    cong(n, l); n.tem.add(l.tem_id);
    const kc = l.ma_chuyen || '—';
    if (!n.chuyen.has(kc)) n.chuyen.set(kc, { ...tongRong(), ma_chuyen: l.ma_chuyen, ten_chuyen: l.ten_chuyen, tem: new Set() });
    const c = n.chuyen.get(kc);
    cong(c, l); c.tem.add(l.tem_id);
    cong(tong, l); temTong.add(l.tem_id);
  });
  // Thứ tự như tờ Excel xưởng: % không đạt TĂNG dần (dây chuyền tốt lên trước), hòa thì theo tên.
  const xepKhongDat = (a, b) => (a.ty_le_khong_dat ?? 0) - (b.ty_le_khong_dat ?? 0)
    || String(a.ten || a.ma_chuyen || '').localeCompare(String(b.ten || b.ma_chuyen || ''), 'vi', { numeric: true });
  const theoDayChuyen = [...nhom.entries()].map(([key, n]) => {
    const { chuyen, tem, ...con } = n;
    return {
      ...chot({ ...con, so_tem: tem.size }),
      nhom: key,
      ten: NHAN_NHOM[key] || key,
      chuyen: [...chuyen.values()].map(({ tem: t, ...c }) => chot({ ...c, so_tem: t.size })).sort(xepKhongDat),
    };
  }).sort(xepKhongDat);

  return {
    tu_ngay: tuNgay,
    den_ngay: denNgay,
    tong: chot({ ...tong, so_tem: temTong.size }),
    chua_phan_loai: luot.filter((l) => l.chua_phan_loai).length,
    theo_day_chuyen: theoDayChuyen,
    chi_tiet: luot,
  };
}

module.exports = { dungBaoCaoKiemHang, chiaHuyTheoLuot };
