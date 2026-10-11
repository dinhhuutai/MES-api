'use strict';

// ─── BÁO CÁO PHÂN LOẠI LỖI (Sản xuất › Báo cáo phân loại lỗi, 11/10/2026) ─────────────────────────
// Hàm THUẦN — dữ liệu thô đọc ở `modules/production/baoCaoPhanLoaiLoi.js`. Khuôn tờ xưởng "Báo cáo PLL":
//   dòng = MÃ LỖI (có bao nhiêu lỗi hiện ra hết) · cột = từng DÂY CHUYỀN (MTD · Bàn in · RB · MT · LG · MEP) × Sửa / Hủy
//   + khối "Tổng lỗi" (Sửa · Hủy · Sửa + Hủy · % S+H) · 3 dòng cuối: Tổng lỗi · % lỗi (= lỗi ÷ SL kiểm) · SL kiểm.
//   "Gồm theo: Loại dây chuyền · Thợ · Khách hàng · chi tiết" ⇒ trang đổi được chiều CỘT (dây chuyền / chuyền / thợ in /
//   khách hàng) và có bảng chi tiết; ma trận do FE dựng từ `chi_tiet` + `kiem` trả ở đây (đổi chiều không gọi lại API).
//
// LUẬT (cùng nền với Báo cáo kiểm hàng — `utils/baoCaoKiemHang.js` — để 2 báo cáo cộng ra cùng số):
//   · KỲ = ngày SX của LƯỢT KCS: tuNgay 06:00 → denNgay+1 06:00 giờ VN. Tem thuộc kỳ khi có lượt KCS (chưa hủy xác
//     nhận) trong kỳ. SL KIỂM = Σ (đạt + hư + hủy tại KCS) của các lượt trong kỳ.
//   · LỖI = phiếu PHÂN LOẠI LỖI của tem (mỗi dòng: mã lỗi · biện pháp · SL sửa · SL hủy — số chính thức). Tem kiểm
//     nhiều lượt mà chỉ một phần lượt rơi vào kỳ ⇒ phiếu của tem nhân theo tỷ lệ hư của các lượt TRONG kỳ (làm tròn);
//     tem 1 lượt (gần như mọi tem từ 04/09/2026) thì lấy nguyên.
//   · Tem có hàng hư mà CHƯA phân loại ⇒ dòng giả `(Chưa phân loại)`: toàn bộ hư tính SỬA (đúng sổ cái — KCS dồn hết hư
//     vào chờ sửa) ⇒ Σ Sửa + Hủy của báo cáo = cột SL sửa + SL hủy của Báo cáo kiểm hàng cùng kỳ.
//   · Hủy ghi thẳng tại KCS (`kcs.so_luong_huy`, chỉ dữ liệu cũ trước khi có Phân loại lỗi) ⇒ dòng giả `(Hủy tại KCS)`.
//   · Dây chuyền = nhóm loại chuyền của chuyền chạy phiếu; Thợ in = thợ PHỤ TRÁCH của phiếu (người đầu danh sách, chuyền
//     Máy lấy chuyền trưởng — `utils/thoIn.js`), `tho_ds` = cả nhóm.

const { nhomCuaLoai } = require('./baoCaoSanXuat');
const { dsThoCuaDong } = require('./thoIn');

const so = (v) => Math.max(0, Math.round(Number(v) || 0));
const MA_CHUA_PL = '(Chưa phân loại)';
const MA_HUY_KCS = '(Hủy tại KCS)';
const soTuNhien = (a, b) => String(a || '').localeCompare(String(b || ''), 'vi', { numeric: true, sensitivity: 'base' });

/**
 * @param {object} p
 * @param {string} p.tuNgay · p.denNgay  YYYY-MM-DD
 * @param {Array} p.luot    MỌI lượt KCS (chưa hủy) của các tem có lượt trong kỳ — dòng của `baoCaoKiemHang.docLuot`
 *                          (cờ `trong_ky`, `so_luong_dat/loi/huy`, chuyền, phần in, thợ…).
 * @param {Array} p.pll     dòng chi tiết phiếu phân loại của các tem đó: { tem_id, ma_loi, ten_loi, nhom_loi, ma_bien_phap,
 *                          ten_bien_phap, so_luong_sua, so_luong_huy, ghi_chu, tg_phan_loai, nguoi_phan_loai }.
 * @param {Array} p.danhMuc danh mục mã lỗi: { ma_loi, ten_loi, nhom_loi, dang_hoat_dong }.
 */
function dungBaoCaoPhanLoaiLoi({ tuNgay, denNgay, luot = [], pll = [], danhMuc = [] }) {
  const theoTem = new Map();
  luot.forEach((r) => {
    const k = String(r.tem_id);
    if (!theoTem.has(k)) theoTem.set(k, []);
    theoTem.get(k).push(r);
  });
  const pllTheoTem = new Map();
  pll.forEach((c) => {
    const k = String(c.tem_id);
    if (!pllTheoTem.has(k)) pllTheoTem.set(k, []);
    pllTheoTem.get(k).push(c);
  });

  const chiTiet = [];
  const kiem = [];
  let soTemChuaPl = 0;
  theoTem.forEach((ds, temId) => {
    const trongKy = ds.filter((r) => r.trong_ky);
    if (!trongKy.length) return;
    const dau = trongKy[0];
    const tho = dsThoCuaDong(dau);
    const chung = {
      tem_id: dau.tem_id, ma_tem: dau.ma_tem, ma_lenh_san_xuat: dau.ma_lenh_san_xuat || null,
      nhom: nhomCuaLoai(dau.ma_loai_chuyen), ma_chuyen: dau.ma_chuyen || null, ten_chuyen: dau.ten_chuyen || null,
      khach: dau.khach || null, po: dau.po || null, ma_hang: dau.ma_hang || null, ma_phan: dau.ma_phan || null,
      mau_vai: dau.mau_vai || null, kich_vai: dau.kich_vai || null, kich_phim: dau.kich_phim || null,
      tho: tho[0], tho_ds: tho.join(', '),
      // Lượt kiểm MỚI NHẤT trong kỳ — mốc hiện ở bảng chi tiết.
      tg_kiem: trongKy.reduce((m, r) => (new Date(r.tg_kiem) > new Date(m) ? r.tg_kiem : m), trongKy[0].tg_kiem),
      ngay_sx: trongKy[trongKy.length - 1].ngay_sx,
    };
    const huKy = trongKy.reduce((s, r) => s + so(r.so_luong_loi), 0);
    const huTat = ds.reduce((s, r) => s + so(r.so_luong_loi), 0);
    const huyKcs = trongKy.reduce((s, r) => s + so(r.so_luong_huy), 0);
    const dat = trongKy.reduce((s, r) => s + so(r.so_luong_dat), 0);
    kiem.push({ ...chung, sl_kiem: dat + huKy + huyKcs, sl_dat: dat, sl_hu: huKy });

    const phieu = pllTheoTem.get(temId) || [];
    if (phieu.length && huKy > 0) {
      const tyLe = huTat > 0 ? Math.min(1, huKy / huTat) : 1;
      phieu.forEach((c) => {
        const sua = tyLe === 1 ? so(c.so_luong_sua) : Math.round(so(c.so_luong_sua) * tyLe);
        const huy = tyLe === 1 ? so(c.so_luong_huy) : Math.round(so(c.so_luong_huy) * tyLe);
        if (!sua && !huy) return;
        chiTiet.push({
          ...chung, ma_loi: c.ma_loi || '(Không mã)', ten_loi: c.ten_loi || null, nhom_loi: c.nhom_loi || null,
          bien_phap: c.ten_bien_phap || c.ma_bien_phap || null, ghi_chu: c.ghi_chu || null,
          sl_sua: sua, sl_huy: huy, tg_phan_loai: c.tg_phan_loai || null, nguoi_phan_loai: c.nguoi_phan_loai || null,
          chua_phan_loai: false,
        });
      });
    } else if (huKy > 0) {
      soTemChuaPl += 1;
      chiTiet.push({
        ...chung, ma_loi: MA_CHUA_PL, ten_loi: 'Tem có hàng hư chưa phân loại lỗi (đang tính là sửa)', nhom_loi: null,
        bien_phap: null, ghi_chu: null, sl_sua: huKy, sl_huy: 0, tg_phan_loai: null, nguoi_phan_loai: null, chua_phan_loai: true,
      });
    }
    if (huyKcs > 0) {
      chiTiet.push({
        ...chung, ma_loi: MA_HUY_KCS, ten_loi: 'Hủy ghi thẳng tại KCS (dữ liệu trước khi có Phân loại lỗi)', nhom_loi: null,
        bien_phap: null, ghi_chu: null, sl_sua: 0, sl_huy: huyKcs, tg_phan_loai: null, nguoi_phan_loai: null, chua_phan_loai: false,
      });
    }
  });
  chiTiet.sort((a, b) => new Date(b.tg_kiem) - new Date(a.tg_kiem) || soTuNhien(a.ma_tem, b.ma_tem) || soTuNhien(a.ma_loi, b.ma_loi));

  // Danh sách mã lỗi của báo cáo: MỌI mã đang dùng trong danh mục ("có bao nhiêu lỗi hiện ra hết") + mã đã ngừng
  // nhưng có số liệu + 2 dòng giả (chỉ khi có số). Xếp theo mã tự nhiên, dòng giả đứng cuối.
  const coSo = new Map();
  chiTiet.forEach((c) => { if (!coSo.has(c.ma_loi)) coSo.set(c.ma_loi, c); });
  const maLoi = [];
  const daCo = new Set();
  danhMuc.filter((m) => m.dang_hoat_dong !== false || coSo.has(m.ma_loi)).forEach((m) => {
    if (daCo.has(m.ma_loi)) return;
    daCo.add(m.ma_loi);
    maLoi.push({ ma_loi: m.ma_loi, ten_loi: m.ten_loi || null, nhom_loi: m.nhom_loi || null, gia: false });
  });
  coSo.forEach((c, ma) => {
    if (daCo.has(ma) || ma === MA_CHUA_PL || ma === MA_HUY_KCS) return;
    daCo.add(ma);
    maLoi.push({ ma_loi: ma, ten_loi: c.ten_loi, nhom_loi: c.nhom_loi, gia: false });
  });
  maLoi.sort((a, b) => soTuNhien(a.ma_loi, b.ma_loi));
  [MA_CHUA_PL, MA_HUY_KCS].forEach((ma) => {
    if (coSo.has(ma)) maLoi.push({ ma_loi: ma, ten_loi: coSo.get(ma).ten_loi, nhom_loi: null, gia: true });
  });

  const tong = {
    sl_kiem: kiem.reduce((s, k) => s + k.sl_kiem, 0),
    sl_sua: chiTiet.reduce((s, c) => s + c.sl_sua, 0),
    sl_huy: chiTiet.reduce((s, c) => s + c.sl_huy, 0),
    so_tem: kiem.length,
    so_tem_co_loi: new Set(chiTiet.map((c) => String(c.tem_id))).size,
    so_tem_chua_phan_loai: soTemChuaPl,
  };
  return { tu_ngay: tuNgay, den_ngay: denNgay, tong, ma_loi: maLoi, chi_tiet: chiTiet, kiem };
}

module.exports = { dungBaoCaoPhanLoaiLoi, MA_CHUA_PL, MA_HUY_KCS };
