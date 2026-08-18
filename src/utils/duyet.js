'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// DUYỆT YÊU CẦU — NGUỒN LUẬT DÙNG CHUNG (mig 086).
//
// Việc đầu tiên: **ĐỔI PHƯƠNG ÁN IN phải có lý do + được duyệt** (chốt 18/08/2026).
//
// ⚠⚠ THÊM LOẠI DUYỆT MỚI = khai thêm ở `LOAI_DUYET` dưới đây, **KHÔNG cần migration**
//   (`yeu_cau_duyet.loai` không có FK, bảng không seed dòng nào) — cùng khuôn `TRANG_PAIN`
//   (mig 067) · `VI_TRI_IN` (mig 073) · `LOAI_TB` (mig 085).
//
// ⚠⚠ MÔ HÌNH DUYỆT (người dùng chốt): **CHỜ DUYỆT MỚI ĐỔI**, TRỪ người có quyền duyệt thì đổi
//   thẳng (tự duyệt), vẫn ghi đủ lý do + audit. Nghĩa là:
//     · người thường bấm đổi  → tạo yêu cầu `CHO`, giá trị GIỮ NGUYÊN cho tới khi được duyệt;
//     · người có `quyenDuyet` → áp dụng NGAY, ghi 1 dòng `yeu_cau_duyet` trạng thái `DUYET`
//       (nguoi_gui = nguoi_duyet) để hàng đợi vẫn có hồ sơ đầy đủ, không có "đường tối".
// ─────────────────────────────────────────────────────────────────────────────

const { PHUONG_AN_IN } = require('./hskt');

const LOAI_DUYET = {
  DOI_PHUONG_AN_IN: {
    ten: 'Đổi phương án in',
    mo_ta: 'Đổi phương án in của hồ sơ kỹ thuật (Bàn / Máy / Robot). '
      + 'Ảnh hưởng cả nhóm phần in dùng chung hồ sơ và đổi luôn số cuối mã vạch HSKT.',
    bang: 'ho_so_ky_thuat',
    // Quyền được DUYỆT (và được tự đổi thẳng không qua hàng đợi).
    quyenDuyet: 'PA_IN_APPROVE',
    // Quyền được GỬI yêu cầu — đúng bộ quyền vốn đã đổi được phương án in trước đây.
    quyenGui: ['READY_KHUON', 'READY_FILM', 'READY_MUC', 'READY_QC'],
    // Diễn giải giá trị cho người đọc hàng đợi (số 0..3 → "Bàn"/"Máy"…).
    nhanGiaTri: (v) => PHUONG_AN_IN[Number(v) || 0] || String(v ?? '—'),
  },
};

const TRANG_THAI = {
  CHO: { ten: 'Chờ duyệt', tone: 'warning' },
  DUYET: { ten: 'Đã duyệt', tone: 'success' },
  TU_CHOI: { ten: 'Bị từ chối', tone: 'danger' },
  HUY: { ten: 'Đã hủy', tone: 'default' },
};

const laLoaiHopLe = (ma) => Object.hasOwn(LOAI_DUYET, ma);

// Người này có được DUYỆT loại yêu cầu đó không ('*' = admin).
const coQuyenDuyet = (perms = [], maLoai) => {
  const v = LOAI_DUYET[maLoai];
  if (!v) return false;
  return perms.includes('*') || perms.includes(v.quyenDuyet);
};

// Người này có được GỬI yêu cầu loại đó không.
const coQuyenGui = (perms = [], maLoai) => {
  const v = LOAI_DUYET[maLoai];
  if (!v) return false;
  if (perms.includes('*')) return true;
  // Người duyệt được thì đương nhiên gửi được.
  if (perms.includes(v.quyenDuyet)) return true;
  return (v.quyenGui || []).some((q) => perms.includes(q));
};

// Có thấy TRANG hàng đợi duyệt không = duyệt được ÍT NHẤT 1 loại, hoặc gửi được (để xem yêu cầu
// của chính mình). ⚠ Trả cờ cho FE tự ẩn menu thay vì trả 403 — cùng cách làm với chuông thông báo.
const coQuyenXemHangDoi = (perms = []) => Object.keys(LOAI_DUYET)
  .some((ma) => coQuyenDuyet(perms, ma) || coQuyenGui(perms, ma));

// Danh mục cho FE dựng chip/bộ lọc (kèm cờ quyền của CHÍNH người đang đăng nhập).
const danhMuc = (perms = []) => ({
  loai: Object.entries(LOAI_DUYET).map(([ma, v]) => ({
    ma, ten: v.ten, mo_ta: v.mo_ta,
    duyet_duoc: coQuyenDuyet(perms, ma),
    gui_duoc: coQuyenGui(perms, ma),
  })),
  trang_thai: Object.entries(TRANG_THAI).map(([ma, v]) => ({ ma, ten: v.ten, tone: v.tone })),
});

module.exports = {
  LOAI_DUYET, TRANG_THAI, laLoaiHopLe,
  coQuyenDuyet, coQuyenGui, coQuyenXemHangDoi, danhMuc,
};
