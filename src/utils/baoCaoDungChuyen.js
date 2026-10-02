'use strict';

// ─── BÁO CÁO BẤT THƯỜNG DỪNG CHUYỀN (Sản xuất › Báo cáo dừng chuyền, 02/10/2026) ──────────────────
// Hàm THUẦN — dữ liệu thô đọc ở `modules/production/baoCaoDungChuyen.js`. Dựng từ CÙNG một lượt dữ liệu:
//   · `chi_tiet`   : 1 dòng / 1 lần dừng chuyền (mới nhất trước).
//   · `theo_ly_do` : gom theo NGUYÊN NHÂN (danh mục `ly_do_ngung_chuyen`) — số lần · tổng phút · % thời gian.
//   · `theo_chuyen`: gom theo CHUYỀN — số lần · tổng phút · nguyên nhân chiếm nhiều phút nhất.
//   · `tong`       : số lần · tổng phút · số chuyền · số lần CHƯA bấm "Chuyền hoạt động lại".
//
// LUẬT:
//   · Nguồn = bảng `ngung_chuyen` (RunPanel › Ngừng chuyền). `ly_do` TEXT = "Tên danh mục — ghi chú"
//     (`production.service.stopLine`) ⇒ tách lại thành NGUYÊN NHÂN + GHI CHÚ; bản ghi không gắn danh mục
//     (trước mig 076 / gõ tay) ⇒ nguyên nhân "Khác (ghi tay)", cả chuỗi là ghi chú.
//   · NGÀY SX D = 06:00 D → 06:00 D+1 (cùng quy ước Báo cáo sản xuất + mã ngày ca của tem): lần dừng
//     thuộc ngày SX của lúc BẮT ĐẦU dừng. Ca theo loại ca tuần ISO (`cai_dat_ca_tuan`, `utils/ca.js`); tuần
//     chưa cài ⇒ suy từ mã ca trên tem của ngày (bên đọc lo), không có ⇒ ca Ngắn.
//   · THỜI GIAN DỪNG: đã hoạt động lại ⇒ `so_phut` (tính từ 2 mốc thật lúc ghi). CHƯA bấm hoạt động lại ⇒
//     đếm tới mốc SỚM NHẤT của (bây giờ · lúc phiếu kết thúc · hết khoảng báo cáo) + cờ `chua_ket_thuc`.
//     ⚠ Đo prod 02/10/2026: 3/6 bản ghi treo `DANG_NGUNG` từ tháng 8 (không ai bấm hoạt động lại) — đếm
//       thô tới bây giờ là mỗi bản ghi ~70.000 phút, làm hỏng mọi con số tổng.

const { caFromHour } = require('./ca');

const PHUT = 60 * 1000;
const VN_LECH = 7 * 3600 * 1000; // giờ VN = UTC+7, không có giờ mùa hè

// Mốc (ms) 06:00 giờ VN của ngày 'YYYY-MM-DD' + `cong` ngày.
function moc6h(ngay, cong = 0) {
  const [y, m, d] = String(ngay).split('-').map(Number);
  return Date.UTC(y, m - 1, d + cong, 6) - VN_LECH;
}

const ms = (v) => (v == null ? null : new Date(v).getTime());
const soTuNhien = (a, b) => String(a || '').localeCompare(String(b || ''), 'vi', { numeric: true, sensitivity: 'base' });

// "Tên — ghi chú" → { nguyenNhan, ghiChu }.
function tachLyDo(lyDo, tenDanhMuc) {
  const chuoi = String(lyDo || '').trim();
  const ten = String(tenDanhMuc || '').trim();
  if (ten) {
    if (chuoi === ten) return { nguyenNhan: ten, ghiChu: '' };
    if (chuoi.startsWith(`${ten} — `)) return { nguyenNhan: ten, ghiChu: chuoi.slice(ten.length + 3).trim() };
    return { nguyenNhan: ten, ghiChu: chuoi };
  }
  return { nguyenNhan: chuoi ? 'Khác (ghi tay)' : 'Không ghi lý do', ghiChu: chuoi };
}

function dungBaoCaoDungChuyen({ tuNgay, denNgay, rows = [], loaiCaNgay = () => 'NGAN', bayGio = Date.now() }) {
  const hetKhoang = moc6h(denNgay, 1);

  const chiTiet = rows.map((r) => {
    const bd = ms(r.tg_bd_ngung);
    const daXong = r.trang_thai === 'DA_HOAT_DONG_LAI' && r.tg_kt_ngung != null;
    let soPhut;
    if (daXong) {
      soPhut = r.so_phut != null ? Number(r.so_phut) : Math.max(0, Math.round((ms(r.tg_kt_ngung) - bd) / PHUT));
    } else {
      const chan = [bayGio, hetKhoang];
      if (r.phieu_trang_thai && r.phieu_trang_thai !== 'DANG_CHAY' && r.phieu_tg_kt) chan.push(ms(r.phieu_tg_kt));
      soPhut = Math.max(0, Math.round((Math.min(...chan) - bd) / PHUT));
    }
    const { nguyenNhan, ghiChu } = tachLyDo(r.ly_do, r.ten_ly_do);
    const loaiCa = loaiCaNgay(r.ngay_sx) || 'NGAN';
    return {
      id: r.id,
      ngay_sx: r.ngay_sx,
      ca: caFromHour(r.gio, r.phut, loaiCa),
      tg_bd: r.tg_bd_ngung,
      tg_kt: daXong ? r.tg_kt_ngung : null,
      so_phut: soPhut,
      chua_ket_thuc: !daXong,
      // Chưa bấm hoạt động lại mà phiếu VẪN đang chạy ⇒ đang dừng thật (hoặc quên bấm); phiếu đã kết
      // thúc ⇒ chắc chắn là quên bấm (thời gian đã chặn ở lúc phiếu kết thúc).
      dang_dung: !daXong && r.phieu_trang_thai === 'DANG_CHAY',
      ly_do_id: r.ly_do_id || null,
      ma_ly_do: r.ma_ly_do || null,
      nguyen_nhan: nguyenNhan,
      ghi_chu: ghiChu,
      ma_chuyen: r.ma_chuyen || null,
      ten_chuyen: r.ten_chuyen || null,
      loai_chuyen: r.ten_loai_chuyen || r.ma_loai_chuyen || null,
      ma_to: r.ma_to || null,
      ten_to: r.ten_to || null,
      ma_lenh_san_xuat: r.ma_lenh_san_xuat || null,
      ma_phan: r.ma_phan || null,
      khach: r.khach || null,
      po: r.po || null,
      ma_hang: r.ma_hang || null,
      mau_vai: r.mau_vai || null,
      nguoi_ghi: r.nguoi_ghi || null,
      nguoi_ket_thuc: daXong ? (r.nguoi_cap_nhat || null) : null,
    };
  }).sort((a, b) => ms(b.tg_bd) - ms(a.tg_bd));

  const tongPhut = chiTiet.reduce((s, x) => s + x.so_phut, 0);

  // Theo NGUYÊN NHÂN — khóa danh mục (id), không có thì theo chính tên nguyên nhân.
  const lyDo = new Map();
  chiTiet.forEach((x) => {
    const k = x.ly_do_id || `#${x.nguyen_nhan}`;
    if (!lyDo.has(k)) lyDo.set(k, { ly_do_id: x.ly_do_id, ma_ly_do: x.ma_ly_do, nguyen_nhan: x.nguyen_nhan, so_lan: 0, so_phut: 0, chuyen: new Set() });
    const g = lyDo.get(k);
    g.so_lan += 1;
    g.so_phut += x.so_phut;
    if (x.ma_chuyen) g.chuyen.add(x.ma_chuyen);
  });
  const theoLyDo = [...lyDo.values()]
    .map((g) => ({ ...g, chuyen: [...g.chuyen].sort(soTuNhien).join(', '), ty_le: tongPhut > 0 ? g.so_phut / tongPhut : 0 }))
    .sort((a, b) => b.so_phut - a.so_phut || b.so_lan - a.so_lan || soTuNhien(a.nguyen_nhan, b.nguyen_nhan));

  // Theo CHUYỀN + nguyên nhân chiếm nhiều phút nhất của chuyền đó.
  const chuyen = new Map();
  chiTiet.forEach((x) => {
    const k = x.ma_chuyen || '—';
    if (!chuyen.has(k)) chuyen.set(k, { ma_chuyen: x.ma_chuyen, ten_chuyen: x.ten_chuyen, loai_chuyen: x.loai_chuyen, so_lan: 0, so_phut: 0, nn: new Map() });
    const g = chuyen.get(k);
    g.so_lan += 1;
    g.so_phut += x.so_phut;
    g.nn.set(x.nguyen_nhan, (g.nn.get(x.nguyen_nhan) || 0) + x.so_phut);
  });
  const theoChuyen = [...chuyen.values()].map((g) => {
    const [chinh] = [...g.nn.entries()].sort((a, b) => b[1] - a[1]);
    const { nn, ...con } = g;
    return { ...con, nguyen_nhan_chinh: chinh ? chinh[0] : null, ty_le: tongPhut > 0 ? g.so_phut / tongPhut : 0 };
  }).sort((a, b) => b.so_phut - a.so_phut || soTuNhien(a.ma_chuyen, b.ma_chuyen));

  return {
    tu_ngay: tuNgay,
    den_ngay: denNgay,
    tong: {
      so_lan: chiTiet.length,
      so_phut: tongPhut,
      so_chuyen: theoChuyen.filter((g) => g.ma_chuyen).length,
      chua_ket_thuc: chiTiet.filter((x) => x.chua_ket_thuc).length,
      dang_dung: chiTiet.filter((x) => x.dang_dung).length,
    },
    theo_ly_do: theoLyDo,
    theo_chuyen: theoChuyen,
    chi_tiet: chiTiet,
  };
}

module.exports = { dungBaoCaoDungChuyen, tachLyDo, moc6h };
