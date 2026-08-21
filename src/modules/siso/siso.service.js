'use strict';

const repo = require('./siso.repository');
const { MAN, LOAI_NGAY, O_SI_SO } = require('../../utils/siSoTram');
const AppError = require('../../utils/AppError');

// Ngày mặc định = HÔM NAY theo giờ VN (server có thể chạy múi giờ khác — đừng dùng new Date() trần).
const homNayVN = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

// `den` là ngày CUỐI (bao gồm) ⇒ chặn trên của kỳ = 00:00 ngày KẾ TIẾP.
const ngaySau = (d) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10);
};

function chuanHoaKy(q = {}) {
  const tu = /^\d{4}-\d{2}-\d{2}$/.test(q.tu || '') ? q.tu : homNayVN();
  const denNhap = /^\d{4}-\d{2}-\d{2}$/.test(q.den || '') ? q.den : tu;
  const den = denNhap < tu ? tu : denNhap;
  return { tu, den: ngaySau(den), denHienThi: den };
}

const LOC_KEYS = ['timKiem', 'khach', 'don', 'maHang', 'codePhan', 'mauVai', 'kichVai', 'kichPhim',
  'chuyen', 'nhaGiaCong', 'loaiNgay', 'ngayTu', 'ngayDen'];
const layLoc = (q = {}) => LOC_KEYS.reduce((a, k) => (q[k] ? { ...a, [k]: q[k] } : a), {});

// ─── BỘ LỌC CỦA TRANG (dải "Theo dõi" bám ô tìm + panel lọc + dải chip của màn) ──────────────
// Gửi lên với tiền tố `t_` để KHÔNG đụng bộ lọc riêng trong modal (2 tầng AND với nhau — xem
// `dungLocKep` ở repository). Thêm 3 khóa chip mà modal không có: loại chuyền · khu bàn · PA in.
// ⚠ `t_phuongAnIn` phải xét `!== ''` chứ không `if (v)`: **`'0'` = CHƯA XÁC ĐỊNH là chip THẬT**
//   ở màn Release 1, dùng `if (v)` thì chip đó im lặng không lọc gì.
// ⚠ Thêm khóa mới ở ĐÂY thì FE mới gửi lên được — thiếu là backend BỎ QUA IM LẶNG (không lỗi),
//   dải số không nhúc nhích và rất khó đoán ra.
const LOC_TRANG_KEYS = [...LOC_KEYS, 'phuongAnIn', 'loaiChuyen', 'maChuyen',
  // Ô TÍCH của trang (18/08/2026): "Chỉ hiện … bị trả về" · "Đã Ready / Chờ Ready" · ô lọc "Gom set".
  // ⚠ ĐÃ GỠ khóa `choQa` (20/08/2026) cùng ô tích "Chỉ chờ QA" ở màn Test Run - QA — xem
  //   `utils/siSoTram.js` (chỗ `LAT_CHO_QA` cũ) để biết vì sao lọc thêm nó làm hỏng ô "Làm được".
  'biTraVe', 'daReady', 'choReady', 'gomSet'];
const layLocTrang = (q = {}) => LOC_TRANG_KEYS.reduce((a, k) => {
  const v = q[`t_${k}`];
  return v !== undefined && v !== null && v !== '' ? { ...a, [k]: v } : a;
}, {});

// Danh mục cho FE dựng UI (tên màn, đơn vị, nhãn 4 ô, danh sách loại ngày phụ).
function danhMuc() {
  return {
    man: Object.entries(MAN).map(([ma, m]) => ({ ma, ten: m.ten, don_vi: m.donVi, nhan: m.nhan })),
    o: Object.entries(O_SI_SO).map(([ma, o]) => ({ ma, ten: o.ten })),
    loai_ngay: Object.entries(LOAI_NGAY).map(([ma, l]) => ({ ma, ten: l.ten })),
  };
}

async function siSo(maTrang, q) {
  if (!MAN[maTrang]) throw new AppError('Màn hình không có sĩ số', { status: 404, errorCode: 'MAN_LA' });
  const { tu, den, denHienThi } = chuanHoaKy(q);
  const so = await repo.demSiSo(maTrang, { tu, den, loc: layLoc(q), locTrang: layLocTrang(q) });
  const m = MAN[maTrang];
  // ⚠ Bất biến PHẢI đúng theo mô hình khoảng [tg_vao, tg_ra). Lệch = có mục `tg_ra < tg_vao`
  //   (dữ liệu bẩn) lọt qua — trả cờ để FE hiện dấu hỏi thay vì im lặng cho số sai.
  const can = so.ton_dau + so.nhan - so.lam_duoc === so.ton_cuoi;
  // ⚠⚠ Nhãn đơn vị PHẢI là `don_vi_nhan`, KHÔNG được đặt tên `nhan` — trùng khóa với số "Nhận trong
  //   kỳ" ở `so.nhan` và sẽ ĐÈ MẤT nó (lỗi thật đã bắt được lúc kiểm: ô Nhận in ra chữ "đợt vải").
  return { ...so, can, tu, den: denHienThi, don_vi: m.donVi, don_vi_nhan: m.nhan, ten_man: m.ten };
}

async function chiTiet(maTrang, o, q) {
  if (!MAN[maTrang]) throw new AppError('Màn hình không có sĩ số', { status: 404, errorCode: 'MAN_LA' });
  if (!O_SI_SO[o]) throw new AppError('Ô sĩ số không hợp lệ', { status: 422, errorCode: 'O_LA' });
  const { tu, den } = chuanHoaKy(q);
  // `limit=0` = lấy HẾT (xuất Excel). Trần 500 cho lượt phân trang thường.
  const limit = String(q.limit) === '0' ? 0 : Math.min(500, Math.max(1, Number(q.limit) || 20));
  const { items, total } = await repo.chiTiet(maTrang, o, {
    tu, den, loc: layLoc(q), locTrang: layLocTrang(q), page: Number(q.page) || 1, limit,
  });
  return { items, meta: { total, page: Number(q.page) || 1, limit }, o, ten_o: O_SI_SO[o].ten };
}

module.exports = { siSo, chiTiet, danhMuc };
