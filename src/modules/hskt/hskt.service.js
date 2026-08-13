'use strict';

const repo = require('./hskt.repository');
const AppError = require('../../utils/AppError');
const { buildMeta } = require('../../utils/pagination');
const sockets = require('../../sockets');

// Nhãn phương án in (Pain): 1 Bàn, 2 Máy, 3 Robot — nguồn chung `utils/hskt.js`.
const { PHUONG_AN_IN: PHUONG_AN, isValidPain } = require('../../utils/hskt');

const paLabel = (v) => (v == null ? null : (PHUONG_AN[Number(v)] || String(v)));

async function list({ search, filters, page, limit, offset }) {
  const { rows, total } = await repo.listHskt({ search, filters, offset, limit });
  const items = rows.map((r) => ({ ...r, phuong_an_in_ten: paLabel(r.phuong_an_in) }));
  return { items, meta: buildMeta(page, limit, total) };
}

// Chi tiết 1 HSKT: thông tin + phần in + lịch sử (theo barcode, gộp phiên bản).
async function detail(id) {
  const hskt = await repo.getHsktById(id);
  if (!hskt) throw new AppError('HSKT không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const [phanIn, lichSu] = await Promise.all([
    repo.phanInOfHskt(id),
    hskt.barcode_hskt ? repo.historyByBarcode(hskt.barcode_hskt) : Promise.resolve([]),
  ]);
  return { hskt: { ...hskt, phuong_an_in_ten: paLabel(hskt.phuong_an_in) }, phan_in: phanIn, lich_su: lichSu };
}

// HSKT hiện hành của 1 phần in + các phần in cùng HSKT (anh em).
async function byPhanIn(phanInId) {
  const hskt = await repo.activeHsktOfPhanIn(phanInId);
  if (!hskt) return { hskt: null, phan_in: [] };
  const phanIn = await repo.phanInOfHskt(hskt.id);
  return { hskt: { ...hskt, phuong_an_in_ten: paLabel(hskt.phuong_an_in) }, phan_in: phanIn };
}

// Quét barcode HSKT → HSKT + danh sách phần in (cho modal).
// Quét ở trang Hồ sơ kỹ thuật (chốt 2026-08-03):
//   `kieu='qr'`      → nội dung QR là **CODE PHẦN** (`phan_in.ma_phan`) → ra HSKT của phần in đó.
//   `kieu='barcode'` → mã vạch 1D là **BARCODE HSKT**, chỉ so **11 SỐ ĐẦU** (số cuối = phương án in,
//                      đổi PA là đổi số cuối ⇒ so đủ 12 số thì phiếu giấy in mã cũ quét không ra).
// Không rõ loại (gõ tay / deep-link `?bc=`) → thử lần lượt: khớp barcode CHÍNH XÁC → 11 số đầu → code phần.
// Trả cùng shape cho mọi đường vào.
async function byBarcode(barcode, kieu) {
  const code = String(barcode || '').trim();
  if (!code) throw new AppError('Chưa có mã để tra', { status: 422, errorCode: 'NO_CODE' });

  let hskt = null;
  if (kieu === 'qr') {
    hskt = await repo.activeHsktByMaPhan(code);
  } else if (kieu === 'barcode') {
    hskt = await repo.activeHsktByBarcodePrefix(code);
  } else {
    hskt = await repo.activeHsktByBarcode(code)
      || await repo.activeHsktByBarcodePrefix(code)
      || await repo.activeHsktByMaPhan(code);
  }
  // Quét nhầm chế độ là chuyện thường ở xưởng → thử nốt đường còn lại trước khi báo không thấy.
  if (!hskt) {
    hskt = kieu === 'qr'
      ? await repo.activeHsktByBarcodePrefix(code)
      : await repo.activeHsktByMaPhan(code);
  }
  if (!hskt) {
    const nhan = kieu === 'qr' ? 'code phần' : 'mã vạch';
    throw new AppError(`Không tìm thấy hồ sơ kỹ thuật theo ${nhan} "${code}"`,
      { status: 404, errorCode: 'NOT_FOUND' });
  }
  const phanIn = await repo.phanInOfHskt(hskt.id);
  return { hskt: { ...hskt, phuong_an_in_ten: paLabel(hskt.phuong_an_in) }, phan_in: phanIn };
}

// Đổi phương án in → tạo phiên bản mới + ĐỔI SỐ CUỐI mã vạch HSKT theo phương án in.
async function changePhuongAnIn(id, pain, actorId) {
  const p = Number(pain);
  if (!isValidPain(p)) throw new AppError('Phương án in không hợp lệ (1 Bàn / 2 Máy / 3 Robot)', { status: 422, errorCode: 'INVALID' });
  const res = await repo.changePhuongAnIn(id, p, actorId);
  if (!res) throw new AppError('HSKT không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (res.error === 'BARCODE_TRUNG') {
    throw new AppError(
      `Đã có hồ sơ kỹ thuật khác đang dùng mã vạch ${res.barcode_moi} — không thể đổi phương án in`,
      { status: 409, errorCode: 'BARCODE_TRUNG' }
    );
  }
  sockets.emit('workflow:updated', { stage: 'HSKT', hsktId: res.id });
  // Màn READY / QC READY cho đổi phương án in ngay tại cột ⇒ máy khác phải thấy. 2 màn đó nghe
  // `ready:confirmed` (KHÔNG nghe `workflow:updated` — event ấy bị planning bắn rất dày, nghe vào là
  // tải lại liên tục vô ích), nên emit thêm ở đây thay vì nới danh sách nghe bên FE.
  sockets.emit('ready:confirmed', { stage: 'HSKT', hsktId: res.id });
  const data = await detail(res.id);
  return { ...data, barcode_cu: res.barcode_cu, barcode_moi: res.barcode_moi };
}

module.exports = { list, detail, byPhanIn, byBarcode, changePhuongAnIn, PHUONG_AN };
