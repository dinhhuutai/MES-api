'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// "SĨ SỐ" CHECKPOINT — Tồn đầu kỳ · Nhận trong kỳ · Làm được trong kỳ · Tồn cuối kỳ
//
// Hiện ở GÓC TRÊN BÊN PHẢI mỗi màn xác nhận (như viết sĩ số lớp trên bảng); bấm vào mở modal
// danh sách chi tiết + bộ lọc + xuất Excel.
//
// ⚠⚠⚠ TUYỆT ĐỐI KHÔNG DÙNG `lich_su_luan_chuyen` LÀM NGUỒN. Đo prod 16/08/2026:
//   READY **2038/2038 lượt THIẾU mốc vào** · SAN_XUAT chỉ 14 lượt · KIEM/SUA 2 lượt ·
//   **OQC và Giao KHÔNG có dòng nào** · toàn bảng **0 lượt "chưa rời"** (nên không phản ánh được
//   "đang tồn") · lần ghi cuối 14/08. Bảng đó là tracking best-effort — dùng nó thì 4 con số sai và
//   không bao giờ cân. (Cùng lý do, metric `CP_*_VAO_HOM_NAY`/`_ROI_HOM_NAY` của Báo cáo đang rỗng.)
//
// ⚠⚠ MÔ HÌNH: mỗi mục ở 1 trạm quy về **KHOẢNG THỜI GIAN `[tg_vao, tg_ra)`** suy từ MỐC SỰ KIỆN
//   TIN CẬY của chính trạm đó (`ket_qua_checkpoint`, `lenh_san_xuat`, `phieu_san_xuat`, `tem`,
//   `kcs`/`sua`/`oqc`, `giao_hang`, `audit_log`). Từ đó:
//     Tồn đầu(D)  = tg_vao <  đầu D  AND (tg_ra IS NULL OR tg_ra >= đầu D)
//     Nhận(D)     = tg_vao trong D
//     Làm được(D) = tg_ra  trong D
//     Tồn cuối(D) = tg_vao <  cuối D AND (tg_ra IS NULL OR tg_ra >= cuối D)
//   ⇒ **Tồn đầu + Nhận − Làm được = Tồn cuối LUÔN ĐÚNG** theo toán học (không "ép cho khớp"), và
//   xem NGÀY QUÁ KHỨ cũng chính xác chứ không riêng hôm nay.
//
// ⚠ ĐƠN VỊ ĐẾM KHÁC NHAU THEO MÀN (`donVi`) — cố ý, để số khớp ĐÚNG bảng bên dưới của màn đó:
//   READY/QC = PHẦN IN · Release 1 = ĐỢT VẢI · Test Run/Release 2/Chạy/Gia công = LỆNH ·
//   KCS/Sửa/OQC/Giao = TEM. (Bẫy đã ghi ở DATABASE.md §11.5: dashboard đếm phần in nên LUÔN ít hơn
//   màn thao tác — ở đây ta theo đơn vị của MÀN, không theo dominant stage.)
//
// ⚠ 2 TRỤC NGÀY TÁCH BẠCH:
//   · **Kỳ báo cáo** (`tu`/`den`) — luôn theo mốc sự kiện vào/ra trạm. Trục của 4 con số.
//   · **Bộ lọc ngày phụ** (`loaiNgay`+`ngayTu`/`ngayDen`) — chỉ THU HẸP TẬP đang xét (ngày nhận vải ·
//     ngày ERP lên MES · hạn giao · ngày KH sản xuất · ngày release). KHÔNG đụng định nghĩa 4 số.
//
// ⚠⚠ HIỆU NĂNG — BÀI HỌC ĐO THẬT (16/08/2026): bản đầu dùng **7 subquery LATERAL rời** cho mỗi phần
//   in ⇒ `KH_RELEASE1` chạy **247 GIÂY**, `KT_READY` không xong trong 120s. Gộp lại thành **1 LATERAL
//   cho mỗi nhóm dữ liệu** ⇒ còn **321ms**. Luật giữ mãi: mọi tổng hợp trên cùng một bảng phải gộp
//   vào MỘT lateral (`FILTER (WHERE …)`), đừng viết mỗi cột một subquery.
//
// ⚠⚠ ALIAS PHẢI DUY NHẤT giữa scope ngoài và trong LATERAL. Bản đầu đặt `dv` ở CẢ HAI nơi ⇒ subquery
//   tự tham chiếu chính nó (`WHERE dv.id = dv.id`) ⇒ nhân bản thành **395.372 dòng** trên 1.000 đợt
//   vải mà KHÔNG báo lỗi. Trong LATERAL dùng tiền tố `x…` (`xdv`, `xpin`, `xkh`).
//
// ⚠ `audit_log.id_ban_ghi` là **VARCHAR**, không phải UUID ⇒ so sánh phải `= <uuid>::text`
//   (không cast sẽ ném `operator does not exist: character varying = uuid`).
//
// ⚠ SQL ở đây gửi **gộp 1 dòng** (`.replace(/\s+/g,' ')` ở repository, tránh IPS reset) ⇒ TUYỆT ĐỐI
//   không viết comment `-- …` bên trong chuỗi SQL; chú thích để ngoài như file này.
// ─────────────────────────────────────────────────────────────────────────────

const VN = "AT TIME ZONE 'Asia/Ho_Chi_Minh'";

// Khách được miễn Khuôn — phải khớp Y HỆT `utils/tech.js` `KHUON_OPTIONAL_KH`, lệch là sĩ số đá nhau
// với chính màn READY.
const KHUON_OPTIONAL_KH = ['II', 'AD'];
const KH_MIEN_KHUON = `ARRAY['${KHUON_OPTIONAL_KH.join("','")}']`;

// 1 LATERAL gộp MỌI mốc READY của phần in (đủ mục KT + QC). `n_km = 2` nghĩa là có CẢ Khuôn lẫn Mực.
// ⚠ KHÔNG xét FILM — Film tự đạt theo Khuôn (CLAUDE.md §6), đưa vào là tạo lỗ hổng.
const LAT_READY = (pinCol) => `LEFT JOIN LATERAL (
  SELECT count(*) FILTER (WHERE xcp.ma_checkpoint IN ('KHUON','MUC'))::int AS n_km,
         max(xkq.tg_xac_nhan) FILTER (WHERE xcp.ma_checkpoint IN ('KHUON','MUC')) AS moc_km,
         max(xkq.tg_xac_nhan) FILTER (WHERE xcp.ma_checkpoint = 'MUC') AS moc_muc,
         max(xkq.tg_xac_nhan) FILTER (WHERE xcp.ma_checkpoint = 'QC_XAC_NHAN') AS moc_qc
    FROM ket_qua_checkpoint xkq JOIN checkpoint xcp ON xcp.id = xkq.checkpoint_id
   WHERE xkq.phan_in_id = ${pinCol} AND xkq.trang_thai = 'DAT'
) rdy ON true`;

// Mốc "kỹ thuật làm xong" — khách II/AD chỉ cần Mực, còn lại cần đủ Khuôn + Mực.
// ⚠ Khớp theo `ten_khach_hang` Y HỆT `utils/tech.js` (ERP set ma = ten; đối chiếu prod: đúng 2 khách
//   `II`/`AD`, ma = ten). Trước đây dùng `ma_khach_hang` — cùng kết quả nhưng lệch nguồn luật.
const MOC_KT_XONG = "CASE WHEN kh.ten_khach_hang = ANY(" + KH_MIEN_KHUON + ") THEN rdy.moc_muc"
  + ' WHEN rdy.n_km = 2 THEN rdy.moc_km END';

// ⚠⚠ LỐI THOÁT THỨ HAI CỦA READY — "đã release nên rời màn" (fix 16/08/2026).
// Bản đầu chỉ cho READY một lối ra duy nhất (đủ mục KT / QC xác nhận) ⇒ phần in được release THẲNG
// mà kỹ thuật chưa từng xác nhận mục nào (ERP `KTCankiemtra=0`, hoặc release tay) sẽ **tồn ở READY
// VĨNH VIỄN** dù đã đi tới Release 2 / sản xuất. Đo prod 16/08: sĩ số 191 ↔ màn READY 182, chênh
// **đúng 9 phần in** kiểu này (đều `RELEASE_2`, 0 mục KT, chưa QC).
// `moc_roi` = mốc lệnh CUỐI gắn vào đợt vải của phần in, CHỈ tính khi phần in KHÔNG còn nằm trên màn.
// ⚠ Điều kiện "còn trên màn" phải GƯƠNG Y HỆT `technical.repository.listCandidates` (3 nhánh OR),
//   lệch một nhánh là 2 con số lại đá nhau.
const LAT_ROI_READY = (pinCol) => `LEFT JOIN LATERAL (
  SELECT CASE WHEN EXISTS (SELECT 1 FROM dot_vai_ve rdva WHERE rdva.phan_in_id = ${pinCol}
                             AND rdva.trang_thai <> 'DA_GOP' AND rdva.tg_chuyen_ready IS NOT NULL
                             AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai rlsa
                                  JOIN lenh_san_xuat rla ON rla.id = rlsa.lenh_san_xuat_id
                                 WHERE rlsa.dot_vai_ve_id = rdva.id AND rla.trang_thai <> 'HUY'))
               OR NOT EXISTS (SELECT 1 FROM dot_vai_ve rdvb WHERE rdvb.phan_in_id = ${pinCol}
                                AND rdvb.trang_thai <> 'DA_GOP')
               OR EXISTS (SELECT 1 FROM dot_vai_ve rdvc
                            JOIN lenh_sx_dot_vai rlsc ON rlsc.dot_vai_ve_id = rdvc.id
                            JOIN lenh_san_xuat rlc ON rlc.id = rlsc.lenh_san_xuat_id
                                 AND rlc.trang_thai = 'RELEASE_1'
                           WHERE rdvc.phan_in_id = ${pinCol} AND rdvc.trang_thai <> 'DA_GOP'
                             AND rdvc.tg_chuyen_ready IS NOT NULL
                             AND NOT EXISTS (SELECT 1 FROM phieu_san_xuat rpsc
                                             WHERE rpsc.lenh_san_xuat_id = rlc.id))
              THEN NULL
              ELSE (SELECT max(rld.created_date) FROM dot_vai_ve rdvd
                      JOIN lenh_sx_dot_vai rlsd ON rlsd.dot_vai_ve_id = rdvd.id
                      JOIN lenh_san_xuat rld ON rld.id = rlsd.lenh_san_xuat_id
                           AND rld.trang_thai <> 'HUY'
                     WHERE rdvd.phan_in_id = ${pinCol}) END AS moc_roi
) roi ON true`;

// 1 LATERAL gộp mọi tổng hợp trên đợt vải của 1 phần in.
const LAT_DOT_CUA_PIN = (pinCol) => `LEFT JOIN LATERAL (
  SELECT max(xdv.tg_chuyen_ready) AS tg_ready, min(xdv.han_giao_hang) AS han_giao_hang,
         min(xdv.ngay_vai_ve) AS ngay_vai_ve, min(xdv.created_date) AS tg_len_mes,
         sum(xdv.so_luong_vai_ve)::int AS so_luong_vai_ve,
         string_agg(DISTINCT xdv.ma_dot_vai, ', ') AS ma_dot_vai,
         string_agg(DISTINCT xdv.nha_gia_cong, ', ') AS nha_gia_cong,
         (array_agg(xldv.ten_loai ORDER BY xdv.created_date DESC))[1] AS ten_loai_dot_vai
    FROM dot_vai_ve xdv LEFT JOIN loai_dot_vai xldv ON xldv.id = xdv.loai_dot_vai_id
   WHERE xdv.phan_in_id = ${pinCol} AND xdv.trang_thai NOT IN ('DA_GOP','DA_HUY')
) dvs ON true`;

const LAT_HSKT = (pinCol) => `LEFT JOIN LATERAL (
  SELECT xh.phuong_an_in FROM hskt_phan_in xhp JOIN ho_so_ky_thuat xh ON xh.id = xhp.hskt_id
   WHERE xhp.phan_in_id = ${pinCol} AND xhp.dang_hoat_dong AND xh.dang_hoat_dong
   ORDER BY xh.phien_ban DESC LIMIT 1
) hs ON true`;

// Mốc audit gần nhất của 1 lệnh. ⚠ `id_ban_ghi` là VARCHAR ⇒ BẮT BUỘC cast `::text`.
const MOC_AUDIT = (lenhCol, hanhDong) => `(SELECT max(xa.thoi_gian) FROM audit_log xa
   WHERE xa.ten_bang = 'lenh_san_xuat' AND xa.id_ban_ghi = ${lenhCol}::text
     AND xa.hanh_dong = '${hanhDong}')`;

const JOIN_PIN = `JOIN ma_hang mh ON mh.id = pin.ma_hang_id
  JOIN don_hang dh ON dh.id = mh.don_hang_id
  JOIN khach_hang kh ON kh.id = dh.khach_hang_id`;

// ─── NGUỒN MỐC MỨC ĐƠN VỊ (phần in / đợt vải / lệnh / tem) ───────────────────
// ⚠⚠ MỌI MÀN ĐỀU ĐẾM THEO **PHẦN IN** (chốt 16/08/2026). Trạm nào vận hành theo ĐỢT VẢI / LỆNH /
//   TEM thì các đơn vị con đó được **GOM VỀ PHẦN IN** bằng `gomTheoPin` — xem luật gộp ngay dưới.
//   Trước đây mỗi màn đếm theo đơn vị riêng (đợt vải / lệnh / tem) nên 11 con số không so được với
//   nhau và không so được với dashboard.
//
// ⚠⚠ MỘT PHẦN IN CÓ THỂ ĐỒNG THỜI Ở NHIỀU CHECKPOINT — **CỐ Ý**, người dùng chốt. Mỗi checkpoint
//   tính khoảng `[tg_vao, tg_ra)` ĐỘC LẬP nên phần in mới release một phần vẫn **TỒN ở Release 1**
//   trong khi đã được **NHẬN ở Test Run**. Đây KHÔNG phải dominant stage của dashboard (mỗi phần in
//   1 trạm — DATABASE.md §11.5) ⇒ **Σ 11 màn > tổng số phần in là ĐÚNG**, đừng "sửa cho khớp".
//
// Mỗi nguồn trả: `phan_in_id, tg_vao, tg_ra` + nhãn (`ma_lenh_san_xuat`, `ten_chuyen`,
// `ngay_ke_hoach`, `ngay_release`, `ma_tem`). Trạm không có nhãn nào thì khai `NULL::<kiểu>`.
// ⚠⚠ `ma_chuyen` + `ma_loai_chuyen` KHÔNG HIỆN TRÊN BẢNG — chỉ để LỌC theo dải chip của trang
//   (loại chuyền · khu bàn) khi dải "Theo dõi" bám bộ lọc trang. Trạm trước release chưa có chuyền
//   nên luôn NULL ⇒ chip loại chuyền tự khớp rỗng, đúng bản chất (xem `dungLoc`).
const NHAN_TRONG = `NULL::text AS ma_lenh_san_xuat, NULL::text AS ten_chuyen,
  NULL::text AS ma_chuyen, NULL::text AS ma_loai_chuyen,
  NULL::date AS ngay_ke_hoach, NULL::timestamptz AS ngay_release, NULL::text AS ma_tem`;

// Khung nguồn theo LỆNH: 1 dòng / (lệnh × đợt vải) → gom lại thành 1 dòng / phần in.
const NGUON_LENH = ({ tgVao, tgRa, dk, them = '' }) => `SELECT dv.phan_in_id, ${tgVao} AS tg_vao,
    ${tgRa} AS tg_ra, ls.ma_lenh_san_xuat, cs.ten_chuyen, cs.ma_chuyen, lct.ma_loai AS ma_loai_chuyen,
    ls.ngay_ke_hoach, ls.created_date AS ngay_release, NULL::text AS ma_tem
  FROM lenh_san_xuat ls
  JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
  JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
  JOIN phan_in pin ON pin.id = dv.phan_in_id AND pin.dang_hoat_dong
  LEFT JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
  LEFT JOIN loai_chuyen lct ON lct.id = cs.loai_chuyen_id
  ${them}
  WHERE ${dk}`;

// Khung nguồn theo TEM.
// ⚠ GIỚI HẠN ĐÃ BIẾT (DATABASE.md §4): `tem` KHÔNG lưu đợt vải/phần in ⇒ với lệnh GOM SET, MỌI tem
//   của lệnh được quy cho MỌI phần in trong lệnh. Ảnh hưởng 5 trạm theo tem. Muốn chính xác thì
//   phải thêm cột `tem.dot_vai_ve_id`.
const NGUON_TEM = ({ tgVao, tgRa, dk, them = '' }) => `SELECT dv.phan_in_id, ${tgVao} AS tg_vao,
    ${tgRa} AS tg_ra, ls.ma_lenh_san_xuat, cs.ten_chuyen, cs.ma_chuyen, lct.ma_loai AS ma_loai_chuyen,
    ls.ngay_ke_hoach, ls.created_date AS ngay_release, t.ma_tem
  FROM tem t
  JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
  JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
  JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
  JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
  JOIN phan_in pin ON pin.id = dv.phan_in_id AND pin.dang_hoat_dong
  LEFT JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
  LEFT JOIN loai_chuyen lct ON lct.id = cs.loai_chuyen_id
  ${them}
  WHERE ${dk}`;

const LAT_TEST_QA = `LEFT JOIN LATERAL (
  SELECT max(xkq.tg_xac_nhan) AS moc_qa FROM ket_qua_checkpoint xkq
    JOIN checkpoint xcp ON xcp.id = xkq.checkpoint_id
   WHERE xkq.lenh_san_xuat_id = ls.id AND xkq.trang_thai = 'DAT' AND xcp.ma_checkpoint = 'TEST_QA'
) tq ON true`;

// ⚠⚠ LỐI THOÁT THỨ HAI CỦA TEST RUN & RELEASE 2 — "lệnh đã rời chặng RELEASE_1" (fix 16/08/2026).
// Cùng họ lỗi với `LAT_ROI_READY`: nếu Test Run chỉ có lối ra là `TEST_QA` và Release 2 chỉ có lối
// ra là audit `RELEASE_2` thì lệnh **đi tắt Test Run** (SL < 100 / đang in tem → tạo thẳng
// `RELEASE_2`, không hề có `TEST_QA`) và lệnh **cũ không có audit** sẽ tồn ở 2 trạm đó VĨNH VIỄN.
// Đo prod 16/08: Test Run sĩ số 1381 ↔ màn 784; Release 2 sĩ số 1379 ↔ màn 0 (217 lệnh đi tắt +
// 216 lệnh thiếu audit `RELEASE_2`).
// ⚠ `GREATEST(...)` ở nhánh lùi là BẮT BUỘC: thiếu audit mà lấy thẳng `created_date` thì `tg_ra`
//   nhỏ hơn `tg_vao` (= mốc QA) ⇒ điều kiện nền `NEN` loại dòng đó khỏi CẢ 4 ô, mất hàng im lặng.
const MOC_ROI_R1 = `CASE WHEN ls.trang_thai = 'RELEASE_1' THEN NULL
  ELSE COALESCE(${MOC_AUDIT('ls.id', 'RELEASE_2')}, GREATEST(tq.moc_qa, ls.created_date)) END`;

const DV = {
  // READY (Kỹ thuật): vào = đợt vải lên READY, ra = kỹ thuật đủ mục (hoặc rời READY vì release thẳng).
  READY_KT: `SELECT pin.id AS phan_in_id, dvs.tg_ready AS tg_vao,
      COALESCE(${MOC_KT_XONG}, roi.moc_roi) AS tg_ra, ${NHAN_TRONG}
    FROM phan_in pin ${JOIN_PIN}
    ${LAT_DOT_CUA_PIN('pin.id')} ${LAT_READY('pin.id')} ${LAT_ROI_READY('pin.id')}
    WHERE pin.dang_hoat_dong`,

  // QC chuẩn bị kỹ thuật: **HÀNG ĐỢI CỦA QC** — vào = KỸ THUẬT ĐÃ XÁC NHẬN XONG HẾT MỤC, ra = QC
  // xác nhận (hoặc rời READY vì đã release thẳng).
  // ⚠⚠ ĐỔI 18/08/2026 (người dùng chốt) — ĐẢO lại quyết định 16/08 "vào = tg_chuyen_ready".
  //   Lý do đổi: `listCandidates` phục vụ CẢ 2 màn và lọc y hệt nhau (`onlyQcReady` chỉ đổi cách tính
  //   SLA), nên lấy mốc vào = lúc lên READY thì ô "Nhận" của QC đếm cả phần in KỸ THUẬT CHƯA ĐỤNG TỚI
  //   — không phải việc của QC. Nay 4 số phản ánh đúng việc QC phải làm.
  // ⚠ Ghi chú cũ "đổi vì 4 số ra 0/0/0/0" KHÔNG còn đúng: đo lại prod 13→17/08 cho ra
  //   Nhận = 197 · 175 · 142 · 0 · 145 (ngày 16/08 nghỉ). Tồn ≈ 0 là ĐÚNG BẢN CHẤT — QC duyệt ngay
  //   sau khi kỹ thuật xong, không tồn đọng; đừng thấy tồn nhỏ mà tưởng hỏng.
  // ⚠⚠ BẮT BUỘC có `${JOIN_PIN}`: `MOC_KT_XONG` đọc `kh.ten_khach_hang` (khách II/AD miễn Khuôn).
  //   Bản cũ KHÔNG join vì không cần `kh` — bỏ quên là lỗi `missing FROM-clause entry for table "kh"`.
  READY_QC: `SELECT pin.id AS phan_in_id, ${MOC_KT_XONG} AS tg_vao,
      COALESCE(rdy.moc_qc, roi.moc_roi) AS tg_ra, ${NHAN_TRONG}
    FROM phan_in pin ${JOIN_PIN}
    ${LAT_READY('pin.id')} ${LAT_ROI_READY('pin.id')}
    WHERE pin.dang_hoat_dong`,

  // READY theo nghĩa DÒNG CHẢY (vào = đợt vải lên READY, ra = QC xác nhận) — CHỈ dùng cho **Báo cáo**
  // (`CP_PHAN_IN.READY`), KHÔNG phải cho màn nào.
  // ⚠⚠ TÁCH RIÊNG 18/08/2026, đừng gộp lại với `READY_QC`: metric `CP_READY_VAO_HOM_NAY` phải trả lời
  //   "hôm nay có bao nhiêu phần in VÀO READY" (đo 17/08: 145). Nếu để nó dùng chung `READY_QC` mới thì
  //   con số biến thành "bao nhiêu phần in KỸ THUẬT LÀM XONG" — cùng ngày ra 10, lệch hẳn ý nghĩa.
  READY_DONG_CHAY: `SELECT pin.id AS phan_in_id, dvs.tg_ready AS tg_vao,
      COALESCE(rdy.moc_qc, roi.moc_roi) AS tg_ra, ${NHAN_TRONG}
    FROM phan_in pin
    ${LAT_DOT_CUA_PIN('pin.id')} ${LAT_READY('pin.id')} ${LAT_ROI_READY('pin.id')}
    WHERE pin.dang_hoat_dong`,

  // Release 1: đơn vị ĐỢT VẢI. Vào = đợt vải lên READY (có mặt trên màn Release 1);
  // ra = đã release HẾT số lượng (`con_release` = 0).
  // ⚠⚠ BỎ ĐIỀU KIỆN READY 18/08/2026 (người dùng chốt): bản cũ `GREATEST(tg_chuyen_ready, moc_qc)`
  //   đẩy mốc vào tới lúc QC xác nhận. Nhưng **màn Release 1 KHÔNG đòi QC** —
  //   `listRelease1Candidates` chỉ lọc `tg_chuyen_ready IS NOT NULL` + `con_release > 0` và hiện badge
  //   "Đã Ready"/"Chờ Ready" (bỏ bắt buộc QC từ khi có Kế hoạch tạm, mig 058) ⇒ sĩ số đang đếm THIẾU
  //   so với chính bảng bên dưới. Đo prod: tồn cuối 15/08 **159 → 194**, 14/08 **195 → 264**.
  // ⚠ `GREATEST` bỏ qua NULL nên bản cũ vẫn lọt phần in chưa QC vào ô "Nhận" ở mốc `tg_chuyen_ready`
  //   — tức 2 ô "Nhận"/"Tồn" đang tính theo 2 mốc khác nhau. Nay chỉ còn MỘT mốc, hết mâu thuẫn.
  // ⚠⚠ 2 LỐI RA — thiếu lối thứ 2 là số sĩ số vô nghĩa: đợt vải được LẬP KẾ HOẠCH TẠM sẽ **biến mất
  //   khỏi màn Release 1** (`listRelease1Candidates` loại `ke_hoach_tam` 'CHO') nhưng vẫn còn
  //   `con_release > 0`. Đo prod 18/08: **161/165 đợt còn release đang nằm ở Kế hoạch tạm** ⇒ nếu chỉ
  //   có lối ra "release hết SL" thì sĩ số báo **159 phần in** trong khi bảng chỉ hiện **4**.
  // ⚠ Mốc rời dùng `kht.created_date` (lúc lập kế hoạch tạm), bọc `GREATEST` để giữ bất biến
  //   `tg_ra >= tg_vao`. Ưu tiên nhánh "đã release hết" trước — đó mới là rời THẬT khỏi chặng.
  // ⚠ Điều kiện "đang ở Kế hoạch tạm" đọc TRẠNG THÁI SỐNG (`kht.id IS NOT NULL`), không phải mốc lịch
  //   sử ⇒ xóa kế hoạch tạm là đợt **tự quay lại** ô Tồn ngay, không cần bản ghi "vào lại".
  RELEASE_1: `SELECT dv.phan_in_id, dv.tg_chuyen_ready AS tg_vao,
      COALESCE(
        CASE WHEN COALESCE(dv.so_luong_vai_ve,0) - COALESCE(rel.da_release,0) <= 0
             THEN rel.tg_release_cuoi END,
        CASE WHEN kht.id IS NOT NULL
             THEN GREATEST(dv.tg_chuyen_ready, kht.created_date) END) AS tg_ra,
      NULL::text AS ma_lenh_san_xuat, NULL::text AS ten_chuyen,
      NULL::text AS ma_chuyen, NULL::text AS ma_loai_chuyen, NULL::date AS ngay_ke_hoach,
      rel.tg_release_cuoi AS ngay_release, NULL::text AS ma_tem
    FROM dot_vai_ve dv
    JOIN phan_in pin ON pin.id = dv.phan_in_id AND pin.dang_hoat_dong
    LEFT JOIN ke_hoach_tam kht ON kht.dot_vai_ve_id = dv.id AND kht.trang_thai = 'CHO'
    LEFT JOIN LATERAL (SELECT sum(xlsd.so_luong)::int AS da_release,
        max(xls.created_date) AS tg_release_cuoi
      FROM lenh_sx_dot_vai xlsd JOIN lenh_san_xuat xls ON xls.id = xlsd.lenh_san_xuat_id
      WHERE xlsd.dot_vai_ve_id = dv.id AND xls.trang_thai <> 'HUY') rel ON true
    WHERE dv.trang_thai NOT IN ('DA_GOP','DA_HUY') AND dv.tg_chuyen_ready IS NOT NULL`,

  // KẾ HOẠCH TẠM (mig 058): lập kế hoạch SỚM cho đợt vải chưa QC. Vào = lần LƯU gần nhất,
  // ra = xác nhận Release 1 / xóa kế hoạch tạm.
  // ⚠⚠ DÒNG `ke_hoach_tam` BỊ XÓA KHI XONG ⇒ mốc phải lấy từ `audit_log` (`ten_bang='ke_hoach_tam'`,
  //   `id_ban_ghi` = **dot_vai_ve_id**, kiểu VARCHAR nên phải so `dv.id::text`).
  // ⚠⚠ NHƯNG KHÔNG ĐƯỢC TIN AUDIT MỘT MÌNH ĐỂ SUY "ĐÃ RỜI": có **2 đường xóa KHÔNG ghi audit** —
  //   (a) `releaseSet` → `deleteKeHoachTamByDotVai` (dọn kế hoạch tạm khi release theo gom set);
  //   (b) nhánh `da_don` của `confirmKeHoachTam` (dòng chết của dữ liệu cũ, return sớm).
  //   Chỉ dựa vào audit thì tồn cuối ra **340** trong khi thực tế chỉ **156** phần in còn kế hoạch tạm.
  //   ⇒ Còn nằm ở màn hay không phải hỏi CHÍNH BẢNG `ke_hoach_tam` (`kht.id IS NOT NULL`).
  // ⚠ `GREATEST(moc_vao, …)` giữ bất biến `tg_ra >= tg_vao`; thứ tự lùi: audit XÁC NHẬN/XÓA → mốc tạo
  //   lệnh của đợt (đường `releaseSet`) → chính `moc_vao` (đã rời nhưng không rõ lúc nào ⇒ coi như rời
  //   ngay, 4 số vẫn cân). Đối chiếu prod 18/08: tồn cuối **156 = 156** phần in trên màn.
  KE_HOACH_TAM: `SELECT dv.phan_in_id, kt.moc_vao AS tg_vao,
      CASE WHEN kht.id IS NOT NULL THEN NULL
           ELSE GREATEST(kt.moc_vao, COALESCE(kt.moc_ra, rel.tg_release_cuoi)) END AS tg_ra,
      NULL::text AS ma_lenh_san_xuat, cs.ten_chuyen,
      cs.ma_chuyen, lct.ma_loai AS ma_loai_chuyen,
      COALESCE(kht.ngay_ke_hoach, kt.ngay_kh_audit) AS ngay_ke_hoach,
      rel.tg_release_cuoi AS ngay_release, NULL::text AS ma_tem
    FROM (SELECT xa.id_ban_ghi,
            max(xa.thoi_gian) FILTER (WHERE xa.hanh_dong = 'LUU_KE_HOACH_TAM') AS moc_vao,
            max(xa.thoi_gian) FILTER (WHERE xa.hanh_dong IN ('XAC_NHAN_KE_HOACH_TAM','XOA_KE_HOACH_TAM')) AS moc_ra,
            (array_agg((xa.gia_tri_moi->>'ngay_ke_hoach')::date ORDER BY xa.thoi_gian DESC)
               FILTER (WHERE xa.gia_tri_moi->>'ngay_ke_hoach' IS NOT NULL))[1] AS ngay_kh_audit,
            (array_agg(xa.gia_tri_moi->>'chuyen_id' ORDER BY xa.thoi_gian DESC)
               FILTER (WHERE xa.gia_tri_moi->>'chuyen_id' IS NOT NULL))[1] AS chuyen_id_audit
          FROM audit_log xa WHERE xa.ten_bang = 'ke_hoach_tam' GROUP BY xa.id_ban_ghi) kt
    JOIN dot_vai_ve dv ON dv.id::text = kt.id_ban_ghi
    JOIN phan_in pin ON pin.id = dv.phan_in_id AND pin.dang_hoat_dong
    LEFT JOIN ke_hoach_tam kht ON kht.dot_vai_ve_id = dv.id AND kht.trang_thai = 'CHO'
    LEFT JOIN chuyen_san_xuat cs ON cs.id = COALESCE(kht.chuyen_id, kt.chuyen_id_audit::uuid)
    LEFT JOIN loai_chuyen lct ON lct.id = cs.loai_chuyen_id
    LEFT JOIN LATERAL (SELECT max(xls.created_date) AS tg_release_cuoi
      FROM lenh_sx_dot_vai xlsd JOIN lenh_san_xuat xls ON xls.id = xlsd.lenh_san_xuat_id
      WHERE xlsd.dot_vai_ve_id = dv.id AND xls.trang_thai <> 'HUY') rel ON true
    WHERE dv.trang_thai NOT IN ('DA_GOP','DA_HUY') AND kt.moc_vao IS NOT NULL`,

  // Test Run: vào = lệnh Release 1 tạo ra, ra = QA xác nhận đạt (hoặc lệnh đã rời chặng RELEASE_1).
  // ⚠ Lệnh **ĐI TẮT Test Run** (chưa từng có `TEST_QA` mà đã rời `RELEASE_1`) bị loại HẲN khỏi trạm
  //   này (`tg_vao` NULL ⇒ `gomTheoPin` bỏ dòng) — nó không hề đi qua Test Run, đếm vào là sai.
  TEST_RUN: NGUON_LENH({
    tgVao: "CASE WHEN tq.moc_qa IS NOT NULL OR ls.trang_thai = 'RELEASE_1' THEN ls.created_date END",
    tgRa: `COALESCE(tq.moc_qa, ${MOC_ROI_R1})`,
    them: LAT_TEST_QA, dk: "ls.trang_thai <> 'HUY'",
  }),

  // Release 2: vào = test xong (lệnh đi tắt Test Run thì lấy mốc tạo lệnh), ra = duyệt Release 2.
  // ⚠ Lệnh còn `RELEASE_1` mà CHƯA test thì chưa tới Release 2 ⇒ `tg_vao` NULL, bị loại khỏi trạm
  //   này (trước đây lấy `created_date` nên lệnh đang chờ test bị đếm nhầm là tồn ở Release 2).
  RELEASE_2: NGUON_LENH({
    tgVao: "COALESCE(tq.moc_qa, CASE WHEN ls.trang_thai <> 'RELEASE_1' THEN ls.created_date END)",
    tgRa: MOC_ROI_R1, them: LAT_TEST_QA, dk: "ls.trang_thai <> 'HUY'",
  }),

  // Xác nhận chạy — gộp CẢ "Chờ chạy" LẪN "Đang chạy" (màn có 2 bảng, 1 sĩ số cho cả màn).
  SAN_XUAT: NGUON_LENH({
    tgVao: `COALESCE(${MOC_AUDIT('ls.id', 'RELEASE_2')}, ls.created_date)`, tgRa: 'ph.moc_xong',
    them: `LEFT JOIN LATERAL (SELECT max(xps.tg_kt) AS moc_xong FROM phieu_san_xuat xps
             WHERE xps.lenh_san_xuat_id = ls.id AND xps.trang_thai = 'HOAN_TAT') ph ON true`,
    dk: "ls.trang_thai IN ('RELEASE_2','SAN_XUAT','HOAN_TAT')",
  }),

  // Gia công: vào = lệnh gia công tạo ra, ra = nhận ĐỦ hàng về (lệnh rời màn sang OQC).
  // ⚠ Nhánh lùi `GREATEST(updated_date, created_date)`: lệnh đã rời trạng thái `GIA_CONG` mà thiếu
  //   audit `GIA_CONG_CHUYEN_OQC` (dữ liệu cũ) thì không có mốc ra ⇒ tồn vĩnh viễn.
  GIA_CONG: NGUON_LENH({
    tgVao: 'ls.created_date',
    tgRa: `CASE WHEN ls.trang_thai <> 'GIA_CONG' THEN COALESCE(
             ${MOC_AUDIT('ls.id', 'GIA_CONG_CHUYEN_OQC')},
             GREATEST(ls.updated_date, ls.created_date)) END`,
    them: "JOIN loai_chuyen lc ON lc.id = cs.loai_chuyen_id AND lc.ma_loai = 'GIA_CONG'",
    dk: "ls.trang_thai <> 'HUY'",
  }),

  // Chờ khô: vào = in tem, ra = tem khô. (Màn "Quét chờ khô" đã gỡ, chỉ báo cáo dùng.)
  CHO_KHO: NGUON_TEM({
    tgVao: 't.created_date', tgRa: 'xp.moc_kho', dk: "t.trang_thai <> 'HUY'",
    them: `LEFT JOIN LATERAL (SELECT max(xtxp.tg_kt_phoi) AS moc_kho FROM tem_xe_phoi xtxp
             WHERE xtxp.tem_id = t.id) xp ON true`,
  }),

  // KCS: vào = tem KHÔ xong (vào hàng đợi kiểm), ra = kiểm hết phần còn lại.
  KIEM: NGUON_TEM({
    tgVao: 'COALESCE(xp.moc_kho, t.created_date)',
    tgRa: `CASE WHEN (COALESCE(t.so_luong,0) + COALESCE(t.sl_chenh_lech,0))
                     - (COALESCE(t.sl_kcs_dat,0)+COALESCE(t.sl_kcs_sua,0)+COALESCE(t.sl_kcs_huy,0)) <= 0
                THEN kc.moc_kcs END`,
    dk: "t.trang_thai <> 'HUY'",
    them: `LEFT JOIN LATERAL (SELECT max(xtxp.tg_kt_phoi) AS moc_kho FROM tem_xe_phoi xtxp
             WHERE xtxp.tem_id = t.id) xp ON true
           LEFT JOIN LATERAL (SELECT max(xk.created_date) AS moc_kcs FROM kcs xk
             WHERE xk.tem_id = t.id) kc ON true`,
  }),

  // Sửa: vào = lần KCS đầu tiên có hàng phải sửa, ra = sửa hết phần chờ.
  // ⚠ COALESCE về mốc tạo tem: `sl_kcs_sua` có thể do màn "Phân loại lỗi" GHI ĐÈ mà dòng `kcs`
  //   tương ứng không có `so_luong_loi` — thiếu mốc vào thì cả tem bị loại khỏi sĩ số, im lặng.
  SUA: NGUON_TEM({
    tgVao: 'COALESCE(kc.moc_loi, t.created_date)',
    tgRa: `CASE WHEN COALESCE(t.sl_kcs_sua,0)
                     - (COALESCE(t.sl_sua_dat,0)+COALESCE(t.sl_sua_huy,0)) <= 0
                THEN sa.moc_sua END`,
    dk: "t.trang_thai <> 'HUY' AND COALESCE(t.sl_kcs_sua,0) > 0",
    them: `LEFT JOIN LATERAL (SELECT min(xk.created_date) FILTER (WHERE COALESCE(xk.so_luong_loi,0) > 0)
               AS moc_loi FROM kcs xk WHERE xk.tem_id = t.id) kc ON true
           LEFT JOIN LATERAL (SELECT max(xs.created_date) AS moc_sua FROM sua xs
             WHERE xs.tem_id = t.id) sa ON true`,
  }),

  // OQC: vào = lần đầu có hàng ĐẠT (từ KCS hoặc từ Sửa), ra = OQC duyệt hết phần chờ.
  // ⚠ COALESCE về mốc tạo tem cho **hàng GIA CÔNG**: tem gia công được seed sẵn `sl_kcs_dat` mà
  //   KHÔNG có dòng `kcs` nào (§5) ⇒ không có mốc vào, thiếu COALESCE là biến mất khỏi sĩ số OQC.
  OQC: NGUON_TEM({
    tgVao: 'COALESCE(LEAST(kc.moc_dat, sa.moc_dat), t.created_date)',
    tgRa: `CASE WHEN (COALESCE(t.sl_kcs_dat,0)+COALESCE(t.sl_sua_dat,0)) - COALESCE(t.sl_oqc_dat,0) <= 0
                THEN oq.moc_oqc END`,
    dk: "t.trang_thai <> 'HUY' AND (COALESCE(t.sl_kcs_dat,0)+COALESCE(t.sl_sua_dat,0)) > 0",
    them: `LEFT JOIN LATERAL (SELECT min(xk.created_date) FILTER (WHERE COALESCE(xk.so_luong_dat,0) > 0)
               AS moc_dat FROM kcs xk WHERE xk.tem_id = t.id) kc ON true
           LEFT JOIN LATERAL (SELECT min(xs.created_date) FILTER (WHERE COALESCE(xs.so_luong_sua_dat,0) > 0)
               AS moc_dat FROM sua xs WHERE xs.tem_id = t.id) sa ON true
           LEFT JOIN LATERAL (SELECT max(xo.created_date) AS moc_oqc FROM oqc xo
             WHERE xo.tem_id = t.id) oq ON true`,
  }),

  // Giao hàng: vào = OQC cho qua giao lần đầu, ra = giao hết phần còn lại.
  GIAO: NGUON_TEM({
    tgVao: 'COALESCE(oq.moc_qua_giao, oq.moc_oqc)',
    tgRa: 'CASE WHEN COALESCE(t.sl_oqc_dat,0) - COALESCE(t.sl_da_giao,0) <= 0 THEN gh.moc_giao END',
    dk: "t.trang_thai <> 'HUY' AND COALESCE(t.sl_oqc_dat,0) > 0",
    them: `LEFT JOIN LATERAL (SELECT min(xo.created_date) FILTER (WHERE COALESCE(xo.sl_qua_giao,0) > 0)
               AS moc_qua_giao, min(xo.created_date) AS moc_oqc
             FROM oqc xo WHERE xo.tem_id = t.id) oq ON true
           LEFT JOIN LATERAL (SELECT max(xgh.created_date) AS moc_giao FROM giao_hang_tem xght
               JOIN giao_hang xgh ON xgh.id = xght.giao_hang_id
              WHERE xght.tem_id = t.id) gh ON true`,
  }),
};

// ─── GOM ĐƠN VỊ CON VỀ PHẦN IN ──────────────────────────────────────────────
// ⚠⚠ LUẬT GỘP: phần in **VÀO** trạm ở mốc SỚM NHẤT của các đơn vị con (`min`), và chỉ **RỜI** trạm
//   khi **MỌI** đơn vị con đã rời (`count(*) FILTER (WHERE tg_ra IS NULL) = 0` rồi mới `max`).
//   Còn 1 tem/lệnh/đợt chưa xong thì phần in vẫn đang ở trạm — đúng cách người dùng hiểu.
// ⚠ Bất biến `tg_ra >= tg_vao` vẫn giữ sau khi gộp: `max(tg_ra) >= tg_ra` của đơn vị vào sớm nhất
//   `>= min(tg_vao)` — nên "Tồn đầu + Nhận − Làm được = Tồn cuối" không bao giờ vỡ vì phép gộp.
// ⚠⚠ LOẠI đơn vị `tg_vao IS NULL` (chưa từng vào trạm) — giữ lại thì nó ép `tg_ra` của CẢ NHÓM
//   thành NULL và phần in tồn ở trạm vĩnh viễn.
const gomTheoPin = (trong) => `SELECT x.phan_in_id, min(x.tg_vao) AS tg_vao,
  CASE WHEN count(*) FILTER (WHERE x.tg_ra IS NULL) = 0 THEN max(x.tg_ra) END AS tg_ra,
  count(*)::int AS so_don_vi,
  string_agg(DISTINCT x.ma_lenh_san_xuat, ', ') AS ma_lenh_san_xuat,
  string_agg(DISTINCT x.ten_chuyen, ', ') AS ten_chuyen,
  string_agg(DISTINCT x.ma_tem, ', ') AS ma_tem,
  string_agg(DISTINCT x.ma_chuyen, ',') AS ma_chuyen,
  string_agg(DISTINCT x.ma_loai_chuyen, ',') AS ma_loai_chuyen,
  min(x.ngay_ke_hoach) AS ngay_ke_hoach, min(x.ngay_release) AS ngay_release
  FROM (${trong}) x
  WHERE x.phan_in_id IS NOT NULL AND x.tg_vao IS NOT NULL
  GROUP BY x.phan_in_id`;

// Bộ cột hiển thị chuẩn — MỌI màn trả CÙNG bộ này ⇒ FE dựng 1 bảng + 1 hàm Excel.
// ⚠ `so_phan_in` LUÔN = 1: đơn vị đếm nay là PHẦN IN nên badge "gom set N" không còn nghĩa; số
//   lệnh/tem của phần in đọc được ở cột Mã đợt SX / Mã tem (đã `string_agg`).
const COT_PIN_GOM = `kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang, pin.ma_phan, pin.mau_vai,
  pin.kich_vai, pin.kich_phim, pin.tinh_chat_in, pin.so_luong_don_hang,
  dvs.ten_loai_dot_vai, hs.phuong_an_in, dvs.nha_gia_cong, dvs.so_luong_vai_ve,
  dvs.han_giao_hang, dvs.ngay_vai_ve, dvs.tg_len_mes, dvs.ma_dot_vai,
  g.ma_lenh_san_xuat, g.ten_chuyen, g.ngay_ke_hoach, g.ngay_release, g.ma_tem, 1 AS so_phan_in,
  g.ma_chuyen, g.ma_loai_chuyen`;

// ─── CỘT PHỤC VỤ CÁC Ô TÍCH CỦA TRANG (dải "Theo dõi" bám luôn ô tích — 18/08/2026) ─────────
// ⚠⚠ TÍNH Ở TẦNG NGOÀI (theo `pin.id`), KHÔNG nhét vào từng nguồn: 3 thứ dưới đây đều là thuộc
//   tính của PHẦN IN, mà mỗi màn lại có nguồn mốc riêng — thêm vào từng nguồn là phải sửa 12 chỗ
//   và rất dễ sót (đúng lỗi `column x.ma_chuyen does not exist` đã mắc khi thêm cột loại chuyền).
// ⚠ Cột nào màn không dùng thì bộ lọc không đụng tới, nên chi phí chỉ là LATERAL/EXISTS nhẹ theo
//   khóa chính. KHÔNG bỏ đi để "tối ưu": bỏ là bộ lọc im lặng không ăn.

// "Đã Ready" = QC đã xác nhận READY (ô tích *Đã Ready / Chờ Ready* ở màn Release 1).
const LAT_QC_DONE = `LEFT JOIN LATERAL (
  SELECT (count(*) > 0) AS qc_done FROM ket_qua_checkpoint xkq
    JOIN checkpoint xcp ON xcp.id = xkq.checkpoint_id
   WHERE xkq.phan_in_id = pin.id AND xkq.trang_thai = 'DAT' AND xcp.ma_checkpoint = 'QC_XAC_NHAN'
) qcd ON true`;

// Mã gom set đang MỞ của phần in (ô lọc *Gom set* ở màn Kế hoạch tạm).
const LAT_MA_SET = `LEFT JOIN LATERAL (
  SELECT string_agg(DISTINCT xgs.ma_set, ', ') AS ma_set
    FROM gom_set_dot_vai xgsd
    JOIN gom_set xgs ON xgs.id = xgsd.gom_set_id AND xgs.trang_thai = 'MO'
    JOIN dot_vai_ve xdv ON xdv.id = xgsd.dot_vai_ve_id
   WHERE xdv.phan_in_id = pin.id
) gs ON true`;

// ⚠⚠ "BỊ TRẢ VỀ" KHÁC NHAU TỪNG MÀN — phải khai riêng, dùng chung một định nghĩa là số sĩ số lệch
//   với chính ô tích trên màn đó:
//     READY / QC READY : `qc_tra_ve.phan_in_id`, loai READY · RELEASE1 · TEST_RUN_KT (3 nguồn)
//     Release 1        : `qc_tra_ve.dot_vai_ve_id`, loai TEST_RUN
//     KCS              : `qc_tra_ve.tem_id`, loai OQC
//   Màn không có ô tích này thì để `false` (bộ lọc gửi lên cũng chỉ khớp rỗng, không sai số).
// ⚠ Trả MỐC TRẢ VỀ GẦN NHẤT (timestamptz) chứ không phải EXISTS: từ đó suy được CẢ cờ `bi_tra_ve`
//   LẪN cột ngày cho bộ lọc `NGAY_TRA_VE` — đúng khoảng ngày mà ô tích trên màn đang dùng.
const TV = {
  PHAN_IN: `(SELECT max(xq.created_date) FROM qc_tra_ve xq WHERE xq.phan_in_id = pin.id
    AND xq.da_xu_ly = false AND xq.loai IN ('READY','RELEASE1','TEST_RUN_KT'))`,
  DOT_VAI_TEST_RUN: `(SELECT max(xq.created_date) FROM qc_tra_ve xq
    JOIN dot_vai_ve xdv ON xdv.id = xq.dot_vai_ve_id
    WHERE xdv.phan_in_id = pin.id AND xq.da_xu_ly = false AND xq.loai = 'TEST_RUN')`,
  TEM_OQC: `(SELECT max(xq.created_date) FROM qc_tra_ve xq JOIN tem xt ON xt.id = xq.tem_id
    JOIN phieu_san_xuat xps ON xps.id = xt.phieu_san_xuat_id
    JOIN lenh_sx_dot_vai xlsd ON xlsd.lenh_san_xuat_id = xps.lenh_san_xuat_id
    JOIN dot_vai_ve xdv ON xdv.id = xlsd.dot_vai_ve_id
    WHERE xdv.phan_in_id = pin.id AND xq.da_xu_ly = false AND xq.loai = 'OQC')`,
  KHONG: 'NULL::timestamptz',
};

const manTheoPin = (trong, { traVe = TV.KHONG } = {}) => `SELECT pin.id, ${COT_PIN_GOM}, g.tg_vao, g.tg_ra,
  COALESCE(qcd.qc_done, false) AS qc_done, gs.ma_set,
  (${traVe}) AS tg_tra_ve, ((${traVe}) IS NOT NULL) AS bi_tra_ve
  FROM (${gomTheoPin(trong)}) g
  JOIN phan_in pin ON pin.id = g.phan_in_id
  ${JOIN_PIN} ${LAT_DOT_CUA_PIN('pin.id')} ${LAT_HSKT('pin.id')} ${LAT_QC_DONE} ${LAT_MA_SET}`;

// ─── 11 MÀN XÁC NHẬN ─────────────────────────────────────────────────────────
// `ma` khớp `TRANG_PAIN` (utils/phuongAnIn.js) để FE truyền đúng MỘT mã cho cả 2 tính năng.
// ⚠ `donVi`/`nhan` nay GIỐNG NHAU ở cả 11 màn — giữ 2 khóa này để FE không phải sửa, và để sau muốn
//   đổi lại đơn vị của một màn nào đó thì có sẵn chỗ.
const MAN = {
  KT_READY: {
    ten: 'Xác nhận READY (Kỹ thuật)', donVi: 'pin', nhan: 'phần in',
    quyen: ['READY_VIEW', 'READY_KHUON', 'READY_FILM', 'READY_MUC'],
    sql: manTheoPin(DV.READY_KT, { traVe: TV.PHAN_IN }),
  },
  CL_QC_READY: {
    ten: 'QC chuẩn bị kỹ thuật', donVi: 'pin', nhan: 'phần in', quyen: ['READY_QC'],
    sql: manTheoPin(DV.READY_QC, { traVe: TV.PHAN_IN }),
  },
  KH_RELEASE1: {
    ten: 'Release 1', donVi: 'pin', nhan: 'phần in', quyen: ['RELEASE1'],
    sql: manTheoPin(DV.RELEASE_1, { traVe: TV.DOT_VAI_TEST_RUN }),
  },
  CL_TEST_RUN: {
    ten: 'Test Run - QA', donVi: 'pin', nhan: 'phần in', quyen: ['TESTRUN_QA'],
    sql: manTheoPin(DV.TEST_RUN),
  },
  KH_RELEASE2: {
    ten: 'Release 2', donVi: 'pin', nhan: 'phần in', quyen: ['RELEASE2'],
    sql: manTheoPin(DV.RELEASE_2),
  },
  // ⚠ Quyền khớp menu (`constants/modules.js`: Kế hoạch tạm mở cho RELEASE1 hoặc RELEASE2).
  KH_TAM: {
    ten: 'Kế hoạch tạm', donVi: 'pin', nhan: 'phần in', quyen: ['RELEASE1', 'RELEASE2'],
    sql: manTheoPin(DV.KE_HOACH_TAM),
  },
  SX_CHO_CHAY: {
    ten: 'Xác nhận chạy', donVi: 'pin', nhan: 'phần in', quyen: ['PROD_RUN', 'PROD_MONITOR'],
    sql: manTheoPin(DV.SAN_XUAT),
  },
  KH_GIA_CONG: {
    ten: 'Gia công', donVi: 'pin', nhan: 'phần in', quyen: ['RELEASE1', 'RELEASE2'],
    sql: manTheoPin(DV.GIA_CONG),
  },
  SX_KCS: {
    ten: 'KCS (kiểm)', donVi: 'pin', nhan: 'phần in', quyen: ['KCS'],
    sql: manTheoPin(DV.KIEM, { traVe: TV.TEM_OQC }),
  },
  SX_SUA: {
    ten: 'Sửa', donVi: 'pin', nhan: 'phần in', quyen: ['SUA'],
    sql: manTheoPin(DV.SUA),
  },
  CL_OQC: {
    ten: 'OQC', donVi: 'pin', nhan: 'phần in', quyen: ['OQC'],
    sql: manTheoPin(DV.OQC),
  },
  GH_TEM: {
    ten: 'Giao hàng', donVi: 'pin', nhan: 'phần in', quyen: ['DELIVERY'],
    sql: manTheoPin(DV.GIAO),
  },
};

// ─── NGUỒN MỐC MỨC PHẦN IN CHO BÁO CÁO ──────────────────────────────────────
// Metric `CP_*_VAO_HOM_NAY` / `_ROI_HOM_NAY` / `SLDON_XN_*` và dataset `DS_PHAN_IN_VAO_TRAM` đếm
// theo PHẦN IN — nay DÙNG CHUNG đúng các nguồn `DV` ở trên nên Báo cáo và sĩ số màn KHÔNG THỂ lệch.
// ⚠ Khóa ở đây là **`tram.ma_tram`** (khớp hằng `CP_FLOW` của `bao-cao/metrics.js`), không phải mã trang.
// ⚠ `READY` dùng `DV.READY_QC` (mốc ra = `QC_XAC_NHAN`) — đó mới là "READY hoàn tất" theo nghĩa dòng chảy.
const CP_PHAN_IN = {
  // ⚠⚠ DÙNG `READY_DONG_CHAY`, KHÔNG dùng `READY_QC`: từ 18/08/2026 `READY_QC` mang nghĩa "hàng đợi
  //   của QC" (vào = kỹ thuật xong hết) — hợp cho MÀN, sai cho báo cáo dòng chảy. Xem chú thích ở `DV`.
  READY: gomTheoPin(DV.READY_DONG_CHAY),
  RELEASE_1: gomTheoPin(DV.RELEASE_1),
  TEST_RUN: gomTheoPin(DV.TEST_RUN),
  RELEASE_2: gomTheoPin(DV.RELEASE_2),
  SAN_XUAT: gomTheoPin(DV.SAN_XUAT),
  CHO_KHO: gomTheoPin(DV.CHO_KHO),
  KIEM: gomTheoPin(DV.KIEM),
  SUA: gomTheoPin(DV.SUA),
  OQC: gomTheoPin(DV.OQC),
  FINISH: gomTheoPin(DV.GIAO),
};

// SQL `(phan_in_id, tg_vao, tg_ra)` cho 1 trạm. Trạm lạ → null để bên gọi tự lùi về hành vi cũ.
const nguonPhanIn = (maTram) => CP_PHAN_IN[maTram] || null;

// ─── Bộ lọc NGÀY PHỤ (thu hẹp tập đang xét — KHÔNG đụng định nghĩa 4 số) ─────
// ⚠ Whitelist CỨNG: giá trị từ client chỉ dùng để TRA khóa, không bao giờ nội suy vào SQL.
const LOAI_NGAY = {
  NGAY_VAI_VE: { ten: 'Ngày nhận vải', col: 'q.ngay_vai_ve', kieu: 'date' },
  TG_LEN_MES: { ten: 'Ngày ERP lên MES', col: 'q.tg_len_mes', kieu: 'ts' },
  HAN_GIAO: { ten: 'Hạn giao hàng', col: 'q.han_giao_hang', kieu: 'date' },
  NGAY_KE_HOACH: { ten: 'Ngày KH sản xuất', col: 'q.ngay_ke_hoach', kieu: 'date' },
  NGAY_RELEASE: { ten: 'Ngày release', col: 'q.ngay_release', kieu: 'ts' },
  NGAY_TRA_VE: { ten: 'Ngày trả về', col: 'q.tg_tra_ve', kieu: 'ts' },
};

// 4 ô. `ton_dau`/`ton_cuoi` là ẢNH CHỤP tại một mốc; `nhan`/`lam_duoc` là SỰ KIỆN trong kỳ.
const O_SI_SO = {
  ton_dau: { ten: 'Tồn đầu kỳ', dk: 'q.tg_vao < $1 AND (q.tg_ra IS NULL OR q.tg_ra >= $1)' },
  nhan: { ten: 'Nhận trong kỳ', dk: 'q.tg_vao >= $1 AND q.tg_vao < $2' },
  lam_duoc: { ten: 'Làm được trong kỳ', dk: 'q.tg_ra IS NOT NULL AND q.tg_ra >= $1 AND q.tg_ra < $2' },
  ton_cuoi: { ten: 'Tồn cuối kỳ', dk: 'q.tg_vao < $2 AND (q.tg_ra IS NULL OR q.tg_ra >= $2)' },
};

module.exports = { MAN, LOAI_NGAY, O_SI_SO, VN, CP_PHAN_IN, nguonPhanIn };
