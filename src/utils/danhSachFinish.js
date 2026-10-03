'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// DANH SÁCH FINISH (màn OQC, 03/10/2026) — hàm thuần dựng cột suy ra từ số đã đọc.
// Khuôn tờ Excel xưởng "DANH SÁCH FINISH NGÀY …": 1 dòng / PHẦN IN (code phần) — 03/10/2026 người dùng chốt
// "nhiều tem thì cộng lại" (bản đầu tách 1 dòng / ngày × phần in ⇒ chọn khoảng nhiều ngày ra trùng code phần).
//
// Định nghĩa từng cột (đọc ở `modules/quality/danhSachFinish.js`):
//   · Ngày cập nhật danh sách = ngày (giờ VN) GẦN NHẤT trong khoảng đã chọn có lượt OQC cho QUA GIAO
//     (`oqc.sl_qua_giao > 0`, chưa hủy xác nhận) của một tem thuộc phần in.
//   · Sgiao = Σ SL OQC cho qua giao (finish) của MỌI tem phần in, LŨY KẾ tới HẾT ngày cuối khoảng ·
//     Chênh lệch giao/PO = Sgiao − SLĐH.
//   · SLIN = Σ SL in tem · Tồn cuối = hàng LỖI phát hiện ở KCS (`sl_kcs_sua + sl_kcs_huy`) = Sửa đạt + Sửa hủy
//     + SL còn lại · Sửa đạt = `sl_sua_dat` · Sửa hủy = `sl_sua_huy` + hủy thẳng ở Phân loại lỗi (`sl_kcs_huy`) ·
//     SL còn lại = chờ sửa (`sl_kcs_sua − sl_sua_dat − sl_sua_huy`). Cộng trên MỌI tem của phần in, SỐ HIỆN TẠI.
//   · Thời gian giao hàng = hạn giao sớm nhất của các đợt vải (của chính phần in) trong lệnh có tem OQC trong khoảng ·
//     Số ngày tồn đọng = hạn giao − ngày cập nhật danh sách (âm = trễ).
//   · Ngày cập nhật kết quả = lần ghi kết quả lỗi GẦN NHẤT trên mọi tem (lượt Sửa / phiếu Phân loại lỗi có hủy).
//   · Ghi chú = hàng còn dở của phần in (chờ kiểm / chờ sửa / chờ OQC).
// ⚠ Tem KHÔNG lưu phần in (DATABASE.md §4): tem sản xuất quy về phần in ĐẦU của lệnh (như mọi màn theo tem);
//   tem gia công 13 có `dot_vai_ve_id` ⇒ đúng phần in.
// ⚠ Hàng do script "hệ thống tự chạy đến giao" ghi (`oqc.ghi_chu` mở đầu `[HỆ THỐNG`) mặc định KHÔNG lên danh
//   sách (không phải hàng xưởng finish thật) — tham số `gomHeThong` để xem kèm.
// ─────────────────────────────────────────────────────────────────────────────

const DAU_HE_THONG = '[HỆ THỐNG%'; // LIKE — dấu `ghi_chu` của bản ghi do script hệ thống tạo

const so = (v) => (v == null || v === '' ? 0 : Number(v) || 0);
// Số ngày giữa 2 chuỗi 'YYYY-MM-DD' (b − a), null nếu thiếu.
const soNgay = (a, b) => {
  if (!a || !b) return null;
  const da = Date.parse(`${a}T00:00:00Z`); const db = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  return Math.round((db - da) / 86400000);
};
const fmtSo = (n) => Number(n).toLocaleString('vi-VN');

function ghiChuDong(r) {
  const p = [];
  if (so(r.con_kcs) > 0) p.push(`Đang chờ kiểm ${fmtSo(so(r.con_kcs))}`);
  if (so(r.sl_con_lai) > 0) p.push(`Chờ sửa ${fmtSo(so(r.sl_con_lai))}`);
  if (so(r.con_oqc) > 0) p.push(`Chờ OQC ${fmtSo(so(r.con_oqc))}`);
  return p.join(' · ');
}

// 1 dòng thô ⇒ dòng hiển thị (thêm cột suy ra, ép số).
function dungDongFinish(r) {
  const out = { ...r };
  for (const k of ['so_luong_don_hang', 'slnv', 'slin', 'sgiao', 'ton_cuoi', 'sua_dat', 'sua_huy', 'sl_con_lai',
    'con_kcs', 'con_oqc']) out[k] = so(r[k]);
  out.chenh_lech = out.sgiao - out.so_luong_don_hang;
  out.so_ngay_ton_dong = soNgay(r.ngay, r.han_giao_hang);
  out.ghi_chu = ghiChuDong(out);
  return out;
}

// Thứ tự giống tờ giấy: ngày (gần nhất) → khách → đơn → mã hàng → code phần.
const khoaSapXep = (r) => [r.ngay || '', r.ten_khach_hang || '', r.ma_don_hang || '', r.ma_hang || '', r.ma_phan || ''];
function sapXep(a, b) {
  const x = khoaSapXep(a); const y = khoaSapXep(b);
  for (let i = 0; i < x.length; i += 1) { const c = x[i].localeCompare(y[i], 'vi'); if (c) return c; }
  return 0;
}

function dungDanhSachFinish({ tuNgay, denNgay, gomHeThong, rows = [], mucTieu = [] }) {
  return {
    meta: { tu_ngay: tuNgay, den_ngay: denNgay, ngay_tieu_de: denNgay, gom_he_thong: !!gomHeThong },
    items: rows.map(dungDongFinish).sort(sapXep),
    muc_tieu: mucTieu.map((r) => ({ ...r, so_luong_don_hang: so(r.so_luong_don_hang), slnv: so(r.slnv) })),
  };
}

module.exports = { DAU_HE_THONG, dungDanhSachFinish, dungDongFinish, ghiChuDong, soNgay };
