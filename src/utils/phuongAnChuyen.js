'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// LUẬT: PHƯƠNG ÁN IN PHẢI KHỚP LOẠI CHUYỀN (chốt 18/08/2026).
//   Bàn 1 ↔ loại BAN · Máy 2 ↔ loại MAY · Robot 3 ↔ loại ROBOT.
//
// ⚠⚠ CHẶN TUYỆT ĐỐI, KHÔNG CÓ ĐƯỜNG THOÁT (người dùng chốt sau khi đã xem số đo): lệch thì phải
//   ĐỔI PHƯƠNG ÁN IN và được người duyệt thông qua (mig 086) mới release được. CỐ Ý không làm cờ
//   "bỏ qua" hay quyền override — nếu cần nới thì đó là quyết định nghiệp vụ mới, không phải vá code.
//
// ⚠⚠ QUY MÔ ĐÃ ĐO TRƯỚC KHI BẬT (prod, 30 ngày): **244/1168 lệnh (21%) đang LỆCH** —
//   106 chuyền Máy ↔ PA Bàn · 94 Bàn ↔ PA Máy · 36 Robot ↔ PA Bàn · 7 Bàn ↔ PA Robot · 1 Máy ↔ PA Robot.
//   Nghĩa là ngày bật lên sẽ có ~8 yêu cầu duyệt/ngày. Cấp `PA_IN_APPROVE` cho tổ trưởng Kế hoạch
//   để họ tự thông ngay tại chỗ (người có quyền duyệt được đổi thẳng).
//
// ⚠ CHỈ ÁP CHO 3 LOẠI BÀN/MÁY/ROBOT. **Ép · Logo · Gia công MIỄN KIỂM** — 3 loại đó là luồng riêng
//   và danh mục `phuong_an_in` không có giá trị tương ứng (chỉ 0..3). Đo prod: riêng gia công đã có
//   291 lệnh mang PA=Bàn, không miễn là gia công tắc hoàn toàn.
//
// ⚠⚠ MIỄN THEO **MÃ CHUYỀN** — 3 chuyền dùng chung (chốt 19/08/2026, xem `MA_CHUYEN_MIEN` bên dưới).
//
// ⚠ PA = 0 (CHƯA XÁC ĐỊNH) **BỊ CHẶN** — phải đặt phương án in trước khi release.
//   (Ngoại lệ: 3 chuyền miễn ở trên thì PA=0 cũng release được.)
// ─────────────────────────────────────────────────────────────────────────────

const { PHUONG_AN_IN } = require('./hskt');

// Loại chuyền → phương án in bắt buộc.
const LOAI_CHUYEN_TO_PAIN = { BAN: 1, MAY: 2, ROBOT: 3 };

// Loại chuyền KHÔNG áp luật (luồng riêng).
const LOAI_MIEN = ['EP', 'LOGO', 'GIA_CONG'];

// ⚠⚠ CHUYỀN DÙNG CHUNG — MIỄN KIỂM HOÀN TOÀN (chốt 19/08/2026, người dùng yêu cầu).
//   `M1A-1B` Canh hàng · `M2A-2B` Bổ sung MTĐ · `M3A-3B` Mẫu (xem `frontend/src/utils/khuChuyen.js`
//   hằng KHU_BAN). Ba chuyền này nhận hàng của MỌI phương án in — canh hàng / chạy bổ sung / làm mẫu
//   là việc phát sinh, không đi theo phương án in của phần in ⇒ ép khớp loại chuyền là chặn oan.
//   Miễn cả PA = 0 (chưa xác định): mẫu/canh hàng thường chạy trước khi kỹ thuật chốt phương án in.
//
// ⚠⚠ KHỚP **NGUYÊN MÃ**, TUYỆT ĐỐI KHÔNG `startsWith`/`LIKE 'M1%'`: mã `M1`/`M2`/`M3` là **chuyền
//   MÁY 1/2/3** và `M10A`..`M14B` là chuyền Bàn khác — so kiểu tiền tố sẽ miễn nhầm gần hết nhà máy.
//   (Đối chiếu prod 19/08: 3 mã dưới đây đều tồn tại, `dang_hoat_dong=true`, loại `BAN`; còn `M1A`/`M1B`
//   rời là dữ liệu cũ ĐÃ NGỪNG hoạt động — cố ý không đưa vào danh sách.)
// ⚠ Thêm/bớt chuyền miễn thì sửa ĐÚNG mảng này — không cần migration, không đụng repository
//   (`getPainVsChuyen` vốn đã trả `cs.ma_chuyen`).
const MA_CHUYEN_MIEN = ['M1A-1B', 'M2A-2B', 'M3A-3B'];

const chuan = (v) => String(v || '').trim().toUpperCase();

const laLoaiMien = (maLoai) => LOAI_MIEN.includes(chuan(maLoai));

const laChuyenMien = (maChuyen) => MA_CHUYEN_MIEN.includes(chuan(maChuyen));

const tenLoaiChuyen = (maLoai) => ({
  BAN: 'Bàn', MAY: 'Máy', ROBOT: 'Robot', EP: 'Ép', LOGO: 'Logo', GIA_CONG: 'Gia công',
}[chuan(maLoai)] || maLoai || '—');

const tenPain = (v) => PHUONG_AN_IN[Number(v) || 0] || 'Chưa xác định';

// Kiểm 1 cặp (loại chuyền, phương án in).
// Trả `null` nếu HỢP LỆ, hoặc `{ ma_loi, thong_diep }` nếu lệch.
function kiemCap({ maLoaiChuyen, phuongAnIn, maChuyen, maPhan }) {
  // ⚠ Đặt ĐẦU TIÊN, trước cả nhánh loại chuyền: 3 chuyền dùng chung miễn kiểm bất kể loại của chúng
  //   có bị đổi về sau hay không, và miễn cả PA = 0.
  if (laChuyenMien(maChuyen)) return null;
  if (!maLoaiChuyen) return null;                 // chuyền chưa gán loại → không có cơ sở để chặn
  if (laLoaiMien(maLoaiChuyen)) return null;      // Ép / Logo / Gia công: miễn
  const can = LOAI_CHUYEN_TO_PAIN[chuan(maLoaiChuyen)];
  if (!can) return null;                          // loại chuyền lạ (thêm sau này) → không chặn oan

  const pa = Number(phuongAnIn) || 0;
  const nhanChuyen = `${maChuyen || ''} (${tenLoaiChuyen(maLoaiChuyen)})`.trim();
  const nhanPhan = maPhan ? `${maPhan}: ` : '';

  if (pa === 0) {
    return {
      ma_loi: 'PAIN_CHUA_XAC_DINH',
      thong_diep: `${nhanPhan}chưa xác định phương án in — không release lên chuyền ${nhanChuyen} được. `
        + `Đặt phương án in là "${tenPain(can)}" rồi thử lại.`,
    };
  }
  if (pa !== can) {
    return {
      ma_loi: 'PAIN_LECH_CHUYEN',
      thong_diep: `${nhanPhan}phương án in là "${tenPain(pa)}" nhưng chuyền ${nhanChuyen} `
        + `là loại ${tenLoaiChuyen(maLoaiChuyen)} ⇒ phương án in phải là "${tenPain(can)}". `
        + 'Đổi phương án in (cần lý do + người duyệt) hoặc chọn chuyền khác.',
    };
  }
  return null;
}

module.exports = {
  LOAI_CHUYEN_TO_PAIN, LOAI_MIEN, MA_CHUYEN_MIEN,
  laLoaiMien, laChuyenMien, tenLoaiChuyen, tenPain, kiemCap,
};
