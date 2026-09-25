'use strict';

const { query } = require('../../config/db');
// Hiển thị theo PHƯƠNG ÁN IN — cấu hình động (mig 067), mặc định BẬT HẾT = không lọc.
const { dkTrang } = require('../../utils/phuongAnIn');
// ⚠⚠ ĐÃ BỎ `khongReadyTuDongSql` KHỎI FILE NÀY (10/09/2026): 2 sidebar *Lịch sử* + *Đã hoàn thành*
//   của READY KT & QC READY nay HIỆN CẢ phần in đi thẳng PKH (ERP `KTCankiemtra=0`) — xem ghi chú ở
//   `listConfirmHistory` / `doneByDate`. Luật loại-khỏi-số-liệu vẫn còn hiệu lực ở sĩ số + báo cáo.
// ⚠ `conDotChoQcSql` KHÔNG import ở đây nữa (23/09/2026): màn QC dùng chung vị từ với màn Kỹ thuật —
//   xem ghi chú ở `OUTER_WHERE`. Helper đó nay chỉ còn phục vụ dải "Theo dõi" (`utils/siSoTram.js`).
const { techDoneSql, KHUON_OPT_SQL_LIST, nguoiXacNhanSql, conDotChuaReadySql, qcDotSql } = require('../../utils/tech');
const { slaReadySql, slaQcReadySql, slaReadyHanSql, canhBaoReadyHanSql } = require('../../utils/slaTheoGio');
// Phần in đang được trả về GIAO NHẬN sửa thông tin ⇒ rời màn READY cho tới khi GN xác nhận lại.
const { CHO_GN_SQL } = require('../../utils/traVeGn');
const { mauTim } = require('../../utils/timKiem');
const { sqlKhopMa } = require('../../utils/maPhanIn');

// Đọc cấu hình READY (version + trạm + checkpoint) trong 1 query (giảm round-trip tới DB ở xa).
async function loadReadyConfig() {
  const sql = `
    WITH v AS (
      SELECT id, ma_version, ten_version FROM workflow_version
      WHERE la_hien_hanh = true ORDER BY ngay_hieu_luc DESC LIMIT 1
    )
    SELECT v.id AS version_id, v.ma_version, v.ten_version,
           t.id AS tram_id, t.ma_tram, t.ten_tram, t.thu_tu AS tram_thu_tu, t.thoi_gian_quy_dinh_phut, t.canh_bao_truoc_phut,
           cp.id AS cp_id, cp.ma_checkpoint, cp.ten_checkpoint, cp.bat_buoc, cp.thu_tu AS cp_thu_tu,
           cp.cau_hinh_json, cp.thoi_gian_quy_dinh_phut AS cp_sla, cp.canh_bao_truoc_phut AS cp_cb,
           lc.ma_loai AS loai_checkpoint
    FROM v
    LEFT JOIN tram t ON t.workflow_version_id = v.id AND t.ma_tram = 'READY'
    LEFT JOIN checkpoint cp ON cp.tram_id = t.id AND cp.dang_hoat_dong = true
    LEFT JOIN loai_checkpoint lc ON lc.id = cp.loai_checkpoint_id
    ORDER BY cp.thu_tu`;
  const { rows } = await query(sql);
  return rows;
}

// Danh sách phần in cho READY.
//  - inputIds: id 3 checkpoint kỹ thuật (KHUON/FILM/MUC) → đếm n_tech_done.
//  - onlyQcReady=true: chỉ phần in đủ techTotal mục & chưa QC (màn QC bên Chất lượng).
//  - mặc định: phần in chưa QC xong (màn Chuẩn bị kỹ thuật).
async function listCandidates({
  search = '', inputIds = [], qcId, khuonId, filmId, mucId,
  onlyQcReady = false, offset = 0, limit = 20, readySla = null, readyCanhBao = null,
  qcSla = null, qcCanhBao = null, techTotal = 3,
}) {
  // Cùng 1 hàm phục vụ 2 màn: READY (Chuẩn bị kỹ thuật) và QC READY (Chất lượng) ⇒ 2 khóa cấu hình khác nhau.
  const dkPain = await dkTrang(onlyQcReady ? 'CL_QC_READY' : 'KT_READY', 'pin', 'pin.id');
  const SEARCH = `($1 = '' OR pin.ma_phan ~* $1 OR kh.ten_khach_hang ~* $1
                  OR dh.ma_don_hang ~* $1 OR mh.ma_hang ~* $1
                  OR pin.mau_vai ~* $1 OR pin.kich_vai ~* $1
                  OR pin.kich_phim ~* $1)`;
  const doneExpr = (param) =>
    `EXISTS (SELECT 1 FROM ket_qua_checkpoint k WHERE k.phan_in_id = pin.id AND k.checkpoint_id = ${param} AND k.trang_thai = 'DAT')`;
  // withItems=true: kèm cờ tình trạng từng mục (cho bảng); dùng $6..$9.
  // ⚠⚠ Cột `con_dot_chua_ready` — "đã Ready" nay là thuộc tính của ĐỢT VẢI (16/09/2026): `qc_done` mức
  //   phần in KHÔNG còn đủ để quyết định phần in có ở màn READY hay không, vì đợt vải về SAU mốc QC
  //   chưa được ai xác nhận cho nó. Nguồn luật chung: `utils/tech.js conDotChuaReadySql` (gương
  //   `dsDotChoReady`). ⚠ Chú thích để NGOÀI chuỗi SQL — backtick trong comment `--` bên trong
  //   template literal sẽ ĐÓNG CHUỖI JS sớm (bẫy §9, đã mắc khi viết cột này).
  const selectBase = (withItems) => `
    SELECT pin.id, pin.ma_phan,
           -- 2 loại mã vạch KHÁC NHAU, đừng nhầm: barcode_phan_in = ERP BarcodePTHDH, 1 mã ↔ 1 PHẦN IN
           -- (tương đương code phần) · barcode = mã ĐỢT VẢI (IDDotReady), dùng chung nhiều phần in.
           pin.barcode AS barcode_phan_in,
           (SELECT string_agg(DISTINCT dvb.barcode, ',') FROM dot_vai_ve dvb WHERE dvb.phan_in_id = pin.id AND dvb.barcode IS NOT NULL) AS barcode,
           pin.mau_vai, pin.kich_vai, pin.kich_phim,
           mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang,
           (SELECT string_agg(DISTINCT gs.ma_set, ', ')
              FROM dot_vai_ve dv JOIN gom_set_dot_vai gsd ON gsd.dot_vai_ve_id = dv.id
              JOIN gom_set gs ON gs.id = gsd.gom_set_id AND gs.trang_thai = 'MO'
              WHERE dv.phan_in_id = pin.id) AS gom_set_list,
           (SELECT string_agg(DISTINCT ldv.ten_loai, ', ')
              FROM dot_vai_ve dv3 JOIN loai_dot_vai ldv ON ldv.id = dv3.loai_dot_vai_id
              WHERE dv3.phan_in_id = pin.id AND dv3.trang_thai NOT IN ('DA_GOP','DA_HUY')) AS loai_dot_vai,
           -- Hạn giao = của đợt ĐANG CHỜ (chưa release), lùi về mọi đợt còn hiệu lực — 25/09/2026: đợt bổ sung
           -- từng hiện hạn của đợt số lượng đã release từ lâu (min mọi đợt) nên SLA theo hạn tính sai.
           COALESCE(
             (SELECT min(dv4.han_giao_hang) FROM dot_vai_ve dv4
               WHERE dv4.phan_in_id = pin.id AND dv4.trang_thai NOT IN ('DA_GOP','DA_HUY')
                 AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai lsh JOIN lenh_san_xuat lh ON lh.id = lsh.lenh_san_xuat_id
                                 WHERE lsh.dot_vai_ve_id = dv4.id AND lh.trang_thai <> 'HUY')),
             (SELECT min(dv7.han_giao_hang) FROM dot_vai_ve dv7
               WHERE dv7.phan_in_id = pin.id AND dv7.trang_thai NOT IN ('DA_GOP','DA_HUY'))
           ) AS han_giao_hang,
           -- "Thời gian ERP lên MES" = lúc đợt vải MỚI NHẤT lên (chốt 2026-08-07). Trước đây lấy MIN của
           -- MỌI đợt ⇒ phần in mở lại READY vì đợt vải mới vẫn hiện giờ của đợt CŨ (ca thật
           -- KN-2607-004-A02-F01-C02: đợt mới lên 07/08 11:09 nhưng cột hiện 06/08 13:05).
           -- Ưu tiên đợt CHƯA RELEASE (đợt đang thực sự nằm ở READY); không còn đợt nào chưa release
           -- (nhánh Test Run trả về — lệnh còn sống) thì lùi về đợt mới nhất trong các đợt còn hiệu lực.
           COALESCE(
             (SELECT max(dv5.tg_chuyen_ready) FROM dot_vai_ve dv5
               WHERE dv5.phan_in_id = pin.id AND dv5.trang_thai NOT IN ('DA_GOP','DA_HUY')
                 AND dv5.tg_chuyen_ready IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai lsr JOIN lenh_san_xuat lr ON lr.id = lsr.lenh_san_xuat_id
                                 WHERE lsr.dot_vai_ve_id = dv5.id AND lr.trang_thai <> 'HUY')),
             (SELECT max(dv6.tg_chuyen_ready) FROM dot_vai_ve dv6
               WHERE dv6.phan_in_id = pin.id AND dv6.trang_thai NOT IN ('DA_GOP','DA_HUY')
                 AND dv6.tg_chuyen_ready IS NOT NULL)
           ) AS tg_qua_ready,
           (SELECT count(*) FROM ket_qua_checkpoint k
              WHERE k.phan_in_id = pin.id AND k.checkpoint_id = ANY($2::uuid[]) AND k.trang_thai = 'DAT')::int AS n_tech_done,
           ${doneExpr('$3')} AS qc_done,
           ${conDotChuaReadySql('pin.id')} AS con_dot_chua_ready,
           EXISTS (SELECT 1 FROM dot_vai_ve dvr WHERE dvr.phan_in_id = pin.id AND dvr.trang_thai NOT IN ('DA_GOP','DA_HUY')
                     AND dvr.tg_chuyen_ready IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai lsr2 JOIN lenh_san_xuat lr2 ON lr2.id = lsr2.lenh_san_xuat_id
                                     WHERE lsr2.dot_vai_ve_id = dvr.id AND lr2.trang_thai <> 'HUY')) AS co_dot_chua_release${withItems ? `,
           ${doneExpr('$6')} AS khuon_done,
           ${doneExpr('$7')} AS film_done,
           ${doneExpr('$8')} AS muc_done,
           ${techDoneSql('kh.ten_khach_hang', doneExpr('$6'), doneExpr('$7'), doneExpr('$8'))} AS tech_done` : ''},
           hs.phuong_an_in, hs.barcode_hskt, hs.hskt_id, hs.hskt_inset,
           sla.ready_tg_vao, sla.kt_done_tg, sla.xn_sort_tg
    FROM phan_in pin
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    LEFT JOIN LATERAL (
      -- HSKT đang hoạt động của phần in (1 LATERAL thay 3 subquery cũ). hskt_inset = ERP Inset:
      -- 0 = không gom set; khác 0 = có gom set, các phần in CÙNG barcode_hskt là 1 nhóm gom set.
      SELECT h.phuong_an_in, h.barcode_hskt, h.id AS hskt_id, h.inset AS hskt_inset
        FROM hskt_phan_in hp JOIN ho_so_ky_thuat h ON h.id = hp.hskt_id
       WHERE hp.phan_in_id = pin.id AND hp.dang_hoat_dong AND h.dang_hoat_dong LIMIT 1
    ) hs ON true
    LEFT JOIN LATERAL (
      -- ready_tg_vao = mốc "vào READY" (ton_tram 029, fallback đợt vải về — đợt chưa release).
      -- kt_done_tg   = mốc KT hoàn tất = lần xác nhận MUỘN NHẤT trong 3 mục KHUON/FILM/MUC (bắt đầu đếm SLA QC).
      SELECT COALESCE(
               (SELECT min(tt.tg_vao) FROM ton_tram tt JOIN dot_vai_ve d2 ON d2.id = tt.dot_vai_ve_id
                  JOIN tram tr ON tr.id = tt.tram_id
                  WHERE d2.phan_in_id = pin.id AND tr.ma_tram = 'READY'),
               (SELECT min(COALESCE(dv.created_date, dv.ngay_vai_ve::timestamptz)) FROM dot_vai_ve dv
                  WHERE dv.phan_in_id = pin.id
                    AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai lsd WHERE lsd.dot_vai_ve_id = dv.id))
             ) AS ready_tg_vao,
             (SELECT max(COALESCE(k.tg_xac_nhan, k.created_date)) FROM ket_qua_checkpoint k
                WHERE k.phan_in_id = pin.id AND k.checkpoint_id = ANY($2::uuid[]) AND k.trang_thai = 'DAT') AS kt_done_tg,
             -- xn_sort_tg = mốc "vừa được xác nhận" dùng ĐỂ SẮP XẾP màn Kỹ thuật — CHỈ tính KHUON ($6)
             -- và MUC ($8), CỐ Ý BỎ FILM ($7): xác nhận Film không được đẩy phần in lên đầu danh sách.
             -- ⚠ Phải là cột RIÊNG, KHÔNG sửa kt_done_tg ở trên: kt_done_tg là mốc bắt đầu đếm SLA của
             -- QC (dòng tg_vao/sla_phut bên dưới) nên vẫn phải tính ĐỦ CẢ 3 mục.
             -- Tính CẢ dòng xác nhận THEO ĐỢT (ready_xac_nhan_dot, mig 098): từ khi xác nhận đi theo đợt vải,
             -- dòng TỔNG chỉ được ghi khi mọi đợt xong (và KHÔNG ghi lại nếu đã DAT từ đợt trước) nên chỉ đọc
             -- dòng tổng thì phần in vừa xác nhận KHÔNG nhảy lên đầu nữa (lỗi báo 21/09/2026).
             GREATEST(
               (SELECT max(COALESCE(k.tg_xac_nhan, k.created_date)) FROM ket_qua_checkpoint k
                  WHERE k.phan_in_id = pin.id AND k.checkpoint_id IN ($6, $8) AND k.trang_thai = 'DAT'),
               (SELECT max(COALESCE(x.tg_xac_nhan, x.updated_date)) FROM ready_xac_nhan_dot x
                  WHERE x.phan_in_id = pin.id AND x.checkpoint_id IN ($6, $8) AND x.trang_thai = 'DAT'
                    AND x.nguoi_xac_nhan_id IS NOT NULL)
             ) AS xn_sort_tg
    ) sla ON true
    -- Ở READY khi phần in CÒN đợt vải CHƯA release (đợt không nằm trong lệnh ≠ HUY), HOẶC chưa có đợt vải nào.
    -- ⇒ phần in đã release hết đợt thì rời READY; nhưng nếu "Mở lại READY" (hủy QC) mà còn đợt mới chưa release
    -- thì quay lại danh sách READY để làm lại kỹ thuật/QC (kể cả khi phần in đã có đợt sản xuất trước).
    -- Nhánh 3: TEST RUN KHÔNG ĐẠT trả về Kỹ thuật — lệnh được GIỮ NGUYÊN (để QC xong nhảy lại Test Run)
    -- nên đợt vải VẪN thuộc lệnh; không có nhánh này thì phần in sẽ KHÔNG hiện ở READY để làm lại.
    -- Nhận diện: đợt thuộc lệnh RELEASE_1 CHƯA có phiếu SX (kết hợp OUTER_WHERE q.qc_done = false).
    -- TỪ 15/09/2026 HỆ THỐNG ĐI THEO ĐỢT VẢI: phần in KHÔNG còn đợt vải sống (chỉ còn đợt DA_HUY/DA_GOP,
    -- hoặc chưa có đợt nào) KHÔNG còn ở READY — đã bỏ nhánh cũ "chưa có đợt vải nào". Đợt DA_HUY cũng
    -- không còn giữ phần in ở lại READY. Gương y hệt: countReadyItems · siSoTram.LAT_ROI_READY · datasets.READY_MEMBER.
    WHERE (EXISTS (SELECT 1 FROM dot_vai_ve dvu WHERE dvu.phan_in_id = pin.id AND dvu.trang_thai NOT IN ('DA_GOP','DA_HUY') AND dvu.tg_chuyen_ready IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai lsu JOIN lenh_san_xuat lu ON lu.id = lsu.lenh_san_xuat_id
                                     WHERE lsu.dot_vai_ve_id = dvu.id AND lu.trang_thai <> 'HUY'))
             OR EXISTS (SELECT 1 FROM dot_vai_ve dvt JOIN lenh_sx_dot_vai lst ON lst.dot_vai_ve_id = dvt.id
                          JOIN lenh_san_xuat lt ON lt.id = lst.lenh_san_xuat_id AND lt.trang_thai = 'RELEASE_1'
                         WHERE dvt.phan_in_id = pin.id AND dvt.trang_thai NOT IN ('DA_GOP','DA_HUY') AND dvt.tg_chuyen_ready IS NOT NULL
                           AND NOT EXISTS (SELECT 1 FROM phieu_san_xuat pst WHERE pst.lenh_san_xuat_id = lt.id)))
      AND pin.dang_hoat_dong
      AND NOT ${CHO_GN_SQL('pin.id')}
      AND ${dkPain}
      AND ${SEARCH}`;

  // CẢ 2 màn (Kỹ thuật & QC) hiển thị CÙNG danh sách READY chưa QC xong — khác nhau ở SLA nghẽn:
  //  - Màn Kỹ thuật: SLA trạm READY (KT chưa đủ → đếm; đủ 3 mục → NULL, ngừng đỏ).
  //  - Màn QC (onlyQcReady): SLA QC_XAC_NHAN, chỉ đếm khi ĐỦ 3 mục KT (kt_done_tg); KT chưa đủ → NULL (không đỏ ở QC).
  // QC chỉ XÁC NHẬN được phần in đủ 3 mục (guard ở service + FE), nhưng vẫn THẤY toàn bộ danh sách READY.
  const tt = Number.isInteger(techTotal) ? techTotal : 3; // số nguyên do code kiểm soát (an toàn khi nội suy)
  // ⚠⚠⚠ CÒN Ở READY = "còn đợt vải ĐANG CHỜ chưa được QC phủ" (đổi 16/09/2026), KHÔNG còn là
  //   `qc_done = false` mức phần in. Phần in có đợt 1 đã Ready (đang chờ release ở Release 1) + đợt 2
  //   vừa về ⇒ `qc_done` vẫn TRUE nhưng đợt 2 chưa ai làm ⇒ phải hiện lại ở READY.
  //   Giữ luôn vế `qc_done = false` để KHÔNG mất ca cũ: phần in bị QC/Test Run trả về (hủy dòng tổng)
  //   nhưng đợt vải của nó đã thuộc lệnh RELEASE_1 nên `conDotChuaReadySql` (chỉ xét đợt CHƯA release)
  //   không bắt được — đó chính là nhánh OR thứ 3 của WHERE bên trên.
  // ⚠⚠ Vế `qc_done = false` CHỈ còn áp khi phần in KHÔNG còn đợt chưa release (nhánh Test Run trả về —
  //   đợt đã thuộc lệnh RELEASE_1). Có đợt chưa release thì `con_dot_chua_ready` đã nói đủ; để vế
  //   `qc_done = false` chạy trần thì phần in mà mọi đợt đã được QC THEO ĐỢT (dòng tổng chưa có) vẫn
  //   bị kéo lại màn READY dù không còn việc gì (21/09/2026).
  // ⚠⚠⚠ 2 MÀN (Kỹ thuật + QC) DÙNG CHUNG MỘT VỊ TỪ — ĐẢO LẠI thay đổi 21/09/2026 (người dùng chốt
  //   23/09/2026: *"lúc bên READY Kỹ thuật chưa xác nhận đủ thì vẫn hiện danh sách phần in ở đây mà;
  //   cái tôi nói hiện khi Ready kỹ thuật xác nhận đủ checklist là ở phần SĨ SỐ góc trên bên phải thôi,
  //   chứ danh sách vẫn cho như cũ"*).
  //   Bản 21/09 lọc màn QC bằng `con_dot_cho_qc` (đợt KT ĐÃ XONG) ⇒ đo prod 23/09: bảng tụt từ
  //   **105 phần in xuống ~5** — QC gần như không còn gì để xem, mất luôn khả năng theo dõi hàng sắp tới.
  // ⚠⚠ HỆ QUẢ CỐ Ý: dải "Theo dõi" của màn QC (`DV.READY_QC` — GIỮ NGUYÊN `conDotChoQcSql`) đếm ÍT HƠN
  //   số dòng trên bảng, vì nó đo ĐÚNG hàng đợi của QC còn bảng cho thấy toàn cảnh READY.
  //   **ĐỪNG "sửa cho khớp"** — cùng họ với chênh lệch đã ghi ở §6 (*Đã hoàn thành* đếm lượt xác nhận,
  //   dải Theo dõi đếm phần in rời trạm).
  // ⚠ QC vẫn CHỈ XÁC NHẬN ĐƯỢC phần in đủ mục KT — chặn ở `confirmQC` (409 `TECH_NOT_DONE`) + FE khóa
  //   checkbox theo `tech_done`. Hiện ra để THẤY, không phải để bấm.
  const OUTER_WHERE = 'WHERE q.con_dot_chua_ready OR (NOT q.co_dot_chua_release AND q.qc_done = false)';

  // SLA theo GIAI ĐOẠN (task 3): $11=onlyQcReady. Màn QC → SLA QC_XAC_NHAN ($12) đếm từ kt_done_tg;
  // màn Kỹ thuật → SLA trạm READY ($9) từ ready_tg_vao, và KHI ĐỦ 3 mục KT → sla NULL (ngừng đếm, không đỏ ở KT).
  // Gộp data + total vào 1 query bằng COUNT(*) OVER() (1 round-trip thay vì 2).
  const dataSql = `
    SELECT q.*,
           CASE WHEN $11 THEN (CASE WHEN q.tech_done THEN q.kt_done_tg ELSE NULL END) ELSE q.ready_tg_vao END AS tg_vao,
           CASE WHEN $11 THEN (CASE WHEN q.tech_done THEN ${slaQcReadySql('q.kt_done_tg', '$12::int')} ELSE NULL END) WHEN q.tech_done THEN NULL ELSE ${slaReadyHanSql('q.ready_tg_vao', 'q.han_giao_hang', 'q.ready_tg_vao', '$9::int')} END AS sla_phut,
           CASE WHEN $11 THEN $13::int ELSE ${canhBaoReadyHanSql('q.han_giao_hang', '$10::int')} END AS canh_bao_truoc_phut,
           count(*) OVER()::int AS total_count
    FROM (${selectBase(true)}) q
    ${OUTER_WHERE}
    -- MÀN KỸ THUẬT: phần in VỪA ĐƯỢC XÁC NHẬN lên ĐẦU danh sách.
    -- ⚠ CHỈ tính KHUÔN và MỰC — xác nhận FILM KHÔNG đẩy phần in lên đầu (yêu cầu nghiệp vụ).
    -- Mốc lấy từ xn_sort_tg (LATERAL sla ở trên); tg_xac_nhan được GHI ĐÈ mỗi lần xác nhận lại nên
    -- nó luôn là "vừa mới xác nhận lúc nào". Phần in chưa xác nhận Khuôn/Mực (NULL) xuống cuối, nên
    -- phải ghi rõ NULLS LAST (Postgres DESC mặc định là NULLS FIRST).
    -- MÀN QC ($11 = onlyQcReady): giữ NGUYÊN thứ tự cũ — CASE cho ra NULL ở mọi dòng nên hòa,
    -- rơi xuống 2 khóa sắp xếp cũ bên dưới.
    -- (KHÔNG viết dấu backtick trong comment SQL nằm trong template literal — nó đóng chuỗi JS sớm.)
    ORDER BY (CASE WHEN $11 THEN NULL::timestamptz ELSE q.xn_sort_tg END) DESC NULLS LAST,
             q.n_tech_done DESC, q.ma_phan
    LIMIT $4 OFFSET $5`;

  const { rows } = await query(dataSql, [mauTim(search), inputIds, qcId, limit, offset, khuonId, filmId, mucId, readySla, readyCanhBao, onlyQcReady, qcSla, qcCanhBao]);
  const total = rows.length ? rows[0].total_count : 0;
  // Bỏ cột phụ total_count khỏi từng dòng trả về.
  const items = rows.map(({ total_count, ...r }) => r);
  return { rows: items, total };
}

// Đếm SỐ PHẦN IN CHƯA XÁC NHẬN từng mục (KHUON/FILM/MUC) trên TOÀN HỆ THỐNG (không phân trang).
// Chỉ tính phần in còn ở READY: chưa release (không có đợt vải trong lệnh ≠ HUY) & chưa QC_XAC_NHAN.
async function countReadyItems({ khuonId, filmId, mucId, qcId }) {
  const doneExpr = (param) =>
    `EXISTS (SELECT 1 FROM ket_qua_checkpoint k WHERE k.phan_in_id = pin.id AND k.checkpoint_id = ${param} AND k.trang_thai = 'DAT')`;
  const sql = `
    SELECT count(*) FILTER (WHERE NOT khuon_done AND khach NOT IN (${KHUON_OPT_SQL_LIST}))::int AS khuon,
           count(*) FILTER (WHERE NOT film_done AND khach NOT IN (${KHUON_OPT_SQL_LIST}))::int AS film,
           count(*) FILTER (WHERE NOT muc_done)::int AS muc
    FROM (
      SELECT ${doneExpr('$1')} AS khuon_done, ${doneExpr('$2')} AS film_done, ${doneExpr('$3')} AS muc_done,
             kh.ten_khach_hang AS khach
      FROM phan_in pin
      JOIN ma_hang mh ON mh.id = pin.ma_hang_id
      JOIN don_hang dh ON dh.id = mh.don_hang_id
      JOIN khach_hang kh ON kh.id = dh.khach_hang_id
      WHERE EXISTS (SELECT 1 FROM dot_vai_ve dvu WHERE dvu.phan_in_id = pin.id AND dvu.trang_thai NOT IN ('DA_GOP','DA_HUY') AND dvu.tg_chuyen_ready IS NOT NULL
                       AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai lsu JOIN lenh_san_xuat lu ON lu.id = lsu.lenh_san_xuat_id
                                       WHERE lsu.dot_vai_ve_id = dvu.id AND lu.trang_thai <> 'HUY'))
        AND pin.dang_hoat_dong AND NOT ${CHO_GN_SQL('pin.id')}
        AND ${conDotChuaReadySql('pin.id')} AND ($4::uuid IS NULL OR true)
    ) q`;
  // ⚠ Đã có đợt chưa release (WHERE trên) thì "còn ở READY" = còn đợt chưa Ready — gương OUTER_WHERE của
  //   `listCandidates` (21/09/2026). `$4` giữ trong chữ ký để không đổi call-site.
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [khuonId, filmId, mucId, qcId]);
  return { khuon: rows[0]?.khuon || 0, film: rows[0]?.film || 0, muc: rows[0]?.muc || 0 };
}

// Lịch sử xác nhận theo ngày (giờ VN). scope: 'tech' (4 mục) | 'qc' (QC_XAC_NHAN).
async function historyByDate(date, maList) {
  const sql = `
    SELECT l.tg_thuc_hien AS tg, nd.ho_ten AS nguoi, l.ly_do AS hanh_dong,
           pin.ma_phan, mh.ma_hang, kh.ten_khach_hang, kq.gia_tri_text AS chi_tiet
    FROM lich_su_trang_thai l
    JOIN ket_qua_checkpoint kq ON kq.id = l.ket_qua_checkpoint_id
    JOIN checkpoint cp ON cp.id = kq.checkpoint_id
    JOIN tram t ON t.id = cp.tram_id
    JOIN phan_in pin ON pin.id = kq.phan_in_id
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    LEFT JOIN nguoi_dung nd ON nd.id = l.nguoi_thuc_hien_id
    WHERE t.ma_tram = 'READY' AND cp.ma_checkpoint = ANY($2)
      AND (l.tg_thuc_hien AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $1::date
    ORDER BY l.tg_thuc_hien DESC`;
  const { rows } = await query(sql, [date, maList]);
  return rows;
}

// Lịch sử xác nhận READY (mức phần in) đang hiệu lực (DAT) theo ngày — cho trang "Lịch sử trạng thái"
// ở module Hệ thống. Admin có thể xóa mềm (hủy) từng dòng để người phụ trách xác nhận lại.
//
// ⚠⚠⚠ HIỆN CẢ PHẦN IN ĐI THẲNG PKH (không qua PKT) — chốt 10/09/2026, ĐẢO chốt 19/08/2026 cho RIÊNG
//   2 sidebar này. Đợt vải ERP `KTCankiemtra = 0` được `simulateReadyDone` đặt hộ DAT; luật cũ loại
//   chúng khỏi **mọi** danh sách READY nên **không còn chỗ nào tra ra** phần in nào đã đi thẳng, đi
//   lúc nào. Nay chúng hiện lại, cột "Người" ghi rõ **"Hệ thống (tự động)"** (xem `nguoiXacNhanSql`)
//   nên không lẫn với việc người thật làm. Đo prod 10/09: **+768 dòng / 192 phần in**.
// ⚠ Luật loại-khỏi-SỐ-LIỆU vẫn GIỮ ở dải "Theo dõi" (`utils/siSoTram.js`) + metric/dataset báo cáo —
//   đó là chỗ đo KHỐI LƯỢNG VIỆC của tổ kỹ thuật, tính vào là thổi phồng. ⇒ **sidebar sẽ nhiều hơn ô
//   "Làm được trong kỳ"**; đây là CỐ Ý, cùng họ với chênh lệch đã ghi ở §6 (Đã hoàn thành đếm theo
//   lượt xác nhận, dải Theo dõi đếm phần in rời trạm). Đừng "sửa cho khớp".
async function listConfirmHistory({ date, search = '' }) {
  const sql = `
    SELECT kq.id AS ket_qua_id, kq.phan_in_id, cp.ma_checkpoint, cp.ten_checkpoint,
           kq.gia_tri_text, kq.tg_xac_nhan, ${nguoiXacNhanSql('nx', 'kq')} AS nguoi_xac_nhan, kq.ghi_chu,
           pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim,
           mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang
    FROM ket_qua_checkpoint kq
    JOIN checkpoint cp ON cp.id = kq.checkpoint_id
    JOIN tram t ON t.id = cp.tram_id
    JOIN phan_in pin ON pin.id = kq.phan_in_id
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    LEFT JOIN nguoi_dung nx ON nx.id = kq.nguoi_xac_nhan_id
    WHERE t.ma_tram = 'READY' AND kq.trang_thai = 'DAT'
      AND (kq.tg_xac_nhan AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $1::date
      AND ($2 = '' OR pin.ma_phan ~* $2 OR mh.ma_hang ~* $2
           OR kh.ten_khach_hang ~* $2 OR dh.ma_don_hang ~* $2
           OR pin.mau_vai ~* $2 OR pin.kich_vai ~* $2 OR pin.kich_phim ~* $2)
    ORDER BY kq.tg_xac_nhan DESC NULLS LAST`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [date, mauTim(search)]);
  return rows;
}

// Danh sách phần in ĐÃ HOÀN THÀNH checkpoint READY theo ngày (giờ VN) — cho DonePanel.
//  scope='tech': phần in đủ 3 mục kỹ thuật (mốc hoàn thành = lần xác nhận mục cuối cùng trong ngày).
//  scope='qc':   phần in đã QC_XAC_NHAN = DAT trong ngày.
// ⚠⚠ HIỆN CẢ PHẦN IN ĐI THẲNG PKH (không qua PKT) từ 10/09/2026 — lý do + đánh đổi ghi đầy đủ ở
//   `listConfirmHistory` ngay trên. Cột "Người" của nhóm này là **"Hệ thống (tự động)"**.
async function doneByDate(date, scope = 'tech') {
  const info = `pin.ma_phan AS ma, pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.so_luong_don_hang AS so_luong,
                pin.tinh_chat_in, mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang,
                (SELECT h.phuong_an_in FROM hskt_phan_in hp JOIN ho_so_ky_thuat h ON h.id = hp.hskt_id
                  WHERE hp.phan_in_id = pin.id AND hp.dang_hoat_dong AND h.dang_hoat_dong LIMIT 1) AS phuong_an_in,
                (SELECT min(dv.han_giao_hang) FROM dot_vai_ve dv WHERE dv.phan_in_id = pin.id AND dv.trang_thai NOT IN ('DA_GOP','DA_HUY')) AS han_giao_hang`;
  const joins = `JOIN ma_hang mh ON mh.id = pin.ma_hang_id
                 JOIN don_hang dh ON dh.id = mh.don_hang_id
                 JOIN khach_hang kh ON kh.id = dh.khach_hang_id`;
  let sql;
  if (scope === 'qc') {
    sql = `
      SELECT kq.tg_xac_nhan AS tg, ${nguoiXacNhanSql('nx', 'kq')} AS nguoi, kq.ghi_chu, ${info}
      FROM ket_qua_checkpoint kq
      JOIN checkpoint cp ON cp.id = kq.checkpoint_id
      JOIN tram t ON t.id = cp.tram_id
      JOIN phan_in pin ON pin.id = kq.phan_in_id
      ${joins}
      LEFT JOIN nguoi_dung nx ON nx.id = kq.nguoi_xac_nhan_id
      WHERE t.ma_tram = 'READY' AND cp.ma_checkpoint = 'QC_XAC_NHAN' AND kq.trang_thai = 'DAT'
        AND (kq.tg_xac_nhan AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $1::date
      UNION ALL
      SELECT x.tg_xac_nhan AS tg, ${nguoiXacNhanSql('nx', 'x')} AS nguoi,
             'QC theo đợt vải ' || COALESCE(dvx.barcode, dvx.ma_dot_vai) AS ghi_chu, ${info}
      FROM ready_xac_nhan_dot x
      JOIN checkpoint cp ON cp.id = x.checkpoint_id AND cp.ma_checkpoint = 'QC_XAC_NHAN'
      JOIN dot_vai_ve dvx ON dvx.id = x.dot_vai_ve_id
      JOIN phan_in pin ON pin.id = x.phan_in_id
      ${joins}
      LEFT JOIN nguoi_dung nx ON nx.id = x.nguoi_xac_nhan_id
      WHERE x.trang_thai = 'DAT' AND x.nguoi_xac_nhan_id IS NOT NULL
        AND (x.tg_xac_nhan AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $1::date
      ORDER BY 1 DESC`;
  } else {
    sql = `
      WITH tech AS (
        SELECT kq.phan_in_id, cp.ma_checkpoint, kq.tg_xac_nhan, kq.nguoi_xac_nhan_id, kq.ghi_chu
        FROM ket_qua_checkpoint kq
        JOIN checkpoint cp ON cp.id = kq.checkpoint_id
        JOIN tram t ON t.id = cp.tram_id
        WHERE t.ma_tram = 'READY' AND cp.ma_checkpoint IN ('KHUON','FILM','MUC') AND kq.trang_thai = 'DAT'
      ),
      agg AS (
        SELECT phan_in_id, max(tg_xac_nhan) AS tg_done,
               bool_or(ma_checkpoint='KHUON') AS hk, bool_or(ma_checkpoint='FILM') AS hf, bool_or(ma_checkpoint='MUC') AS hm
        FROM tech GROUP BY phan_in_id
      )
      SELECT a.tg_done AS tg, ${nguoiXacNhanSql('nx', 'last')} AS nguoi, last.ghi_chu, ${info}
      FROM agg a
      JOIN phan_in pin ON pin.id = a.phan_in_id
      ${joins}
      LEFT JOIN LATERAL (SELECT nguoi_xac_nhan_id, ghi_chu FROM tech WHERE phan_in_id = a.phan_in_id
                         ORDER BY tg_xac_nhan DESC NULLS LAST LIMIT 1) last ON true
      LEFT JOIN nguoi_dung nx ON nx.id = last.nguoi_xac_nhan_id
      WHERE (a.tg_done AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $1::date
        AND ${techDoneSql('kh.ten_khach_hang', 'a.hk', 'a.hf', 'a.hm')}
      ORDER BY a.tg_done DESC`;
  }
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [date]);
  return rows;
}

// Phần in đã release chưa? (có đợt vải nằm trong 1 lệnh ≠ HUY). Lệnh 'HUY' coi như chưa release.
// HỦY XÁC NHẬN READY — chỉ chặn khi phần in ĐÃ RELEASE HẾT (chốt 2026-08-03).
// Trước đây chặn ngay khi có BẤT KỲ đợt vải nào đã release, kể cả đợt CŨ đã sản xuất xong từ lâu ⇒
// đợt vải MỚI đang nằm ở READY cũng không sửa được xác nhận Khuôn/Film/Mực. Nay: còn ít nhất 1 đợt
// CHƯA release thì vẫn hủy được (phần in thật sự vẫn đang ở READY cho đợt đó).
//   `da_release` = có đợt đã vào lệnh non-HUY · `con_cho` = còn đợt CHƯA vào lệnh nào.
// ⚠ "Chưa release" = đợt KHÔNG có lệnh non-HUY NÀO. Đợt release TỪNG PHẦN (còn `con_release` nhưng
// đã có lệnh) KHÔNG tính là chưa release — phần đã release có thể đang chạy máy.
// ⚠ Phần in CHƯA có đợt vải nào (kỹ thuật làm trước khi vải về) ⇒ `da_release=false` ⇒ vẫn hủy được.
async function readyCancelState(phanInId) {
  const { rows } = await query(
    `SELECT
       EXISTS (SELECT 1 FROM dot_vai_ve dv JOIN lenh_sx_dot_vai lsd ON lsd.dot_vai_ve_id = dv.id
               JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id
               WHERE dv.phan_in_id = $1 AND ls.trang_thai <> 'HUY') AS da_release,
       EXISTS (SELECT 1 FROM dot_vai_ve dv
               WHERE dv.phan_in_id = $1 AND dv.trang_thai NOT IN ('DA_GOP','DA_HUY')
                 AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai lsd2
                                 JOIN lenh_san_xuat ls2 ON ls2.id = lsd2.lenh_san_xuat_id
                                 WHERE lsd2.dot_vai_ve_id = dv.id AND ls2.trang_thai <> 'HUY')) AS con_cho`
      .replace(/\s+/g, ' '),
    [phanInId]
  );
  const r = rows[0] || {};
  return { da_release: r.da_release === true, con_cho: r.con_cho === true };
}

// TRA CỨU MÃ QUÉT — giải thích vì sao quét ra "Không thấy" ở màn READY / QC READY.
// `listCandidates` chỉ trả phần in CÒN ở READY (`WHERE q.qc_done = false`) ⇒ phần in vừa QC xong,
// đã release hết đợt, hoặc bị hủy sẽ biến mất khỏi danh sách và người quét không có manh mối nào
// (ca thật 06/08/2026: SLGLOVIS-2604-008-A010-F03-C01 QC xác nhận lúc 14:22, người sau quét lúc
// 14:48 chỉ thấy "Không thấy (QR)" nên tưởng máy quét hỏng, đi tìm nguyên nhân ở gom set).
// Khớp CHÍNH XÁC theo `ma_phan`, `phan_in.barcode` (ERP BarcodePTHDH — mã vạch của chính phần in),
// lùi về `dot_vai_ve.barcode` (đầu đọc quét mã vạch đợt vải).
// ⚠ `phan_in.barcode` CÓ THỂ LÀ DANH SÁCH nhiều mã ⇒ so từng mã bằng `sqlKhopMa`, KHÔNG so nguyên chuỗi.
// Trả 1 dòng hoặc rỗng; service dựng câu mô tả.
async function traCuuMaQuet(code) {
  const sql = `
    SELECT pin.ma_phan, pin.dang_hoat_dong, ${CHO_GN_SQL('pin.id')} AS dang_o_gn,
           kq.tg_xac_nhan AS qc_tg, nd.ho_ten AS qc_nguoi,
           (kq.id IS NOT NULL) AS qc_done,
           EXISTS (SELECT 1 FROM dot_vai_ve dv2
                    WHERE dv2.phan_in_id = pin.id AND dv2.trang_thai NOT IN ('DA_GOP','DA_HUY')
                      AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai lsd
                                      JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id
                                      WHERE lsd.dot_vai_ve_id = dv2.id AND ls.trang_thai <> 'HUY')) AS con_dot_cho,
           (SELECT count(*) FROM dot_vai_ve dv3
             WHERE dv3.phan_in_id = pin.id AND dv3.trang_thai NOT IN ('DA_GOP','DA_HUY'))::int AS so_dot_vai
    FROM phan_in pin
    LEFT JOIN LATERAL (
      SELECT k.id, k.tg_xac_nhan, k.nguoi_xac_nhan_id
        FROM ket_qua_checkpoint k
        JOIN checkpoint cp ON cp.id = k.checkpoint_id
        JOIN tram t ON t.id = cp.tram_id
       WHERE k.phan_in_id = pin.id AND t.ma_tram = 'READY' AND cp.ma_checkpoint = 'QC_XAC_NHAN'
         AND k.trang_thai = 'DAT' LIMIT 1
    ) kq ON true
    LEFT JOIN nguoi_dung nd ON nd.id = kq.nguoi_xac_nhan_id
    WHERE pin.ma_phan = $1 OR ${sqlKhopMa('pin.barcode', '$1')}
       OR EXISTS (SELECT 1 FROM dot_vai_ve dv WHERE dv.phan_in_id = pin.id AND dv.barcode = $1)
    ORDER BY pin.dang_hoat_dong DESC LIMIT 1`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [code]);
  return rows[0] || null;
}

async function isPhanInReleased(phanInId) {
  const { rows } = await query(
    `SELECT EXISTS (SELECT 1 FROM dot_vai_ve dv JOIN lenh_sx_dot_vai lsd ON lsd.dot_vai_ve_id = dv.id
                    JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id
                    WHERE dv.phan_in_id = $1 AND ls.trang_thai <> 'HUY') AS released`,
    [phanInId]
  );
  return rows[0]?.released === true;
}

// Lệnh ĐANG CHỜ KỸ THUẬT của 1 phần in = lệnh RELEASE_1 CHƯA có phiếu SX (Test Run trả về nhưng lệnh
// được GIỮ NGUYÊN). Dùng ở `confirmQC`: QC xác nhận xong thì đẩy đợt vải của lệnh này THẲNG về TEST_RUN
// (không qua Release 1).
async function lenhChoKyThuatByPhanIn(phanInId) {
  const { rows } = await query(
    `SELECT ls.id AS lenh_id, array_agg(DISTINCT lsd.dot_vai_ve_id::text) AS dot_vai_ids
       FROM lenh_san_xuat ls JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
       JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
      WHERE ls.trang_thai = 'RELEASE_1' AND dv.phan_in_id = $1
        AND NOT EXISTS (SELECT 1 FROM phieu_san_xuat ps WHERE ps.lenh_san_xuat_id = ls.id)
      GROUP BY ls.id ORDER BY max(ls.created_date) DESC LIMIT 1`.replace(/\s+/g, ' '),
    [phanInId]
  );
  return rows[0] || null;
}

async function getPhanInBasic(phanInId) {
  const { rows } = await query(
    `SELECT pin.id, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim,
            mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang
     FROM phan_in pin
     JOIN ma_hang mh ON mh.id = pin.ma_hang_id
     JOIN don_hang dh ON dh.id = mh.don_hang_id
     JOIN khach_hang kh ON kh.id = dh.khach_hang_id
     WHERE pin.id = $1`,
    [phanInId]
  );
  return rows[0] || null;
}

// Kết quả checkpoint của phần in tại 1 trạm (merge cấu hình + kết quả hiện có).
// ⚠ `kq_updated_date` để `getDetail` suy "đợt này đã được QC phủ chưa" bằng ĐÚNG mốc mà
//   `utils/tech.js qcDotSql` dùng: COALESCE(tg_xac_nhan, updated_date). Thiếu cột này thì 2 nơi so
//   theo 2 mốc khác nhau ⇒ panel và bảng nói khác nhau.
// ⚠⚠ Chú thích để NGOÀI chuỗi SQL — backtick trong comment `--` bên trong template literal ĐÓNG
//   CHUỖI JS sớm (bẫy §9; vừa mắc lại khi thêm đúng cột này).
async function getResults(tramId, phanInId) {
  const { rows } = await query(
    `SELECT cp.id AS checkpoint_id, cp.ma_checkpoint, cp.ten_checkpoint, cp.bat_buoc, cp.thu_tu,
            cp.cau_hinh_json, cp.thoi_gian_quy_dinh_phut, cp.canh_bao_truoc_phut, lc.ma_loai AS loai_checkpoint,
            kq.id AS ket_qua_id, kq.trang_thai, kq.gia_tri_text, kq.gia_tri_json,
            kq.nguoi_xac_nhan_id, kq.tg_xac_nhan, nx.ho_ten AS nguoi_xac_nhan_ten, kq.ghi_chu,
            kq.updated_date AS kq_updated_date,
            (SELECT kh.ten_khach_hang FROM phan_in p JOIN ma_hang mh ON mh.id=p.ma_hang_id
               JOIN don_hang dh ON dh.id=mh.don_hang_id JOIN khach_hang kh ON kh.id=dh.khach_hang_id
               WHERE p.id=$2) AS ten_khach_hang
     FROM checkpoint cp
     LEFT JOIN loai_checkpoint lc ON lc.id = cp.loai_checkpoint_id
     LEFT JOIN ket_qua_checkpoint kq ON kq.checkpoint_id = cp.id AND kq.phan_in_id = $2
     LEFT JOIN nguoi_dung nx ON nx.id = kq.nguoi_xac_nhan_id
     WHERE cp.tram_id = $1 AND cp.dang_hoat_dong = true
     ORDER BY cp.thu_tu`,
    [tramId, phanInId]
  );
  return rows;
}

// Trạng thái DAT của nhiều phần in cho 1 nhóm checkpoint (dùng cho bulk — 1 query).
async function getBulkStates(phanInIds, checkpointIds) {
  const { rows } = await query(
    `SELECT phan_in_id, checkpoint_id FROM ket_qua_checkpoint
     WHERE phan_in_id = ANY($1::uuid[]) AND checkpoint_id = ANY($2::uuid[]) AND trang_thai = 'DAT'`,
    [phanInIds, checkpointIds]
  );
  return rows;
}

async function findResultId(client, phanInId, checkpointId) {
  const { rows } = await client.query(
    'SELECT id, trang_thai FROM ket_qua_checkpoint WHERE phan_in_id = $1 AND checkpoint_id = $2',
    [phanInId, checkpointId]
  );
  return rows[0] || null;
}

// Upsert 1 kết quả checkpoint. Trả về id.
async function upsertResult(client, data) {
  const existing = await findResultId(client, data.phanInId, data.checkpointId);
  if (existing) {
    await client.query(
      // ⚠⚠ XÓA `ghi_chu`: cột này chỉ mang dấu "Hệ thống tự xác nhận" của `simulateReadyDone`
      //   (ERP KTCankiemtra=0). Khi NGƯỜI THẬT xác nhận đè lên thì dấu đó KHÔNG còn đúng nữa —
      //   giữ lại là màn READY hiện tên người thật kèm ghi chú "hệ thống tự làm", mâu thuẫn nhau.
      //   An toàn: đo prod 19/08 chỉ 1/7456 dòng có `ghi_chu`, không ai dùng cột này việc khác.
      `UPDATE ket_qua_checkpoint SET
         trang_thai = $2,
         gia_tri_text = COALESCE($3, gia_tri_text),
         nguoi_xac_nhan_id = COALESCE($4, nguoi_xac_nhan_id),
         tg_xac_nhan = COALESCE($5, tg_xac_nhan),
         ghi_chu = NULL,
         updated_by = $6, updated_date = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [existing.id, data.trangThai, data.giaTriText ?? null, data.nguoiXacNhanId ?? null,
       data.tgXacNhan ?? null, data.actorId]
    );
    return existing.id;
  }
  const { rows } = await client.query(
    `INSERT INTO ket_qua_checkpoint
       (checkpoint_id, phan_in_id, trang_thai, gia_tri_text, nguoi_xac_nhan_id, tg_xac_nhan, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [data.checkpointId, data.phanInId, data.trangThai, data.giaTriText ?? null,
     data.nguoiXacNhanId ?? null, data.tgXacNhan ?? null, data.actorId]
  );
  return rows[0].id;
}

// Thời điểm phần in vào trạm READY — ưu tiên ton_tram (029), fallback thời điểm đợt vải về (ERP).
async function getReadyEntryTime(phanInId) {
  const { rows } = await query(
    `SELECT COALESCE(
              (SELECT min(tt.tg_vao) FROM ton_tram tt JOIN dot_vai_ve dv ON dv.id = tt.dot_vai_ve_id
                 JOIN tram t ON t.id = tt.tram_id WHERE dv.phan_in_id = $1 AND t.ma_tram = 'READY'),
              (SELECT min(COALESCE(dv.created_date, dv.ngay_vai_ve::timestamptz)) FROM dot_vai_ve dv
                 WHERE dv.phan_in_id = $1
                   AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai lsd WHERE lsd.dot_vai_ve_id = dv.id))
            ) AS ready_tg_vao`.replace(/\s+/g, ' '),
    [phanInId]
  );
  return rows[0]?.ready_tg_vao || null;
}

// Hủy 1 kết quả checkpoint đã DAT (bấm nhầm) → trang_thai='HUY', xóa người/giờ xác nhận.
async function cancelResult(client, phanInId, checkpointId, actorId) {
  const { rowCount } = await client.query(
    // ⚠ Xóa cả `ghi_chu` — dấu "Hệ thống tự xác nhận" không được sống sót qua lần hủy.
    `UPDATE ket_qua_checkpoint SET trang_thai = 'HUY', nguoi_xac_nhan_id = NULL, tg_xac_nhan = NULL,
       ghi_chu = NULL, updated_by = $3, updated_date = CURRENT_TIMESTAMP
     WHERE phan_in_id = $1 AND checkpoint_id = $2 AND trang_thai = 'DAT'`,
    [phanInId, checkpointId, actorId]
  );
  return rowCount > 0;
}

// Ghi audit hủy xác nhận.
async function logCancel(phanInId, maList, actorId) {
  await query(
    `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ('ket_qua_checkpoint', $1, 'HUY_XAC_NHAN', $2::jsonb, $3, CURRENT_TIMESTAMP, $3)`,
    [String(phanInId), JSON.stringify({ ma: maList }), actorId]
  );
}

async function insertStatusLog(client, { ketQuaId, trangThaiMoiId, nguoiId, lyDo }) {
  await client.query(
    `INSERT INTO lich_su_trang_thai
       (ket_qua_checkpoint_id, trang_thai_moi_id, ly_do, nguoi_thuc_hien_id, tg_thuc_hien, created_by)
     VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP,$4)`,
    [ketQuaId, trangThaiMoiId, lyDo || null, nguoiId]
  );
}

// ─── "Mở READY" (admin) ─────────────────────────────────────────────────────
// Danh sách phần in "đi tắt READY": ĐÃ qua READY (QC_XAC_NHAN=DAT) & đã có đợt sản xuất (lệnh ≠ HUY),
// NHƯNG còn ≥1 đợt vải MỚI chưa release → đợt mới tự vào Release 1 không qua READY. Admin có thể ép về READY.
async function listReopenCandidates({ search = '' }) {
  const sql = `
    SELECT pin.id AS phan_in_id, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim,
           mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang,
           (SELECT count(*) FROM dot_vai_ve d WHERE d.phan_in_id = pin.id AND d.trang_thai <> 'DA_GOP'
              AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai l JOIN lenh_san_xuat ls ON ls.id = l.lenh_san_xuat_id
                              WHERE l.dot_vai_ve_id = d.id AND ls.trang_thai <> 'HUY'))::int AS so_dot_moi,
           (SELECT string_agg(d.ma_dot_vai, ', ' ORDER BY d.ma_dot_vai) FROM dot_vai_ve d WHERE d.phan_in_id = pin.id AND d.trang_thai <> 'DA_GOP'
              AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai l JOIN lenh_san_xuat ls ON ls.id = l.lenh_san_xuat_id
                              WHERE l.dot_vai_ve_id = d.id AND ls.trang_thai <> 'HUY')) AS dot_moi,
           (SELECT string_agg(DISTINCT ls.ma_lenh_san_xuat, ', ') FROM dot_vai_ve d
              JOIN lenh_sx_dot_vai l ON l.dot_vai_ve_id = d.id JOIN lenh_san_xuat ls ON ls.id = l.lenh_san_xuat_id
              WHERE d.phan_in_id = pin.id AND ls.trang_thai <> 'HUY') AS lenh_da_co
    FROM phan_in pin
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    WHERE pin.dang_hoat_dong
      AND EXISTS (SELECT 1 FROM ket_qua_checkpoint k JOIN checkpoint cp ON cp.id = k.checkpoint_id
                    JOIN tram t ON t.id = cp.tram_id JOIN workflow_version wv ON wv.id = t.workflow_version_id AND wv.la_hien_hanh
                    WHERE k.phan_in_id = pin.id AND t.ma_tram = 'READY' AND cp.ma_checkpoint = 'QC_XAC_NHAN' AND k.trang_thai = 'DAT')
      AND EXISTS (SELECT 1 FROM dot_vai_ve d JOIN lenh_sx_dot_vai l ON l.dot_vai_ve_id = d.id
                    JOIN lenh_san_xuat ls ON ls.id = l.lenh_san_xuat_id WHERE d.phan_in_id = pin.id AND ls.trang_thai <> 'HUY')
      AND EXISTS (SELECT 1 FROM dot_vai_ve d WHERE d.phan_in_id = pin.id AND d.trang_thai <> 'DA_GOP'
                    AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai l JOIN lenh_san_xuat ls ON ls.id = l.lenh_san_xuat_id
                                    WHERE l.dot_vai_ve_id = d.id AND ls.trang_thai <> 'HUY'))
      AND ($1 = '' OR pin.ma_phan ~* $1 OR kh.ten_khach_hang ~* $1
           OR mh.ma_hang ~* $1 OR pin.mau_vai ~* $1)
    ORDER BY kh.ten_khach_hang, pin.ma_phan`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [mauTim(search)]);
  return rows;
}

// Mở lại READY: hủy mọi xác nhận READY (Khuôn/Film/Mực/QC) của phần in + gắn cờ đợt mới phải làm lại READY/Test Run.
async function reopenReadyResults(client, phanInId, actorId) {
  const { rowCount } = await client.query(
    `UPDATE ket_qua_checkpoint SET trang_thai='HUY', nguoi_xac_nhan_id=NULL, tg_xac_nhan=NULL, ghi_chu=NULL, updated_by=$2, updated_date=CURRENT_TIMESTAMP
     WHERE phan_in_id=$1 AND trang_thai='DAT' AND checkpoint_id IN (
       SELECT cp.id FROM checkpoint cp JOIN tram t ON t.id=cp.tram_id
       JOIN workflow_version wv ON wv.id=t.workflow_version_id AND wv.la_hien_hanh WHERE t.ma_tram='READY')`.replace(/\s+/g, ' '),
    [phanInId, actorId]
  );
  return rowCount;
}

async function flagUnreleasedDotLamLai(client, phanInId, actorId) {
  const { rowCount } = await client.query(
    `UPDATE dot_vai_ve dv SET can_lam_lai_ready=true, updated_by=$2, updated_date=CURRENT_TIMESTAMP
     WHERE dv.phan_in_id=$1 AND dv.trang_thai<>'DA_GOP'
       AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai l JOIN lenh_san_xuat ls ON ls.id=l.lenh_san_xuat_id
                       WHERE l.dot_vai_ve_id=dv.id AND ls.trang_thai<>'HUY')`.replace(/\s+/g, ' '),
    [phanInId, actorId]
  );
  return rowCount;
}

// Phần in có ĐANG SẢN XUẤT TRÊN CHUYỀN không (phiếu DANG_CHAY của lệnh ≠ HUY)?
async function isPhanInProducing(phanInId) {
  const { rows } = await query(
    `SELECT EXISTS (
       SELECT 1 FROM phieu_san_xuat ps
       JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id AND ls.trang_thai <> 'HUY'
       JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
       JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
       WHERE dv.phan_in_id = $1 AND ps.trang_thai = 'DANG_CHAY') AS producing`,
    [phanInId]
  );
  return rows[0]?.producing === true;
}

// Mở lại READY (dùng chung cho auto khi có đợt mới + tab thủ công): hủy xác nhận READY + gắn cờ đợt chưa release.
async function reopenReadyFull(phanInId, actorId, extraLog = {}) {
  const { withTransaction } = require('../../config/db');
  let huy = 0; let flagged = 0;
  await withTransaction(async (client) => {
    huy = await reopenReadyResults(client, phanInId, actorId);
    flagged = await flagUnreleasedDotLamLai(client, phanInId, actorId);
  });
  if (huy > 0 || flagged > 0) await logReopenReady(phanInId, { huy_xac_nhan: huy, dot_lam_lai: flagged, ...extraLog }, actorId);
  return { huy, flagged };
}

// Người + giờ xác nhận từng mục KT (KHUON/FILM/MUC) của các phần in — query NHẸ theo PK (IPS-safe),
// tách khỏi listCandidates (đã nặng) để gắn thêm cho bảng/Excel màn READY.
async function confirmInfoByPins(phanInIds = []) {
  if (!phanInIds.length) return [];
  const { rows } = await query(
    `SELECT k.phan_in_id, cp.ma_checkpoint, ${nguoiXacNhanSql('nd', 'k')} AS nguoi, k.ghi_chu,
            COALESCE(k.tg_xac_nhan, k.created_date) AS tg
     FROM ket_qua_checkpoint k
     JOIN checkpoint cp ON cp.id = k.checkpoint_id
     LEFT JOIN nguoi_dung nd ON nd.id = k.nguoi_xac_nhan_id
     WHERE k.phan_in_id = ANY($1::uuid[]) AND k.trang_thai = 'DAT'
       AND cp.ma_checkpoint IN ('KHUON','FILM','MUC')`.replace(/\s+/g, ' '),
    [phanInIds]
  );
  return rows;
}

async function logReopenReady(phanInId, payload, actorId) {
  await query(
    `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ('phan_in', $1, 'MO_LAI_READY', $2::jsonb, $3, CURRENT_TIMESTAMP, $3)`,
    [String(phanInId), JSON.stringify(payload || {}), actorId]
  );
}

// ─── XÁC NHẬN READY THEO ĐỢT VẢI (mig 098 — 15/09/2026) ─────────────────────
// Phần in chờ ≥2 LOẠI đợt vải ⇒ màn READY tách dòng theo loại, mỗi dòng xác nhận riêng. Luật hiệu lực
// + gộp về dòng TỔNG ở `technical.service` (khối "THEO LOẠI ĐỢT VẢI").

// Cache CHỈ khi ĐÃ có bảng (chạy migration xong là nhận ngay, khỏi restart) — khuôn `temCoCot` mig 066.
let _coBangDot = false;
async function coBangXacNhanDot() {
  if (_coBangDot) return true;
  try {
    const { rows } = await query(
      "SELECT 1 FROM information_schema.tables WHERE table_name = 'ready_xac_nhan_dot' LIMIT 1");
    _coBangDot = rows.length > 0;
  } catch (e) { _coBangDot = false; }
  return _coBangDot;
}

// Đợt vải ĐANG Ở READY của các phần in = chưa release (không nằm trong lệnh ≠ HUY) — gương nhánh OR
// thứ 1 của `listCandidates`.
async function dsDotChoReady(phanInIds = []) {
  if (!phanInIds.length) return [];
  const { rows } = await query(
    `SELECT dv.phan_in_id, dv.id AS dot_vai_ve_id, dv.ma_dot_vai, dv.loai_dot_vai_id, ldv.ten_loai,
            dv.han_giao_hang, dv.tg_chuyen_ready, dv.barcode, dv.so_luong_vai_ve, dv.ngay_vai_ve
       FROM dot_vai_ve dv
       LEFT JOIN loai_dot_vai ldv ON ldv.id = dv.loai_dot_vai_id
      WHERE dv.phan_in_id = ANY($1::uuid[]) AND dv.trang_thai NOT IN ('DA_GOP','DA_HUY')
        AND dv.tg_chuyen_ready IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai l JOIN lenh_san_xuat ls ON ls.id = l.lenh_san_xuat_id
                         WHERE l.dot_vai_ve_id = dv.id AND ls.trang_thai <> 'HUY')
        AND NOT ${qcDotSql('dv', 'dv.phan_in_id')}
      ORDER BY dv.tg_chuyen_ready`.replace(/\s+/g, ' '),
    [phanInIds]);
  return rows;
}

// Phần in CÒN đợt vải đang chờ ở READY mà CHƯA được QC phủ? (nguồn luật `utils/tech.js`).
// Dùng ở các guard KHÓA của service: dòng TỔNG đang DAT KHÔNG còn đồng nghĩa "READY đã xong hết".
async function conDotChuaReady(phanInId) {
  const { rows } = await query(`SELECT ${conDotChuaReadySql('$1::uuid')} AS e`.replace(/\s+/g, ' '), [phanInId]);
  return !!rows[0].e;
}

// Dòng TỔNG (`ket_qua_checkpoint`) của các phần in cho nhóm checkpoint — kèm `updated_date` (mốc hủy).
async function ketQuaTong(phanInIds, cpIds) {
  if (!phanInIds.length) return [];
  const { rows } = await query(
    `SELECT k.phan_in_id, k.checkpoint_id, k.trang_thai, k.updated_date, k.nguoi_xac_nhan_id,
            COALESCE(k.tg_xac_nhan, k.updated_date, k.created_date) AS tg, nd.ho_ten AS nguoi
       FROM ket_qua_checkpoint k LEFT JOIN nguoi_dung nd ON nd.id = k.nguoi_xac_nhan_id
      WHERE k.phan_in_id = ANY($1::uuid[]) AND k.checkpoint_id = ANY($2::uuid[])`.replace(/\s+/g, ' '),
    [phanInIds, cpIds]);
  return rows;
}

async function xacNhanDotRows(phanInIds, cpIds) {
  if (!phanInIds.length) return [];
  const { rows } = await query(
    `SELECT x.phan_in_id, x.dot_vai_ve_id, x.checkpoint_id, x.trang_thai, x.tg_xac_nhan, x.updated_date,
            x.nguoi_xac_nhan_id, nd.ho_ten AS nguoi
       FROM ready_xac_nhan_dot x LEFT JOIN nguoi_dung nd ON nd.id = x.nguoi_xac_nhan_id
      WHERE x.phan_in_id = ANY($1::uuid[]) AND x.checkpoint_id = ANY($2::uuid[])`.replace(/\s+/g, ' '),
    [phanInIds, cpIds]);
  return rows;
}

// Ghi DAT/HUY cho 1 (đợt vải × checkpoint). `updated_date = CURRENT_TIMESTAMP` = MỐC HIỆU LỰC.
async function ghiXacNhanDot(client, { phanInId, dotVaiId, checkpointId, trangThai, nguoiId, tg, actorId }) {
  await client.query(
    `INSERT INTO ready_xac_nhan_dot (phan_in_id, dot_vai_ve_id, checkpoint_id, trang_thai,
       nguoi_xac_nhan_id, tg_xac_nhan, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
     ON CONFLICT (dot_vai_ve_id, checkpoint_id) DO UPDATE SET
       trang_thai = EXCLUDED.trang_thai, nguoi_xac_nhan_id = EXCLUDED.nguoi_xac_nhan_id,
       tg_xac_nhan = EXCLUDED.tg_xac_nhan, updated_by = EXCLUDED.updated_by,
       updated_date = CURRENT_TIMESTAMP`.replace(/\s+/g, ' '),
    [phanInId, dotVaiId, checkpointId, trangThai, nguoiId || null, tg || null, actorId]);
}

// "Bồi" mốc hiệu lực cho các dòng DAT theo đợt KHÁC nhóm đang bỏ tích — gọi TRONG CÙNG transaction
// ngay trước khi hủy dòng TỔNG, để lần hủy tổng đó không vô hiệu luôn các dòng loại đợt vải còn lại
// (CURRENT_TIMESTAMP đứng yên trong 1 transaction ⇒ `updated_date` = mốc hủy, KHÔNG nhỏ hơn).
async function boiHieuLucDot(client, phanInId, checkpointId, boQuaDotIds = []) {
  await client.query(
    `UPDATE ready_xac_nhan_dot SET updated_date = CURRENT_TIMESTAMP
      WHERE phan_in_id = $1 AND checkpoint_id = $2 AND trang_thai = 'DAT'
        AND NOT (dot_vai_ve_id = ANY($3::uuid[]))`.replace(/\s+/g, ' '),
    [phanInId, checkpointId, boQuaDotIds]);
}

// Vết QC xác nhận THEO ĐỢT (21/09/2026) — dòng `ket_qua_checkpoint` không ghi nên lịch sử phải nằm ở audit.
async function logQcTheoDot(phanInId, dotVaiIds, actorId) {
  await query(
    `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ('phan_in', $1, 'QC_XAC_NHAN_THEO_DOT', $2::jsonb, $3, CURRENT_TIMESTAMP, $3)`,
    [String(phanInId), JSON.stringify({ dot_vai_ids: dotVaiIds }), actorId]);
}

module.exports = {
  logQcTheoDot,
  coBangXacNhanDot, dsDotChoReady, conDotChuaReady, ketQuaTong, xacNhanDotRows, ghiXacNhanDot, boiHieuLucDot,
  loadReadyConfig, listCandidates, countReadyItems, confirmInfoByPins, historyByDate, doneByDate, listConfirmHistory, isPhanInReleased, readyCancelState, traCuuMaQuet, getPhanInBasic, getResults, getBulkStates,
  getReadyEntryTime, findResultId, upsertResult, cancelResult, logCancel, insertStatusLog,
  listReopenCandidates, reopenReadyResults, flagUnreleasedDotLamLai, logReopenReady,
  isPhanInProducing, reopenReadyFull, lenhChoKyThuatByPhanIn,
};
