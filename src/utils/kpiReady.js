'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// KPI READY — nguồn luật DUY NHẤT cho trang *Dashboard → KPI READY* (mig 093).
//
// Trang trả lời 5 câu hỏi của quản lý trên PHẠM VI ĐƠN HÀNG ĐƯỢC CHỌN (bảng `kpi_don_hang`,
// tích ở *Hệ thống → Chọn đơn hàng (KPI)*), kèm bảng theo dõi từng phần in qua 23 cột checklist.
//
// ⚠⚠ DANH MỤC CỘT Ở CODE (`COT_KPI`), KHÔNG ở DB — cùng khuôn `TRANG_PAIN` (mig 067) /
//   `VI_TRI_IN` (mig 073) / `LOAI_TB` (mig 085) ⇒ thêm/bớt/đổi thứ tự cột **không cần migration**.
//
// ⚠⚠ OWNER TỪNG CỘT DÙNG LẠI `tram_owner` / `checkpoint_owner` (trang *Hệ thống → Owner
//   checkpoint/checklist* đã có sẵn). Mỗi cột khai `tram` HOẶC `checkpoint`; gán owner ở trang đó
//   là dòng 2 của bảng KPI tự hiện tên. **Đừng làm bảng owner riêng** — nhà máy sẽ phải gán ở hai
//   nơi và sớm muộn hai nơi lệch nhau.
//   ⚠ Nhiều cột trỏ CÙNG một trạm (3 cột nhóm KCS đều trỏ `KIEM`) ⇒ hiện CÙNG một owner. Đúng
//     nghiệp vụ: một người chịu trách nhiệm cả cụm.
//
// ⚠⚠⚠ GIỚI HẠN ĐÃ BIẾT — `tem` KHÔNG lưu `phan_in_id`/`dot_vai_ve_id` (DATABASE.md §4).
//   Với lệnh **GOM SET** (prod còn 247 lệnh cũ, từ 15/08/2026 không sinh thêm), MỌI tem của lệnh
//   được quy về **PHẦN IN ĐẠI DIỆN** (`ma_phan` nhỏ nhất) — CTE `lenh_pin` dưới đây. Đây đúng là
//   cách dashboard "SL in", KCS/Sửa/OQC/Giao, hành trình và báo cáo `DS_TEM` đang làm, nên tổng
//   KHÔNG bị đếm đôi; đổi lại, phần in anh em trong cùng lệnh gom set hiện 0 ở các cột số lượng.
//   Muốn tách đúng phải thêm cột `tem.dot_vai_ve_id`.
//
// ⚠⚠ TEM CON (tem 17 — sửa đạt, mig 091) mang `so_luong = 0` và `sl_kcs_dat` = SL sửa đạt.
//   ⇒ Mọi tổng thuộc nhóm **KCS/Sửa** phải lọc `t.tem_goc_id IS NULL` (chỉ tem GỐC), nếu không
//   phần sửa đạt bị cộng HAI LẦN (một lần ở `sl_sua_dat` của tem gốc, một lần ở `sl_kcs_dat` của
//   tem con). Nhóm **OQC/Giao** thì tính CẢ tem con — số lượng hàng sửa đạt nằm ở đó.
//
// ⚠ SQL ở đây được repository gửi **gộp 1 dòng** (`.replace(/\s+/g,' ')`, tránh IPS reset)
//   ⇒ TUYỆT ĐỐI không viết comment `-- …` bên trong chuỗi SQL; chú thích để ngoài như file này.
//
// ⚠ CỐ Ý KHÔNG áp `dkTrang()` (*Hiển thị theo phương án in*, mig 067): đây là màn SOI SỐ LIỆU —
//   lọc ngầm ở đây thì hàng bị ẩn mà không để lại dấu vết nào, đúng họ sự cố "phần in biến mất"
//   đã ghi ở CLAUDE.md §5. Cùng lý do với *Quản trị phần in* và *Hủy lệnh xác nhận*.
// ─────────────────────────────────────────────────────────────────────────────

const VN = "AT TIME ZONE 'Asia/Ho_Chi_Minh'";

// ─── 23 CỘT CHECKLIST ────────────────────────────────────────────────────────
// `nhom`:
//   'moc' → giá trị là MỐC THỜI GIAN (đã qua bước đó lúc nào). Chế độ *theo đơn* hiện "x/N".
//   'so'  → số lượng (pcs). Chế độ *theo đơn* CỘNG lại.
//   'pt'  → phần trăm, TÍNH LẠI từ các cột số (không bao giờ cộng/trung bình cộng % của con).
// `tram` / `checkpoint` → khóa tra owner (`tram.ma_tram` / `checkpoint.ma_checkpoint` của workflow
//   đang hiện hành). Cột không khai gì thì dòng owner để trống.
// `col` → tên cột trong kết quả SQL.
//
// ⚠⚠ `tgTu` = CHUỖI MỐC NGUỒN để tính **cột thời gian** đứng ngay cạnh cột mốc (20/09/2026, người
//   dùng chốt "mốc cột này − mốc bước liền trước"): lấy mốc nguồn ĐẦU TIÊN có giá trị trong danh
//   sách, thời gian = `mốc cột này − mốc nguồn` ⇒ "phần in nằm ở bước đó bao lâu".
//   · Chỉ cột `nhom: 'moc'` mới có — cột SỐ LƯỢNG và cột % không có mốc nên không có thời gian.
//   · Cột `vai` CỐ Ý không khai: nó là điểm BẮT ĐẦU của cả dòng chảy, không có bước nào trước.
//   ⚠ Chuỗi nguồn theo **NGHIỆP VỤ**, KHÔNG phải cột liền trước trong bảng: Film/Khuôn/Mực chạy SONG
//     SONG sau HSKT nên cả ba đều đo từ `moc_hskt` (lấy "cột liền trước" sẽ ra Mực − Khuôn, có thể ÂM).
//   ⚠ Nhánh lùi là bắt buộc: HSKT có thể trống (ERP không gửi `BarcodeHKT`), lệnh ĐI TẮT Test Run thì
//     `moc_test_run` trống ⇒ Release 2 phải lùi về `moc_release_1`, nếu không cột thời gian rỗng
//     đúng ở nhóm hàng chạy nhanh nhất.
//   ⚠ `moc_kt_xong` KHÔNG phải cột hiển thị — là mốc kỹ thuật xác nhận xong mục CUỐI CÙNG
//     (`GREATEST(film, khuôn, mực)`), sinh trong `CAU_CHINH` chỉ để làm mẫu số cho QA ready.
const COT_KPI = [
  { ma: 'vai', ten: 'Vải', nhom: 'moc', col: 'moc_vai', tram: 'PIPELINE',
    ghiChu: 'Phần in lên MES (có đợt vải đầu tiên)' },
  { ma: 'hskt', ten: 'HSKT', nhom: 'moc', col: 'moc_hskt', checkpoint: 'HSKT', tgTu: ['moc_vai'],
    ghiChu: 'Hồ sơ kỹ thuật được tạo trên MES' },
  { ma: 'film', ten: 'Film', nhom: 'moc', col: 'moc_film', checkpoint: 'FILM', tgTu: ['moc_hskt', 'moc_vai'],
    ghiChu: 'Xác nhận Film (tự đạt theo Khuôn)' },
  { ma: 'khuon', ten: 'Khuôn', nhom: 'moc', col: 'moc_khuon', checkpoint: 'KHUON', tgTu: ['moc_hskt', 'moc_vai'],
    ghiChu: 'Xác nhận Khuôn' },
  { ma: 'muc', ten: 'Mực', nhom: 'moc', col: 'moc_muc', checkpoint: 'MUC', tgTu: ['moc_hskt', 'moc_vai'],
    ghiChu: 'Xác nhận Mực' },
  { ma: 'qa_ready', ten: 'QA ready', nhom: 'moc', col: 'moc_qa_ready', checkpoint: 'QC_XAC_NHAN',
    tgTu: ['moc_kt_xong', 'moc_hskt', 'moc_vai'],
    ghiChu: 'IQC/QA xác nhận READY' },
  { ma: 'release_1', ten: 'Release 1', nhom: 'moc', col: 'moc_release_1', tram: 'RELEASE_1',
    tgTu: ['moc_qa_ready', 'moc_kt_xong', 'moc_vai'],
    ghiChu: 'Lệnh sản xuất đầu tiên được tạo' },
  { ma: 'test_run', ten: 'Test run', nhom: 'moc', col: 'moc_test_run', tram: 'TEST_RUN',
    tgTu: ['moc_release_1'],
    ghiChu: 'QA xác nhận test đạt' },
  { ma: 'release_2', ten: 'Release 2', nhom: 'moc', col: 'moc_release_2', tram: 'RELEASE_2',
    tgTu: ['moc_test_run', 'moc_release_1'],
    ghiChu: 'Lệnh rời chặng Release 1 (được duyệt / đi tắt)' },
  { ma: 'sl_in', ten: 'SL in', nhom: 'so', col: 'sl_in', tram: 'SAN_XUAT',
    ghiChu: 'Σ số lượng trên tem đã in' },
  { ma: 'sl_kiem', ten: 'SL kiểm', nhom: 'so', col: 'sl_kiem', tram: 'KIEM',
    ghiChu: 'Σ đã kiểm = đạt + hư + hủy' },
  { ma: 'sl_kiem_dat', ten: 'SL kiểm đạt', nhom: 'so', col: 'sl_kiem_dat', tram: 'KIEM',
    ghiChu: 'Σ KCS đạt' },
  { ma: 'sl_huy', ten: 'SL hủy', nhom: 'so', col: 'sl_huy', tram: 'KIEM',
    ghiChu: 'Σ hủy thẳng ở KCS' },
  { ma: 'sl_sua', ten: 'SL sửa', nhom: 'so', col: 'sl_sua', tram: 'SUA',
    ghiChu: 'Σ hàng hư chuyển sửa' },
  { ma: 'sl_sua_dat', ten: 'SL sửa đạt', nhom: 'so', col: 'sl_sua_dat', tram: 'SUA',
    ghiChu: 'Σ sửa xong đạt' },
  { ma: 'sl_sua_huy', ten: 'SL sửa hủy', nhom: 'so', col: 'sl_sua_huy', tram: 'SUA',
    ghiChu: 'Σ sửa không cứu được' },
  { ma: 'tong_dat', ten: 'Tổng đạt', nhom: 'so', col: 'tong_dat', tram: 'OQC',
    ghiChu: 'SL kiểm đạt + SL sửa đạt' },
  { ma: 'pt_dat', ten: '% đạt', nhom: 'pt', tuSo: 'sl_kiem_dat', mauSo: 'sl_in', tram: 'KIEM',
    ghiChu: 'SL kiểm đạt / SL in' },
  { ma: 'pt_dat_sau_sua', ten: '% đạt sau sửa', nhom: 'pt', tuSo: 'tong_dat', mauSo: 'sl_in', tram: 'SUA',
    ghiChu: '(SL kiểm đạt + SL sửa đạt) / SL in' },
  { ma: 'tong_huy', ten: 'Tổng hủy', nhom: 'so', col: 'tong_huy', tram: 'KIEM',
    ghiChu: 'SL hủy (KCS) + SL sửa hủy' },
  { ma: 'finish', ten: 'Finish', nhom: 'moc', col: 'moc_finish', tram: 'FINISH',
    tgTu: ['moc_release_2', 'moc_test_run', 'moc_release_1'],
    ghiChu: 'Hết hàng chờ ở KCS/Sửa/OQC và tổng đạt ≥ SLĐH' },
  { ma: 'sl_giao', ten: 'SL giao', nhom: 'so', col: 'sl_giao', tram: 'DONE_DELIVERY',
    ghiChu: 'Σ số lượng đã giao' },
  { ma: 'done_delivery', ten: 'Done Delivery', nhom: 'moc', col: 'moc_done_delivery', tram: 'DONE_DELIVERY',
    tgTu: ['moc_finish', 'moc_release_2'],
    ghiChu: 'Phiếu giao đầu tiên được lập' },
];

// ─── CỘT BÊN TRÁI CÓ OWNER RIÊNG ─────────────────────────────────────────────
// Bảng KPI có khối cột TRÁI (thông tin phần in) do FE khai; phần lớn không cần owner. Cột nào cần
// thì khai ở đây để (a) trang *Hệ thống → Owner checkpoint/checklist* bày ra mà gán, (b) dòng 2 của
// bảng KPI hiện tên.
//
// ⚠⚠⚠ "ĐỢT VẢI" CÓ OWNER RIÊNG, **KHÁC** CỘT "VẢI" (người dùng chốt 10/09/2026 — *"cái này khác với
//   vải nha"*): cột `vai` là mốc **PHẦN IN lên MES** (trạm `PIPELINE`), còn cột `dot_vai` là **ngày
//   về của TỪNG đợt vải**. Hai việc khác nhau, người phụ trách khác nhau ⇒ neo vào **checklist
//   `DOT_VAI`** (mig 097, nằm trong trạm PIPELINE) chứ KHÔNG mượn owner của trạm.
// ⚠⚠ `DOT_VAI` chỉ là KHÓA GÁN OWNER — **KHÔNG phải mục cần xác nhận**, `bat_buoc = false`, không có
//   màn nhập liệu nào (MES bắt đầu từ READY). Đừng viết code tạo `ket_qua_checkpoint` cho mã này.
// ⚠ Chưa chạy mig 097 ⇒ `dich_id` null ⇒ trang Owner hiện dòng nhưng chưa bấm gán được, bảng KPI hiện
//   "— chưa gán —". KHÔNG sập ở đâu.
const COT_TRAI_OWNER = [
  { ma: 'dot_vai', ten: 'Đợt vải', checkpoint: 'DOT_VAI',
    ghiChu: 'Ngày vải về của TỪNG đợt (cột bên trái, chỉ hiện ở chế độ Chi tiết)' },
];

// ─── BỘ LỌC NGÀY ─────────────────────────────────────────────────────────────
// ⚠ Whitelist CỨNG — giá trị client chỉ dùng để TRA khóa, không bao giờ nội suy vào SQL.
// ⚠ `kieu`: 'ts' = timestamptz (phải quy về giờ VN trước khi cắt ngày) · 'date' = cột DATE sẵn.
//   Cắt ngày trên timestamptz mà quên `AT TIME ZONE` thì mốc trước 07:00 sáng bị LÙI 1 NGÀY
//   (giờ VN = UTC+7) — cùng bẫy đã ghi ở CLAUDE.md §6.
const LOAI_NGAY = {
  TG_LEN_MES: { ten: 'Ngày lên MES', col: 'q.moc_vai', kieu: 'ts' },
  NGAY_VAI_VE: { ten: 'Ngày nhận vải', col: 'q.ngay_vai_ve', kieu: 'date' },
  QA_READY: { ten: 'Ngày QA ready', col: 'q.moc_qa_ready', kieu: 'ts' },
  RELEASE_1: { ten: 'Ngày Release 1', col: 'q.moc_release_1', kieu: 'ts' },
  HAN_GIAO: { ten: 'Hạn giao hàng', col: 'q.han_giao_hang', kieu: 'date' },
};

// ─── CÁC KHỐI SQL ────────────────────────────────────────────────────────────
// ⚠ MỌI CTE ĐỀU THU HẸP VỀ `pin_sel` (phần in của các đơn đang xét) ngay từ đầu, thay vì quét
//   toàn bảng rồi mới JOIN. Hiện các bảng còn nhỏ nên chưa khác biệt, nhưng đây là màn người dùng
//   bấm đi bấm lại và phạm vi đơn hàng sẽ dài ra theo thời gian.

// Phần in trong phạm vi. $1 = mảng uuid đơn hàng.
const PIN_SEL = `pin_sel AS (
  SELECT pin.id
    FROM phan_in pin
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
   WHERE pin.dang_hoat_dong AND dh.id = ANY($1::uuid[]))`;

// Lệnh → PHẦN IN ĐẠI DIỆN. Xem cảnh báo "GIỚI HẠN ĐÃ BIẾT" ở đầu file.
// ⚠ `DISTINCT ON (ls.id)` + `ORDER BY ls.id, pin.ma_phan` ⇒ mỗi lệnh đúng 1 phần in, chọn theo
//   `ma_phan` nhỏ nhất — CÙNG quy tắc `PHAN_INFO_LATERAL` của planning/quality, để 2 nơi không lệch.
// ⚠⚠ HAI BƯỚC, ĐỪNG GỘP: `lenh_lq` lọc ra các lệnh CÓ LIÊN QUAN tới phạm vi, còn việc CHỌN đại
//   diện thì phải xét **MỌI phần in của lệnh** (kể cả phần in ngoài phạm vi). Lọc thẳng `pin_sel`
//   vào bước chọn sẽ ra đại diện KHÁC với phần còn lại của hệ thống ⇒ số lượng nhảy chỗ khi người
//   dùng đổi danh sách đơn hàng.
const LENH_PIN = `lenh_lq AS (
  SELECT DISTINCT ls.id
    FROM lenh_san_xuat ls
    JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
    JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
    JOIN pin_sel ps ON ps.id = dv.phan_in_id
   WHERE ls.trang_thai <> 'HUY'),
lenh_pin AS (
  SELECT DISTINCT ON (ls.id) ls.id AS lenh_id, pin.id AS phan_in_id
    FROM lenh_lq ll
    JOIN lenh_san_xuat ls ON ls.id = ll.id
    JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
    JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id AND dv.trang_thai NOT IN ('DA_GOP','DA_HUY')
    JOIN phan_in pin ON pin.id = dv.phan_in_id AND pin.dang_hoat_dong
   ORDER BY ls.id, pin.ma_phan)`;

// Mốc 4 mục READY. `trang_thai='DAT'` là bắt buộc — dòng chưa xác nhận vẫn tồn tại trong bảng.
const READY = `rdy AS (
  SELECT k.phan_in_id,
         max(k.tg_xac_nhan) FILTER (WHERE c.ma_checkpoint = 'FILM')        AS moc_film,
         max(k.tg_xac_nhan) FILTER (WHERE c.ma_checkpoint = 'KHUON')       AS moc_khuon,
         max(k.tg_xac_nhan) FILTER (WHERE c.ma_checkpoint = 'MUC')         AS moc_muc,
         max(k.tg_xac_nhan) FILTER (WHERE c.ma_checkpoint = 'QC_XAC_NHAN') AS moc_qa_ready
    FROM ket_qua_checkpoint k
    JOIN pin_sel ps ON ps.id = k.phan_in_id
    JOIN checkpoint c ON c.id = k.checkpoint_id
   WHERE k.trang_thai = 'DAT'
     AND c.ma_checkpoint IN ('FILM','KHUON','MUC','QC_XAC_NHAN')
   GROUP BY k.phan_in_id)`;

// Đợt vải: mốc "có vải trên MES" + SLNV + hạn giao. Loại đợt đã gộp/đã hủy.
const DOT_VAI = `dvs AS (
  SELECT dv.phan_in_id,
         min(dv.created_date) AS moc_vai, min(dv.ngay_vai_ve) AS ngay_vai_ve,
         min(dv.han_giao_hang) AS han_giao_hang,
         COALESCE(sum(dv.so_luong_vai_ve), 0)::int AS so_luong_vai_ve,
         count(*)::int AS so_dot_vai
    FROM dot_vai_ve dv
    JOIN pin_sel ps ON ps.id = dv.phan_in_id
   WHERE dv.trang_thai NOT IN ('DA_GOP','DA_HUY')
   GROUP BY dv.phan_in_id)`;

// HSKT: mốc lấy PHIÊN BẢN ĐẦU TIÊN của cả chuỗi (đổi phương án in sinh bản mới — DATABASE.md §3).
const HSKT = `hs AS (
  SELECT hp.phan_in_id, min(h.created_date) AS moc_hskt
    FROM hskt_phan_in hp
    JOIN pin_sel ps ON ps.id = hp.phan_in_id
    JOIN ho_so_ky_thuat h ON h.id = hp.hskt_id
   GROUP BY hp.phan_in_id)`;

// Mốc Release 1 / Test Run / Release 2 (mức LỆNH, gom về phần in).
// ⚠ `moc_release_2` gương `MOC_ROI_R1` của `utils/siSoTram.js`: lệnh ĐI TẮT Test Run không có
//   `TEST_QA` và lệnh cũ không có audit `RELEASE_2` ⇒ phải lùi về `created_date`, nếu không cột
//   Release 2 trống trơn ở phần lớn hàng.
const LENH = `ln AS (
  SELECT dv.phan_in_id,
         min(ls.created_date) AS moc_release_1,
         max(tq.moc_qa)       AS moc_test_run,
         min(CASE WHEN ls.trang_thai <> 'RELEASE_1' THEN COALESCE(
               (SELECT max(a.thoi_gian) FROM audit_log a
                 WHERE a.ten_bang = 'lenh_san_xuat' AND a.id_ban_ghi = ls.id::text
                   AND a.hanh_dong = 'RELEASE_2'),
               GREATEST(tq.moc_qa, ls.created_date)) END) AS moc_release_2,
         count(DISTINCT ls.id)::int AS so_lenh
    FROM lenh_lq ll
    JOIN lenh_san_xuat ls ON ls.id = ll.id
    JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
    JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id AND dv.trang_thai NOT IN ('DA_GOP','DA_HUY')
    JOIN pin_sel ps ON ps.id = dv.phan_in_id
    LEFT JOIN LATERAL (SELECT max(k.tg_xac_nhan) AS moc_qa
        FROM ket_qua_checkpoint k JOIN checkpoint c ON c.id = k.checkpoint_id
       WHERE k.lenh_san_xuat_id = ls.id AND k.trang_thai = 'DAT'
         AND c.ma_checkpoint = 'TEST_QA') tq ON true
   GROUP BY dv.phan_in_id)`;

// Số lượng theo SỔ CÁI TEM. Xem 2 cảnh báo ở đầu file (gom set + tem con).
const TEM = `tm AS (
  SELECT lp.phan_in_id,
         COALESCE(sum(t.so_luong)   FILTER (WHERE t.tem_goc_id IS NULL), 0)::int AS sl_in,
         COALESCE(sum(COALESCE(t.sl_kcs_dat,0) + COALESCE(t.sl_kcs_sua,0) + COALESCE(t.sl_kcs_huy,0))
                  FILTER (WHERE t.tem_goc_id IS NULL), 0)::int AS sl_kiem,
         COALESCE(sum(t.sl_kcs_dat) FILTER (WHERE t.tem_goc_id IS NULL), 0)::int AS sl_kiem_dat,
         COALESCE(sum(t.sl_kcs_huy) FILTER (WHERE t.tem_goc_id IS NULL), 0)::int AS sl_huy,
         COALESCE(sum(t.sl_kcs_sua) FILTER (WHERE t.tem_goc_id IS NULL), 0)::int AS sl_sua,
         COALESCE(sum(t.sl_sua_dat) FILTER (WHERE t.tem_goc_id IS NULL), 0)::int AS sl_sua_dat,
         COALESCE(sum(t.sl_sua_huy) FILTER (WHERE t.tem_goc_id IS NULL), 0)::int AS sl_sua_huy,
         COALESCE(sum(t.sl_oqc_dat), 0)::int AS sl_oqc_dat,
         COALESCE(sum(t.sl_da_giao), 0)::int AS sl_giao,
         COALESCE(sum(GREATEST((COALESCE(t.so_luong,0) + COALESCE(t.sl_chenh_lech,0))
              - (COALESCE(t.sl_kcs_dat,0) + COALESCE(t.sl_kcs_sua,0) + COALESCE(t.sl_kcs_huy,0)), 0)), 0)::int AS con_kcs,
         COALESCE(sum(COALESCE(t.sl_kcs_sua,0)
              - (COALESCE(t.sl_sua_dat,0) + COALESCE(t.sl_sua_huy,0))), 0)::int AS con_sua,
         COALESCE(sum((COALESCE(t.sl_kcs_dat,0) + COALESCE(t.sl_sua_dat,0) - COALESCE(t.sl_sua_tach,0))
              - COALESCE(t.sl_oqc_dat,0)), 0)::int AS con_oqc,
         COALESCE(sum(COALESCE(t.sl_oqc_dat,0) - COALESCE(t.sl_da_giao,0)), 0)::int AS con_giao,
         count(*) FILTER (WHERE t.tem_goc_id IS NULL)::int AS so_tem
    FROM tem t
    JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id AND ps.trang_thai <> 'HUY'
    JOIN lenh_pin lp ON lp.lenh_id = ps.lenh_san_xuat_id
   WHERE t.trang_thai <> 'HUY'
   GROUP BY lp.phan_in_id)`;

// Mốc OQC cuối (cho cột Finish) + mốc phiếu giao đầu tiên (cho cột Done Delivery).
// ⚠ HAI subquery vô hướng RIÊNG, KHÔNG `LEFT JOIN oqc` + `LEFT JOIN giao_hang_tem` cùng lúc:
//   join cả hai vào `tem` sinh TÍCH ĐỀ-CÁC (1 tem có 3 lượt OQC × 2 lần giao = 6 dòng). Ở đây
//   `min`/`max` vẫn ra đúng nên KHÔNG lộ ra thành lỗi — nhưng chỉ cần mai mốt thêm một `sum` nào
//   vào CTE này là số nhân lên im lặng. Tách sẵn cho khỏi vấp.
const OQC_GIAO = `og AS (
  SELECT lp.phan_in_id,
         max((SELECT max(o.created_date) FROM oqc o WHERE o.tem_id = t.id)) AS moc_oqc_cuoi,
         min((SELECT min(gh.created_date) FROM giao_hang_tem ght
               JOIN giao_hang gh ON gh.id = ght.giao_hang_id
              WHERE ght.tem_id = t.id)) AS moc_phieu_giao
    FROM tem t
    JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id AND ps.trang_thai <> 'HUY'
    JOIN lenh_pin lp ON lp.lenh_id = ps.lenh_san_xuat_id
   WHERE t.trang_thai <> 'HUY'
   GROUP BY lp.phan_in_id)`;

// ─── SỐ LẦN TRẢ VỀ (rework) ──────────────────────────────────────────────────
// ⚠⚠ CỐ Ý BỎ `loai = 'TEST_RUN'` (mức ĐỢT VẢI): mỗi lần QA trả về Test Run ghi **2 dòng** —
//   `TEST_RUN` (đợt vải) + `TEST_RUN_KT` (phần in, kèm checklist rớt) — cùng MỘT sự kiện.
//   Đếm cả hai là gấp đôi số lần rework của chặng Test Run. Nhánh `phan_in_id` đã bắt `TEST_RUN_KT`.
// ⚠ 3 nhánh UNION phủ đủ 3 mức khóa mà `qc_tra_ve` dùng: phần in · tem (OQC/OQC_SUA) ·
//   lệnh (OQC_GIA_CONG). Xem DATABASE.md §5.
const TRA_VE = `tv AS (
  SELECT z.phan_in_id, count(*)::int AS so_lan_tra_ve, max(z.created_date) AS moc_tra_ve_cuoi
    FROM (
      SELECT q.phan_in_id, q.created_date FROM qc_tra_ve q
        JOIN pin_sel ps ON ps.id = q.phan_in_id
      UNION ALL
      SELECT lp.phan_in_id, q.created_date FROM qc_tra_ve q
        JOIN tem t2 ON t2.id = q.tem_id
        JOIN phieu_san_xuat ps2 ON ps2.id = t2.phieu_san_xuat_id
        JOIN lenh_pin lp ON lp.lenh_id = ps2.lenh_san_xuat_id
       WHERE q.tem_id IS NOT NULL
      UNION ALL
      SELECT lp.phan_in_id, q.created_date FROM qc_tra_ve q
        JOIN lenh_pin lp ON lp.lenh_id = q.lenh_san_xuat_id
       WHERE q.lenh_san_xuat_id IS NOT NULL
    ) z
   WHERE z.phan_in_id IS NOT NULL
   GROUP BY z.phan_in_id)`;

// ─── SỐ LẦN ĐỔI PHƯƠNG ÁN IN (KPI 5) ─────────────────────────────────────────
// ⚠⚠ CHỈ ĐẾM LẦN ĐỔI **DO NGƯỜI** (`nguoi_id IS NOT NULL`). Đo prod 07/09/2026: 5.523/5.795 dòng
//   `DOI_PHUONG_AN_IN` là do HỆ THỐNG tự đổi (post-pass "luật sản lượng" + di chứng vòng lặp Pain
//   04–05/08/2026) — tính vào thì gần như phần in nào cũng "bất thường" và KPI vô nghĩa.
// ⚠⚠ DÒNG DO NGƯỜI CÓ `phan_in_id = NULL` (272/272 dòng, đo prod) — nó ghi ở mức HỒ SƠ ⇒ **BẮT BUỘC
//   đi vòng qua `hskt_phan_in`**, đọc thẳng `l.phan_in_id` sẽ ra 0 và KPI luôn bằng 0%.
// ⚠ KHÔNG lọc `hp.dang_hoat_dong`: đổi phương án in tạo HSKT phiên bản mới và **relink** junction,
//   lọc active sẽ mất dấu các lần đổi trước đó.
const DOI_PA = `pa AS (
  SELECT hp.phan_in_id, count(*)::int AS so_lan_doi_pa
    FROM lich_su_hskt l
    JOIN hskt_phan_in hp ON hp.hskt_id = l.hskt_id
    JOIN pin_sel ps ON ps.id = hp.phan_in_id
   WHERE l.hanh_dong = 'DOI_PHUONG_AN_IN' AND l.nguoi_id IS NOT NULL
   GROUP BY hp.phan_in_id)`;

// ─── CÂU CHÍNH ───────────────────────────────────────────────────────────────
// 1 dòng / PHẦN IN. Tham số: $1 = mảng uuid đơn hàng (phạm vi KPI).
// ⚠ Bộ lọc ngày/tìm kiếm nối thêm ở repository (dải tham số bắt đầu từ $2).
//
// `moc_finish` — "đạt chất lượng + đủ số lượng": hết hàng chờ ở KCS/Sửa/OQC, có hàng đã OQC đạt,
//   và tổng đạt ≥ SLĐH. Mốc = lượt OQC cuối cùng.
// ⚠ `so_luong_don_hang` có thể NULL/0 (phần in chưa có SLĐH) ⇒ `COALESCE(...,0)` để điều kiện
//   "đủ số lượng" không bao giờ trả NULL (NULL sẽ làm CASE rơi vào ELSE, cột trống mà không rõ vì sao).
const CAU_CHINH = `WITH ${PIN_SEL}, ${LENH_PIN}, ${READY}, ${DOT_VAI}, ${HSKT}, ${LENH}, ${TEM},
  ${OQC_GIAO}, ${TRA_VE}, ${DOI_PA}
SELECT pin.id AS phan_in_id, dh.id AS don_hang_id,
  kh.ten_khach_hang, dh.ma_don_hang, dh.so_po, mh.ma_hang, pin.ma_phan,
  pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.tinh_chat_in,
  COALESCE(pin.so_luong_don_hang, 0)::int AS so_luong_don_hang,
  COALESCE(dvs.so_luong_vai_ve, 0)::int AS so_luong_vai_ve,
  dvs.ngay_vai_ve, dvs.han_giao_hang, COALESCE(dvs.so_dot_vai, 0)::int AS so_dot_vai,
  dvs.moc_vai, hs.moc_hskt,
  rdy.moc_film, rdy.moc_khuon, rdy.moc_muc, rdy.moc_qa_ready,
  GREATEST(rdy.moc_film, rdy.moc_khuon, rdy.moc_muc) AS moc_kt_xong,
  ln.moc_release_1, ln.moc_test_run, ln.moc_release_2, COALESCE(ln.so_lenh, 0)::int AS so_lenh,
  COALESCE(tm.sl_in, 0)::int AS sl_in, COALESCE(tm.sl_kiem, 0)::int AS sl_kiem,
  COALESCE(tm.sl_kiem_dat, 0)::int AS sl_kiem_dat, COALESCE(tm.sl_huy, 0)::int AS sl_huy,
  COALESCE(tm.sl_sua, 0)::int AS sl_sua, COALESCE(tm.sl_sua_dat, 0)::int AS sl_sua_dat,
  COALESCE(tm.sl_sua_huy, 0)::int AS sl_sua_huy,
  (COALESCE(tm.sl_kiem_dat, 0) + COALESCE(tm.sl_sua_dat, 0))::int AS tong_dat,
  (COALESCE(tm.sl_huy, 0) + COALESCE(tm.sl_sua_huy, 0))::int AS tong_huy,
  COALESCE(tm.sl_giao, 0)::int AS sl_giao, COALESCE(tm.so_tem, 0)::int AS so_tem,
  CASE WHEN COALESCE(tm.con_kcs,0) <= 0 AND COALESCE(tm.con_sua,0) <= 0
        AND COALESCE(tm.con_oqc,0) <= 0 AND COALESCE(tm.sl_oqc_dat,0) > 0
        AND (COALESCE(tm.sl_kiem_dat,0) + COALESCE(tm.sl_sua_dat,0)) >= COALESCE(pin.so_luong_don_hang, 0)
       THEN og.moc_oqc_cuoi END AS moc_finish,
  og.moc_phieu_giao AS moc_done_delivery,
  COALESCE(tv.so_lan_tra_ve, 0)::int AS so_lan_tra_ve,
  COALESCE(pa.so_lan_doi_pa, 0)::int AS so_lan_doi_pa,
  CASE WHEN dvs.moc_vai IS NOT NULL AND rdy.moc_qa_ready IS NOT NULL
            AND rdy.moc_qa_ready >= dvs.moc_vai
       THEN round(EXTRACT(EPOCH FROM (rdy.moc_qa_ready - dvs.moc_vai)) / 60)::int END AS lead_time_phut
FROM phan_in pin
JOIN ma_hang mh ON mh.id = pin.ma_hang_id
JOIN don_hang dh ON dh.id = mh.don_hang_id
JOIN khach_hang kh ON kh.id = dh.khach_hang_id
LEFT JOIN dvs ON dvs.phan_in_id = pin.id
LEFT JOIN hs  ON hs.phan_in_id  = pin.id
LEFT JOIN rdy ON rdy.phan_in_id = pin.id
LEFT JOIN ln  ON ln.phan_in_id  = pin.id
LEFT JOIN tm  ON tm.phan_in_id  = pin.id
LEFT JOIN og  ON og.phan_in_id  = pin.id
LEFT JOIN tv  ON tv.phan_in_id  = pin.id
LEFT JOIN pa  ON pa.phan_in_id  = pin.id
WHERE pin.dang_hoat_dong AND dh.id = ANY($1::uuid[])`;

// Ngưỡng "bất thường" của KPI 5 — phần in bị đổi phương án in NHIỀU HƠN ngưỡng này lần.
const NGUONG_DOI_PA = 2;

module.exports = { COT_KPI, COT_TRAI_OWNER, LOAI_NGAY, CAU_CHINH, NGUONG_DOI_PA, VN };
