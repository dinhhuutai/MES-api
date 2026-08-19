'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// MỤC KỸ THUẬT READY THEO KHÁCH HÀNG (dùng chung service + các query build SQL).
//
// LUẬT HIỆN HÀNH (chốt 2026-08-14):
//   · Khách THƯỜNG      → cần **Khuôn + Mực**. Film KHÔNG phải bấm riêng nữa: xác nhận Khuôn thì
//                          hệ thống TỰ ĐẶT Film = DAT (xem `technical.service.tuDatFilmTheoKhuon`).
//   · Khách GIA CÔNG (`KHUON_OPTIONAL_KH`) → chỉ cần **Mực**. Nhóm này không xác nhận Khuôn, mà
//                          Film nay đi theo Khuôn ⇒ giữ Film lại thì họ mắc kẹt vĩnh viễn.
//
// ⚠⚠ "ĐỦ MỤC KT" CỐ Ý **KHÔNG XÉT FILM** — đã cân nhắc rồi bỏ nhánh `OR existsFilm`:
//   · Không mất gì: đo prod 14/08 — bỏ Film KHÔNG làm phần in nào tụt ngược (biểu thức mới là
//     SIÊU TẬP của luật cũ), và 115 phần in có Film-mà-chưa-Khuôn thì **không cái nào đã xác nhận
//     Mực** nên cũng chẳng cái nào tự dưng thành "đủ".
//   · Nhận Film sẽ TẠO LỖ HỔNG: hủy xác nhận Khuôn (QC trả về / Test Run trả về / Hủy xác nhận
//     READY) mà Film vẫn còn DAT ⇒ `tech_done` vẫn TRUE ⇒ QC duyệt lại được trong khi kỹ thuật
//     CHƯA hề làm lại khuôn. Bỏ Film đi thì hủy Khuôn là chặn ngay, không cần đồng bộ 2 mục.
//   ⇒ Film thuần túy là HỆ QUẢ của Khuôn, không phải điều kiện.
//
// ⚠ KHÔNG dùng "đếm ≥ N" (sẽ sai khi khách gia công có Khuôn+Film mà thiếu Mực).
// SQL trả về gộp 1 dòng được (IPS-safe) — không đặt comment `-- …` trong chuỗi SQL.
// ─────────────────────────────────────────────────────────────────────────────

// Khách hàng HÀNG GIA CÔNG — KHÔNG bắt buộc Khuôn, và (từ 2026-08-14) KHÔNG bắt buộc cả Film.
// Khớp theo `khach_hang.ten_khach_hang` (ERP set ma=ten).
const KHUON_OPTIONAL_KH = ['II', 'AD'];

// Danh sách literal an toàn cho SQL ('II','AD') — hằng code, không phải input người dùng.
const KHUON_OPT_SQL_LIST = KHUON_OPTIONAL_KH.map((k) => `'${k}'`).join(',');

function isKhuonOptional(tenKhach) {
  return KHUON_OPTIONAL_KH.includes(String(tenKhach || '').trim());
}
// Tên gọi rõ nghĩa hơn cho luật mới (cùng một danh sách khách).
const laHangGiaCong = isKhuonOptional;

// Mục kỹ thuật CẦN thiết theo khách (JS side — cho FE/service dựng nhãn "/N").
// ⚠ FILM không còn nằm trong danh sách của ai cả: khách thường thì Khuôn kéo theo, khách gia công
//   thì miễn hẳn. Muốn biết "có HIỆN mục Film trên giao diện không" thì dùng `hienFilm()`.
function requiredTechItems(tenKhach) {
  return isKhuonOptional(tenKhach) ? ['MUC'] : ['KHUON', 'MUC'];
}

// Có hiện mục/cột Film cho khách này không (FE + Excel). Khách gia công: ẩn hẳn.
function hienFilm(tenKhach) {
  return !isKhuonOptional(tenKhach);
}

// Boolean "đủ mục KT" khi ĐÃ có sẵn trong scope: cột tên khách + 3 biểu thức EXISTS DAT từng mục.
//   · khách gia công  → chỉ cần Mực
//   · khách thường    → Mực AND Khuôn
// ⚠ `existsFilm` GIỮ trong chữ ký (mọi call-site đang truyền đủ 3) nhưng CỐ Ý KHÔNG dùng — xem
//   ghi chú "KHÔNG XÉT FILM" ở đầu file. Đừng nối lại vào biểu thức.
function techDoneSql(khachExpr, existsKhuon, existsFilm, existsMuc) {
  return `(${existsMuc} AND ((${khachExpr}) IN (${KHUON_OPT_SQL_LIST}) OR ${existsKhuon}))`;
}

// Boolean "đủ mục KT" chỉ từ 1 biểu thức phần in (tự dựng EXISTS + subquery khách).
// pinExpr = biểu thức SQL trỏ phan_in.id (vd 'pin.id', 'a.phan_in_id', 's.phan_in_id').
function techDoneSqlByPin(pinExpr) {
  const dat = (ma) => `EXISTS(SELECT 1 FROM ket_qua_checkpoint k JOIN checkpoint c ON c.id=k.checkpoint_id WHERE k.phan_in_id=${pinExpr} AND c.ma_checkpoint='${ma}' AND k.trang_thai='DAT')`;
  const khach = `(SELECT kh.ten_khach_hang FROM phan_in p2 JOIN ma_hang mh2 ON mh2.id=p2.ma_hang_id JOIN don_hang dh2 ON dh2.id=mh2.don_hang_id JOIN khach_hang kh ON kh.id=dh2.khach_hang_id WHERE p2.id=${pinExpr})`;
  return techDoneSql(khach, dat('KHUON'), dat('FILM'), dat('MUC'));
}

// ─────────────────────────────────────────────────────────────────────────────
// TÊN NGƯỜI XÁC NHẬN READY — có ca KHÔNG PHẢI NGƯỜI (sửa 19/08/2026).
//
// `erpsync.simulateReadyDone` (ERP `KTCankiemtra=0`) đặt DAT hộ mà KHÔNG gán cho ai:
// `nguoi_xac_nhan_id = NULL` + `ghi_chu` nêu lý do. Nếu cứ `LEFT JOIN nguoi_dung` như cũ thì cột
// "Người" hiện Ô TRỐNG — người dùng không hiểu là chưa ai làm hay hệ thống làm.
//
// ⚠⚠ CHỈ DÙNG Ở QUERY ĐÃ LỌC `trang_thai='DAT'`. Dòng CHƯA xác nhận cũng có `nguoi_xac_nhan_id`
//   NULL ⇒ áp vào danh sách chưa lọc sẽ hiện "Hệ thống (tự động)" cho mọi mục chưa ai đụng — sai nặng.
// ⚠ Bám vào `ghi_chu IS NOT NULL` chứ không phải chỉ `ho_ten IS NULL`: dữ liệu CŨ (trước bản vá) cũng
//   có dòng NULL người mà không có ghi chú — những dòng đó để trống như trước, không bịa nguồn gốc.
const NHAN_HE_THONG = 'Hệ thống (tự động)';
const nguoiXacNhanSql = (ndAlias, kqAlias) =>
  `COALESCE(${ndAlias}.ho_ten, CASE WHEN ${kqAlias}.ghi_chu IS NOT NULL THEN '${NHAN_HE_THONG}' END)`;

// ─────────────────────────────────────────────────────────────────────────────
// READY DO HỆ THỐNG TỰ XÁC NHẬN — LOẠI KHỎI MỌI SỐ LIỆU & DANH SÁCH CỦA READY
// (người dùng chốt 19/08/2026).
//
// Đợt vải có ERP `KTCankiemtra = 0` đi THẲNG Release 1: `erpsync.simulateReadyDone` đặt hộ DAT cho
// KHUON/FILM/MUC/QC_XAC_NHAN để phần in lọt qua guard release. **Kỹ thuật KHÔNG hề làm gì** ⇒ tính
// vào số liệu READY là thổi phồng khối lượng việc của tổ kỹ thuật, và báo cáo/Excel READY nêu ra
// những phần in chưa ai đụng tới.
//
// ⚠⚠ CĂN THEO MỐC `QC_XAC_NHAN` (người dùng chốt), KHÔNG phải "có bất kỳ mục nào tự động":
//   QC là mốc kết thúc READY — chính là thứ dải "Theo dõi" dùng làm `tg_ra`. Bám theo nó thì phần in
//   được NGƯỜI THẬT duyệt QC vẫn tính đủ, dù trước đó có mục nào đó do hệ thống đặt.
//   Đo prod 19/08: 92 phần in có dòng tự động, trong đó **90 hoàn toàn tự động**, chỉ 2 ca hỗn hợp.
//
// ⚠⚠ NHẬN DIỆN = `nguoi_xac_nhan_id IS NULL` TRÊN DÒNG ĐÃ `DAT`, KHÔNG dùng `ghi_chu`:
//   `ghi_chu` chỉ được ghi từ bản vá 19/08/2026 và **chưa deploy** — đo prod chỉ có **1 dòng** có
//   `ghi_chu`, trong khi dấu vết thật là **366 dòng** `nguoi_xac_nhan_id IS NULL AND trang_thai='DAT'`.
//   Dùng `ghi_chu` thì lọc gần như không ăn gì. Đã đối chiếu: 366/366 dòng NULL-người đều thuộc phần
//   in có đợt vải `kt_can_kiem_tra = false` ⇒ không lẫn dòng nào của người thật.
// ⚠ BẮT BUỘC kèm `trang_thai='DAT'`: dòng CHƯA ai xác nhận cũng có `nguoi_xac_nhan_id` NULL — thiếu
//   điều kiện này là loại nhầm toàn bộ phần in đang chờ làm.
// ⚠ Alias `zqc`/`zcp` đặt hiếm để không đụng alias của query lớn đang bọc ngoài.
const readyTuDongSql = (pinExpr) => `EXISTS (SELECT 1 FROM ket_qua_checkpoint zqc
  JOIN checkpoint zcp ON zcp.id = zqc.checkpoint_id AND zcp.ma_checkpoint = 'QC_XAC_NHAN'
  WHERE zqc.phan_in_id = ${pinExpr} AND zqc.trang_thai = 'DAT' AND zqc.nguoi_xac_nhan_id IS NULL)`;

// Điều kiện "phần in này ĐƯỢC tính vào số liệu READY".
const khongReadyTuDongSql = (pinExpr) => `NOT ${readyTuDongSql(pinExpr)}`;

module.exports = {
  KHUON_OPTIONAL_KH, KHUON_OPT_SQL_LIST, isKhuonOptional, laHangGiaCong,
  requiredTechItems, hienFilm, techDoneSql, techDoneSqlByPin,
  NHAN_HE_THONG, nguoiXacNhanSql,
  readyTuDongSql, khongReadyTuDongSql,
};
