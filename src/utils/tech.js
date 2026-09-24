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
// ⚠⚠⚠ CHỈ DÙNG Ở QUERY ĐÃ LỌC `trang_thai='DAT'`. Dòng CHƯA xác nhận cũng có `nguoi_xac_nhan_id`
//   NULL ⇒ áp vào danh sách chưa lọc sẽ hiện "Hệ thống (tự động)" cho mọi mục chưa ai đụng — sai nặng.
//   (`technical.getResults` CỐ Ý không dùng helper này vì nó trả cả mục chưa xác nhận.)
// ⚠⚠ NHẬN DIỆN = `ho_ten IS NULL`, KHÔNG dùng `ghi_chu` (đổi 10/09/2026). Chốt cũ *"bám `ghi_chu` để
//   không bịa nguồn gốc cho dòng cũ"* làm **350/770 dòng hiện Ô TRỐNG** — người đọc không phân biệt
//   được "chưa ai làm" với "hệ thống làm", đúng thứ cột này sinh ra để trả lời. Đo prod 10/09: trong
//   **770 dòng DAT có `nguoi_xac_nhan_id` NULL ở trạm READY, 0 dòng nào KHÔNG thuộc phần in có đợt vải
//   `kt_can_kiem_tra = false`** ⇒ NULL-người trên dòng DAT **luôn** là hệ thống tự đặt, không có ngoại lệ.
//   Cùng dấu hiệu mà `readyTuDongSql` bên dưới đang dùng ⇒ 2 chỗ nay nhất quán.
// ⚠ `kqAlias` GIỮ trong chữ ký (mọi call-site đang truyền đủ 2) — đừng bỏ, có thể cần lại khi `ghi_chu`
//   đã phủ hết dữ liệu và muốn phân biệt nhiều nguồn tự động khác nhau.
const NHAN_HE_THONG = 'Hệ thống (tự động)';
// eslint-disable-next-line no-unused-vars
const nguoiXacNhanSql = (ndAlias, kqAlias) =>
  `COALESCE(${ndAlias}.ho_ten, '${NHAN_HE_THONG}')`;

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

// ─────────────────────────────────────────────────────────────────────────────
// ⚠⚠⚠ "ĐÃ READY" LÀ THUỘC TÍNH CỦA **ĐỢT VẢI**, KHÔNG PHẢI CỦA PHẦN IN
// (người dùng chốt 16/09/2026 — "bây giờ là theo đợt vải, có đợt vải là vào lại READY").
//
// TRƯỚC ĐÂY cả 3 nơi đều hỏi "phần in đã QC chưa" (`ket_qua_checkpoint` khóa theo `phan_in_id`):
// màn READY (`OUTER_WHERE q.qc_done = false`), badge Đã/Chờ Ready ở Release 1, và `dotStageCase`.
// ⇒ Phần in có đợt 1 đã Ready đang chờ release, đợt 2 về sau thì **không tài nào** vừa ở READY (đợt 2)
//   vừa ở Release 1 với đợt 1 còn nguyên "Đã Ready" — hai đợt dùng CHUNG một trạng thái.
// Hệ quả thật trên prod: đợt 2 `KTCankiemtra=1` làm `erpsync.reopenReadyForPhanIn` **hủy READY của cả
// phần in** ⇒ đợt 1 đang chờ release tụt xuống "Chờ Ready", bấm xác nhận rơi vào Kế hoạch tạm.
//
// ⚠⚠ MỐC LÀ NGUỒN SỰ THẬT, KHÔNG CẦN MIGRATION: đợt vải được QC phủ khi nó LÊN READY TRƯỚC lúc QC
//   xác nhận. Cùng luật với nhánh (a) của `technical.service.dotDaXacNhan` (mig 098) cho Khuôn/Film/Mực
//   ⇒ 4 mục READY nay hiểu "theo đợt" y như nhau.
//   · Đợt về TRƯỚC mốc QC  → đã Ready (mọi dữ liệu cũ tự đúng — đo prod 16/09: 0/152 dòng Release 1 đổi
//     trạng thái khi áp luật này ⇒ SIÊU TẬP an toàn, không hàng nào đang chờ bị tụt).
//   · Đợt về SAU  mốc QC  → CHƯA Ready ⇒ phần in tự hiện lại ở READY mà KHÔNG phải hủy gì của đợt cũ.
// ⚠ `tg_xac_nhan` bị GHI ĐÈ mỗi lần xác nhận lại (kể cả `simulateReadyDone`) — đó chính là thứ ta cần:
//   mốc QC luôn là "lần duyệt READY gần nhất", nên QC duyệt lại là phủ hết mọi đợt đang chờ.
// ⚠ `COALESCE(tg_chuyen_ready, created_date)` cho dữ liệu cũ thiếu mốc vào READY (prod hiện 0 dòng).
// ⚠ Alias `zq`/`zc`/`zd`/`zl` đặt hiếm để không đụng alias của query lớn bọc ngoài.
// ⚠⚠⚠ MỞ RỘNG 21/09/2026 — "ĐỢT d ĐÃ XÁC NHẬN MỤC ma" CÓ 2 NHÁNH (gương `technical.service.dotDaXacNhan`):
//   (a) dòng TỔNG `ket_qua_checkpoint` DAT và đợt lên READY TRƯỚC mốc đó (luật mốc cũ); HOẶC
//   (b) dòng RIÊNG CỦA ĐỢT trong `ready_xac_nhan_dot` (mig 098) DAT, và dòng tổng KHÔNG bị HỦY sau mốc
//       `updated_date` của nó (mọi đường hủy ở mức phần in — trả về · hủy xác nhận — tự vô hiệu dòng đợt).
//   Nhánh (b) nay áp cho CẢ QC: QC xác nhận THEO ĐỢT (người dùng chốt 21/09/2026 — "đợt 1 KT xong mà QC
//   không xác nhận được vì đợt 2 KT chưa xác nhận"), và `erpsync.simulateReadyDone` ghi dòng theo ĐỢT
//   khi phần in còn đợt khác đang chờ (không thì mốc QC tổng = now() PHỦ LUÔN đợt 1 chưa ai làm — đúng
//   lỗi người dùng báo 18/09).
// ⚠ Alias `zq*`/`zx*`/`zk*` đặt hiếm để không đụng alias của query lớn bọc ngoài; mã checkpoint là hằng code.
// ⚠ `maLaBieuThuc = true` ⇒ `ma` được dùng NGUYÊN VĂN như một biểu thức SQL (vd cột `zcpm.ma` của một
//   `CROSS JOIN (VALUES ...)`) thay vì nội suy thành hằng chuỗi. Dùng khi cần cả 3 mục trong MỘT câu
//   mà chỉ viết biểu thức này ĐÚNG MỘT LẦN — biểu thức dài 653 ký tự, lặp 3 lần là câu SQL vượt
//   ngưỡng IPS (~1400) và bị reset kết nối (§9). Mặc định `false` ⇒ mọi call-site cũ không đổi.
const dotMucDatSql = (dvAlias, pinCol, ma, maLaBieuThuc = false) => `(EXISTS (SELECT 1 FROM ket_qua_checkpoint zq
  JOIN checkpoint zc ON zc.id = zq.checkpoint_id AND zc.ma_checkpoint = ${maLaBieuThuc ? ma : `'${ma}'`}
  WHERE zq.phan_in_id = ${pinCol} AND zq.trang_thai = 'DAT'
    AND COALESCE(zq.tg_xac_nhan, zq.updated_date) >= COALESCE(${dvAlias}.tg_chuyen_ready, ${dvAlias}.created_date))
 OR EXISTS (SELECT 1 FROM ready_xac_nhan_dot zx
  JOIN checkpoint zxc ON zxc.id = zx.checkpoint_id AND zxc.ma_checkpoint = ${maLaBieuThuc ? ma : `'${ma}'`}
  WHERE zx.dot_vai_ve_id = ${dvAlias}.id AND zx.trang_thai = 'DAT'
    AND NOT EXISTS (SELECT 1 FROM ket_qua_checkpoint zk WHERE zk.phan_in_id = ${pinCol}
                    AND zk.checkpoint_id = zx.checkpoint_id AND zk.trang_thai = 'HUY'
                    AND zk.updated_date > zx.updated_date)))`;

const qcDotSql = (dvAlias, pinCol) => dotMucDatSql(dvAlias, pinCol, 'QC_XAC_NHAN');

// MỐC (timestamptz) đợt d xác nhận mục `ma` — cùng 2 nhánh với `dotMucDatSql`, trả NULL nếu chưa.
// Lấy mốc SỚM NHẤT của 2 nhánh (LEAST bỏ qua NULL). Dùng để ĐO THỜI GIAN theo từng đợt vải
// (Dashboard › Thời gian trạm), KHÔNG dùng để quyết định trạng thái — việc đó vẫn là `dotMucDatSql`.
// ⚠ Nhánh (a) đọc dòng TỔNG: `tg_xac_nhan` bị ghi đè mỗi lần xác nhận lại ⇒ với đợt cũ mốc có thể
//   muộn hơn thực tế (giới hạn đã biết của mô hình mức phần in, DATABASE.md §11.3).
const mocDotMucSql = (dvAlias, pinCol, ma) => `LEAST(
  (SELECT max(COALESCE(zq.tg_xac_nhan, zq.updated_date)) FROM ket_qua_checkpoint zq
     JOIN checkpoint zc ON zc.id = zq.checkpoint_id AND zc.ma_checkpoint = '${ma}'
    WHERE zq.phan_in_id = ${pinCol} AND zq.trang_thai = 'DAT'
      AND COALESCE(zq.tg_xac_nhan, zq.updated_date) >= COALESCE(${dvAlias}.tg_chuyen_ready, ${dvAlias}.created_date)),
  (SELECT min(COALESCE(zx.tg_xac_nhan, zx.updated_date)) FROM ready_xac_nhan_dot zx
     JOIN checkpoint zxc ON zxc.id = zx.checkpoint_id AND zxc.ma_checkpoint = '${ma}'
    WHERE zx.dot_vai_ve_id = ${dvAlias}.id AND zx.trang_thai = 'DAT'
      AND NOT EXISTS (SELECT 1 FROM ket_qua_checkpoint zk WHERE zk.phan_in_id = ${pinCol}
                      AND zk.checkpoint_id = zx.checkpoint_id AND zk.trang_thai = 'HUY'
                      AND zk.updated_date > zx.updated_date)))`;

// Đợt đã xong KỸ THUẬT (Mực + Khuôn; khách gia công II/AD chỉ cần Mực) — gương `techDoneNhom` ở service.
// `khachExpr` = biểu thức tên khách của phần in (vd `kh.ten_khach_hang`).
const ktDotXongSql = (dvAlias, pinCol, khachExpr) => `(${dotMucDatSql(dvAlias, pinCol, 'MUC')}
  AND ((${khachExpr}) IN (${KHUON_OPT_SQL_LIST}) OR ${dotMucDatSql(dvAlias, pinCol, 'KHUON')}))`;

// Phần in CÒN đợt vải đang chờ ở READY (đã lên READY, CHƯA release) mà CHƯA được QC phủ?
// Đây là điều kiện "còn việc ở READY" thay cho `qc_done = false` mức phần in.
// ⚠ Gương y hệt `dsDotChoReady` (technical.repository) — 2 chỗ lệch nhau là bảng và danh sách quét đá nhau.
const conDotChuaReadySql = (pinCol) => `EXISTS (SELECT 1 FROM dot_vai_ve zd
  WHERE zd.phan_in_id = ${pinCol} AND zd.trang_thai NOT IN ('DA_GOP','DA_HUY') AND zd.tg_chuyen_ready IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai zl JOIN lenh_san_xuat zls ON zls.id = zl.lenh_san_xuat_id
                     WHERE zl.dot_vai_ve_id = zd.id AND zls.trang_thai <> 'HUY')
    AND NOT ${qcDotSql('zd', pinCol)})`;

// ⚠⚠ HÀNG ĐỢI CỦA QC = đợt vải đang chờ (chưa release) mà KỸ THUẬT ĐÃ XONG nhưng QC CHƯA xác nhận.
// ⚠⚠⚠ CHỈ DÙNG CHO DẢI "THEO DÕI" (`utils/siSoTram.js` `DV.READY_QC`) — **KHÔNG dùng lọc BẢNG của màn
//   QC** (đảo lại 23/09/2026). Bản 21/09 áp cho cả `technical.listCandidates` ⇒ bảng tụt từ 105 phần in
//   xuống ~5, QC không còn gì để xem. Người dùng chốt: danh sách giữ như cũ (thấy cả phần in KT chưa
//   xong, chỉ không bấm xác nhận được), việc "chỉ tính khi KT xong" là của SĨ SỐ.
//   ⇒ Số trên dải Theo dõi NHỎ HƠN số dòng bảng là CỐ Ý — xem CLAUDE.md §6 *Chuẩn bị kỹ thuật*.
const dotChoReadySql = (alias, pinCol) => `${alias}.phan_in_id = ${pinCol} AND ${alias}.trang_thai NOT IN ('DA_GOP','DA_HUY')
    AND ${alias}.tg_chuyen_ready IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai zl2 JOIN lenh_san_xuat zls2 ON zls2.id = zl2.lenh_san_xuat_id
                     WHERE zl2.dot_vai_ve_id = ${alias}.id AND zls2.trang_thai <> 'HUY')`;
const conDotChoQcSql = (pinCol, khachExpr) => `EXISTS (SELECT 1 FROM dot_vai_ve zdq
  WHERE ${dotChoReadySql('zdq', pinCol)} AND NOT ${qcDotSql('zdq', pinCol)} AND ${ktDotXongSql('zdq', pinCol, khachExpr)})`;
// Còn đợt vải đang chờ mà KỸ THUẬT CHƯA xong (việc của màn KT).
const conDotChuaKtSql = (pinCol, khachExpr) => `EXISTS (SELECT 1 FROM dot_vai_ve zdk
  WHERE ${dotChoReadySql('zdk', pinCol)} AND NOT ${qcDotSql('zdk', pinCol)} AND NOT ${ktDotXongSql('zdk', pinCol, khachExpr)})`;

module.exports = {
  KHUON_OPTIONAL_KH, KHUON_OPT_SQL_LIST, isKhuonOptional, laHangGiaCong,
  requiredTechItems, hienFilm, techDoneSql, techDoneSqlByPin,
  NHAN_HE_THONG, nguoiXacNhanSql,
  readyTuDongSql, khongReadyTuDongSql,
  dotMucDatSql, mocDotMucSql, qcDotSql, ktDotXongSql, conDotChuaReadySql, conDotChoQcSql, conDotChuaKtSql,
};
