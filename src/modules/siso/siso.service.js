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
  const so = await repo.demSiSo(maTrang, { tu, den, loc: layLoc(q) });
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
    tu, den, loc: layLoc(q), page: Number(q.page) || 1, limit,
  });
  return { items, meta: { total, page: Number(q.page) || 1, limit }, o, ten_o: O_SI_SO[o].ten };
}

module.exports = { siSo, chiTiet, danhMuc };
