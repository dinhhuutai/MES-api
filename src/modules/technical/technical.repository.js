'use strict';

const { query } = require('../../config/db');
// Hiển thị theo PHƯƠNG ÁN IN — cấu hình động (mig 067), mặc định BẬT HẾT = không lọc.
const { dkTrang } = require('../../utils/phuongAnIn');
const { techDoneSql, KHUON_OPT_SQL_LIST } = require('../../utils/tech');

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
  const SEARCH = `($1 = '' OR pin.ma_phan ILIKE '%'||$1||'%' OR kh.ten_khach_hang ILIKE '%'||$1||'%'
                  OR dh.ma_don_hang ILIKE '%'||$1||'%' OR mh.ma_hang ILIKE '%'||$1||'%'
                  OR pin.mau_vai ILIKE '%'||$1||'%' OR pin.kich_vai ILIKE '%'||$1||'%'
                  OR pin.kich_phim ILIKE '%'||$1||'%')`;
  const doneExpr = (param) =>
    `EXISTS (SELECT 1 FROM ket_qua_checkpoint k WHERE k.phan_in_id = pin.id AND k.checkpoint_id = ${param} AND k.trang_thai = 'DAT')`;
  // withItems=true: kèm cờ tình trạng từng mục (cho bảng); dùng $6..$9.
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
              WHERE dv3.phan_in_id = pin.id) AS loai_dot_vai,
           (SELECT min(dv4.han_giao_hang) FROM dot_vai_ve dv4
              WHERE dv4.phan_in_id = pin.id AND dv4.trang_thai NOT IN ('DA_GOP','DA_HUY')) AS han_giao_hang,
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
           ${doneExpr('$3')} AS qc_done${withItems ? `,
           ${doneExpr('$6')} AS khuon_done,
           ${doneExpr('$7')} AS film_done,
           ${doneExpr('$8')} AS muc_done,
           ${techDoneSql('kh.ten_khach_hang', doneExpr('$6'), doneExpr('$7'), doneExpr('$8'))} AS tech_done` : ''},
           hs.phuong_an_in, hs.barcode_hskt, hs.hskt_id, hs.hskt_inset,
           sla.ready_tg_vao, sla.kt_done_tg
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
                WHERE k.phan_in_id = pin.id AND k.checkpoint_id = ANY($2::uuid[]) AND k.trang_thai = 'DAT') AS kt_done_tg
    ) sla ON true
    -- Ở READY khi phần in CÒN đợt vải CHƯA release (đợt không nằm trong lệnh ≠ HUY), HOẶC chưa có đợt vải nào.
    -- ⇒ phần in đã release hết đợt thì rời READY; nhưng nếu "Mở lại READY" (hủy QC) mà còn đợt mới chưa release
    -- thì quay lại danh sách READY để làm lại kỹ thuật/QC (kể cả khi phần in đã có đợt sản xuất trước).
    -- Nhánh 3: TEST RUN KHÔNG ĐẠT trả về Kỹ thuật — lệnh được GIỮ NGUYÊN (để QC xong nhảy lại Test Run)
    -- nên đợt vải VẪN thuộc lệnh; không có nhánh này thì phần in sẽ KHÔNG hiện ở READY để làm lại.
    -- Nhận diện: đợt thuộc lệnh RELEASE_1 CHƯA có phiếu SX (kết hợp OUTER_WHERE q.qc_done = false).
    WHERE (EXISTS (SELECT 1 FROM dot_vai_ve dvu WHERE dvu.phan_in_id = pin.id AND dvu.trang_thai <> 'DA_GOP' AND dvu.tg_chuyen_ready IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai lsu JOIN lenh_san_xuat lu ON lu.id = lsu.lenh_san_xuat_id
                                     WHERE lsu.dot_vai_ve_id = dvu.id AND lu.trang_thai <> 'HUY'))
             OR NOT EXISTS (SELECT 1 FROM dot_vai_ve dvz WHERE dvz.phan_in_id = pin.id AND dvz.trang_thai <> 'DA_GOP')
             OR EXISTS (SELECT 1 FROM dot_vai_ve dvt JOIN lenh_sx_dot_vai lst ON lst.dot_vai_ve_id = dvt.id
                          JOIN lenh_san_xuat lt ON lt.id = lst.lenh_san_xuat_id AND lt.trang_thai = 'RELEASE_1'
                         WHERE dvt.phan_in_id = pin.id AND dvt.trang_thai <> 'DA_GOP' AND dvt.tg_chuyen_ready IS NOT NULL
                           AND NOT EXISTS (SELECT 1 FROM phieu_san_xuat pst WHERE pst.lenh_san_xuat_id = lt.id)))
      AND pin.dang_hoat_dong
      AND ${dkPain}
      AND ${SEARCH}`;

  // CẢ 2 màn (Kỹ thuật & QC) hiển thị CÙNG danh sách READY chưa QC xong — khác nhau ở SLA nghẽn:
  //  - Màn Kỹ thuật: SLA trạm READY (KT chưa đủ → đếm; đủ 3 mục → NULL, ngừng đỏ).
  //  - Màn QC (onlyQcReady): SLA QC_XAC_NHAN, chỉ đếm khi ĐỦ 3 mục KT (kt_done_tg); KT chưa đủ → NULL (không đỏ ở QC).
  // QC chỉ XÁC NHẬN được phần in đủ 3 mục (guard ở service + FE), nhưng vẫn THẤY toàn bộ danh sách READY.
  const tt = Number.isInteger(techTotal) ? techTotal : 3; // số nguyên do code kiểm soát (an toàn khi nội suy)
  const OUTER_WHERE = 'WHERE q.qc_done = false';

  // SLA theo GIAI ĐOẠN (task 3): $11=onlyQcReady. Màn QC → SLA QC_XAC_NHAN ($12) đếm từ kt_done_tg;
  // màn Kỹ thuật → SLA trạm READY ($9) từ ready_tg_vao, và KHI ĐỦ 3 mục KT → sla NULL (ngừng đếm, không đỏ ở KT).
  // Gộp data + total vào 1 query bằng COUNT(*) OVER() (1 round-trip thay vì 2).
  const dataSql = `
    SELECT q.*,
           CASE WHEN $11 THEN (CASE WHEN q.tech_done THEN q.kt_done_tg ELSE NULL END) ELSE q.ready_tg_vao END AS tg_vao,
           CASE WHEN $11 THEN (CASE WHEN q.tech_done THEN $12::int ELSE NULL END) WHEN q.tech_done THEN NULL ELSE $9::int END AS sla_phut,
           CASE WHEN $11 THEN $13::int ELSE $10::int END AS canh_bao_truoc_phut,
           count(*) OVER()::int AS total_count
    FROM (${selectBase(true)}) q
    ${OUTER_WHERE}
    ORDER BY q.n_tech_done DESC, q.ma_phan
    LIMIT $4 OFFSET $5`;

  const { rows } = await query(dataSql, [search, inputIds, qcId, limit, offset, khuonId, filmId, mucId, readySla, readyCanhBao, onlyQcReady, qcSla, qcCanhBao]);
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
           count(*) FILTER (WHERE NOT film_done)::int AS film,
           count(*) FILTER (WHERE NOT muc_done)::int AS muc
    FROM (
      SELECT ${doneExpr('$1')} AS khuon_done, ${doneExpr('$2')} AS film_done, ${doneExpr('$3')} AS muc_done,
             kh.ten_khach_hang AS khach
      FROM phan_in pin
      JOIN ma_hang mh ON mh.id = pin.ma_hang_id
      JOIN don_hang dh ON dh.id = mh.don_hang_id
      JOIN khach_hang kh ON kh.id = dh.khach_hang_id
      WHERE (EXISTS (SELECT 1 FROM dot_vai_ve dvu WHERE dvu.phan_in_id = pin.id AND dvu.trang_thai <> 'DA_GOP' AND dvu.tg_chuyen_ready IS NOT NULL
                       AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai lsu JOIN lenh_san_xuat lu ON lu.id = lsu.lenh_san_xuat_id
                                       WHERE lsu.dot_vai_ve_id = dvu.id AND lu.trang_thai <> 'HUY'))
             OR NOT EXISTS (SELECT 1 FROM dot_vai_ve dvz WHERE dvz.phan_in_id = pin.id AND dvz.trang_thai <> 'DA_GOP'))
        AND pin.dang_hoat_dong
        AND NOT (${doneExpr('$4')})
    ) q`;
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
async function listConfirmHistory({ date, search = '' }) {
  const sql = `
    SELECT kq.id AS ket_qua_id, kq.phan_in_id, cp.ma_checkpoint, cp.ten_checkpoint,
           kq.gia_tri_text, kq.tg_xac_nhan, nx.ho_ten AS nguoi_xac_nhan,
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
      AND ($2 = '' OR pin.ma_phan ILIKE '%'||$2||'%' OR mh.ma_hang ILIKE '%'||$2||'%'
           OR kh.ten_khach_hang ILIKE '%'||$2||'%' OR dh.ma_don_hang ILIKE '%'||$2||'%'
           OR pin.mau_vai ILIKE '%'||$2||'%' OR pin.kich_vai ILIKE '%'||$2||'%' OR pin.kich_phim ILIKE '%'||$2||'%')
    ORDER BY kq.tg_xac_nhan DESC NULLS LAST`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [date, search]);
  return rows;
}

// Danh sách phần in ĐÃ HOÀN THÀNH checkpoint READY theo ngày (giờ VN) — cho DonePanel.
//  scope='tech': phần in đủ 3 mục kỹ thuật (mốc hoàn thành = lần xác nhận mục cuối cùng trong ngày).
//  scope='qc':   phần in đã QC_XAC_NHAN = DAT trong ngày.
async function doneByDate(date, scope = 'tech') {
  const info = `pin.ma_phan AS ma, pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.so_luong_don_hang AS so_luong,
                pin.tinh_chat_in, mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang,
                (SELECT min(dv.han_giao_hang) FROM dot_vai_ve dv WHERE dv.phan_in_id = pin.id AND dv.trang_thai NOT IN ('DA_GOP','DA_HUY')) AS han_giao_hang`;
  const joins = `JOIN ma_hang mh ON mh.id = pin.ma_hang_id
                 JOIN don_hang dh ON dh.id = mh.don_hang_id
                 JOIN khach_hang kh ON kh.id = dh.khach_hang_id`;
  let sql;
  if (scope === 'qc') {
    sql = `
      SELECT kq.tg_xac_nhan AS tg, nx.ho_ten AS nguoi, ${info}
      FROM ket_qua_checkpoint kq
      JOIN checkpoint cp ON cp.id = kq.checkpoint_id
      JOIN tram t ON t.id = cp.tram_id
      JOIN phan_in pin ON pin.id = kq.phan_in_id
      ${joins}
      LEFT JOIN nguoi_dung nx ON nx.id = kq.nguoi_xac_nhan_id
      WHERE t.ma_tram = 'READY' AND cp.ma_checkpoint = 'QC_XAC_NHAN' AND kq.trang_thai = 'DAT'
        AND (kq.tg_xac_nhan AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $1::date
      ORDER BY kq.tg_xac_nhan DESC`;
  } else {
    sql = `
      WITH tech AS (
        SELECT kq.phan_in_id, cp.ma_checkpoint, kq.tg_xac_nhan, kq.nguoi_xac_nhan_id
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
      SELECT a.tg_done AS tg, nx.ho_ten AS nguoi, ${info}
      FROM agg a
      JOIN phan_in pin ON pin.id = a.phan_in_id
      ${joins}
      LEFT JOIN LATERAL (SELECT nguoi_xac_nhan_id FROM tech WHERE phan_in_id = a.phan_in_id
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
// Trả 1 dòng hoặc rỗng; service dựng câu mô tả.
async function traCuuMaQuet(code) {
  const sql = `
    SELECT pin.ma_phan, pin.dang_hoat_dong,
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
    WHERE pin.ma_phan = $1 OR pin.barcode = $1
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
async function getResults(tramId, phanInId) {
  const { rows } = await query(
    `SELECT cp.id AS checkpoint_id, cp.ma_checkpoint, cp.ten_checkpoint, cp.bat_buoc, cp.thu_tu,
            cp.cau_hinh_json, cp.thoi_gian_quy_dinh_phut, cp.canh_bao_truoc_phut, lc.ma_loai AS loai_checkpoint,
            kq.id AS ket_qua_id, kq.trang_thai, kq.gia_tri_text, kq.gia_tri_json,
            kq.nguoi_xac_nhan_id, kq.tg_xac_nhan, nx.ho_ten AS nguoi_xac_nhan_ten,
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
      `UPDATE ket_qua_checkpoint SET
         trang_thai = $2,
         gia_tri_text = COALESCE($3, gia_tri_text),
         nguoi_xac_nhan_id = COALESCE($4, nguoi_xac_nhan_id),
         tg_xac_nhan = COALESCE($5, tg_xac_nhan),
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
    `UPDATE ket_qua_checkpoint SET trang_thai = 'HUY', nguoi_xac_nhan_id = NULL, tg_xac_nhan = NULL,
       updated_by = $3, updated_date = CURRENT_TIMESTAMP
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
      AND ($1 = '' OR pin.ma_phan ILIKE '%'||$1||'%' OR kh.ten_khach_hang ILIKE '%'||$1||'%'
           OR mh.ma_hang ILIKE '%'||$1||'%' OR pin.mau_vai ILIKE '%'||$1||'%')
    ORDER BY kh.ten_khach_hang, pin.ma_phan`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [search]);
  return rows;
}

// Mở lại READY: hủy mọi xác nhận READY (Khuôn/Film/Mực/QC) của phần in + gắn cờ đợt mới phải làm lại READY/Test Run.
async function reopenReadyResults(client, phanInId, actorId) {
  const { rowCount } = await client.query(
    `UPDATE ket_qua_checkpoint SET trang_thai='HUY', nguoi_xac_nhan_id=NULL, tg_xac_nhan=NULL, updated_by=$2, updated_date=CURRENT_TIMESTAMP
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
    `SELECT k.phan_in_id, cp.ma_checkpoint, nd.ho_ten AS nguoi,
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

module.exports = {
  loadReadyConfig, listCandidates, countReadyItems, confirmInfoByPins, historyByDate, doneByDate, listConfirmHistory, isPhanInReleased, readyCancelState, traCuuMaQuet, getPhanInBasic, getResults, getBulkStates,
  getReadyEntryTime, findResultId, upsertResult, cancelResult, logCancel, insertStatusLog,
  listReopenCandidates, reopenReadyResults, flagUnreleasedDotLamLai, logReopenReady,
  isPhanInProducing, reopenReadyFull, lenhChoKyThuatByPhanIn,
};
