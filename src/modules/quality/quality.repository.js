'use strict';

const { query } = require('../../config/db');
const { lenhPhanInMatch } = require('../../utils/search');

// SỔ CÁI SỐ LƯỢNG tem (migration 043): SL còn lại từng công đoạn (dùng cho lọc + hiển thị).
// con_kcs tính theo TỔNG CẦN KIỂM = so_luong + sl_chenh_lech (dư/thiếu — mig 044).
const CON_KCS = '((t.so_luong + t.sl_chenh_lech) - (t.sl_kcs_dat + t.sl_kcs_sua + t.sl_kcs_huy))';
const CON_SUA = '(t.sl_kcs_sua - (t.sl_sua_dat + t.sl_sua_huy))';
const CON_OQC = '((t.sl_kcs_dat + t.sl_sua_dat) - t.sl_oqc_dat)';
const CON_GIAO = '(t.sl_oqc_dat - t.sl_da_giao)';
// Tách theo NGUỒN ở OQC (mig 047): phần chờ OQC từ KCS-đạt (tem 15-) vs Sửa-đạt (tem 17-).
const CON_OQC_KCS = '(t.sl_kcs_dat - (t.sl_oqc_dat - t.sl_oqc_dat_sua))';
const CON_OQC_SUA = '(t.sl_sua_dat - t.sl_oqc_dat_sua)';

// Đánh dấu bản ghi KCS/Sửa/OQC đã bị HỦY XÁC NHẬN trong audit_log (không xóa cứng).
// `table` là literal nội bộ ('kcs'|'sua'|'oqc'), không nhận từ user → nội suy an toàn.
const cancelledQc = (alias, table) =>
  `EXISTS (SELECT 1 FROM audit_log a WHERE a.ten_bang='${table}' AND a.hanh_dong='HUY_XAC_NHAN' AND a.id_ban_ghi = ${alias}.id::text)`;
const notCancelledQc = (alias, table) => `NOT ${cancelledQc(alias, table)}`;

const TEM_CTX = `
  SELECT t.id AS tem_id, t.ma_tem, t.so_luong, t.trang_thai, t.da_qua_phoi, t.sl_chenh_lech, t.created_date AS ngay_in_tem,
         t.sl_kcs_dat, t.sl_kcs_sua, t.sl_kcs_huy, t.sl_sua_dat, t.sl_sua_huy, t.sl_oqc_dat, t.sl_da_giao,
         ${CON_KCS} AS con_kcs, ${CON_SUA} AS con_sua, ${CON_OQC} AS con_oqc, ${CON_GIAO} AS con_giao,
         ${CON_OQC_KCS} AS con_oqc_kcs, ${CON_OQC_SUA} AS con_oqc_sua,
         ls.ma_lenh_san_xuat, cs.ma_chuyen, cs.ten_chuyen,
         info.ten_khach_hang, info.ma_don_hang, info.ma_hang, info.mau_vai, info.kich_vai, info.kich_phim,
         sla.tg_vao,
         CASE WHEN lc_gc.ma_loai = 'GIA_CONG' THEN 0 ELSE sla.sla_phut END AS sla_phut,
         sla.canh_bao_truoc_phut,
         (SELECT string_agg(DISTINCT pin.ma_phan, ', ')
            FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
            JOIN phan_in pin ON pin.id = dv.phan_in_id WHERE lsd.lenh_san_xuat_id = ls.id) AS phan_list
  FROM tem t
  JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
  JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
  LEFT JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
  LEFT JOIN loai_chuyen lc_gc ON lc_gc.id = cs.loai_chuyen_id
  LEFT JOIN LATERAL (
    SELECT kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang, pin.mau_vai, pin.kich_vai, pin.kich_phim
    FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
    JOIN phan_in pin ON pin.id = dv.phan_in_id
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    WHERE lsd.lenh_san_xuat_id = ls.id ORDER BY pin.ma_phan, dv.ma_dot_vai LIMIT 1
  ) info ON true
  LEFT JOIN LATERAL (
    SELECT tt.tg_vao, tr.thoi_gian_quy_dinh_phut AS sla_phut, tr.canh_bao_truoc_phut
    FROM lenh_sx_dot_vai lsd JOIN ton_tram tt ON tt.dot_vai_ve_id = lsd.dot_vai_ve_id
    JOIN tram tr ON tr.id = tt.tram_id
    WHERE lsd.lenh_san_xuat_id = ls.id ORDER BY tt.tg_vao LIMIT 1
  ) sla ON true`;

// Danh sách tem cho 1 công đoạn — lọc theo SL CÒN LẠI (con_X > 0), cho phép 1 tem xuất hiện đồng thời
// ở nhiều công đoạn nếu còn phần chưa xử lý (kiểm/giao nhiều lần).
async function listCandByCon(condExpr, { search = '', filters = {} } = {}) {
  const f = filters || {};
  const params = [];
  const conds = [condExpr];
  // Ô tìm kiếm chung (chỉ thêm ILIKE vào SQL khi CÓ nhập — giữ query gọn cho IPS khi không lọc).
  if (search) {
    params.push(search);
    const i = params.length;
    conds.push(`(t.ma_tem ILIKE '%'||$${i}||'%' OR ls.ma_lenh_san_xuat ILIKE '%'||$${i}||'%' OR ${lenhPhanInMatch('ls.id', `$${i}`)})`);
  }
  // Lọc từng trường — chỉ nối điều kiện cho trường thực sự được nhập.
  const addFilter = (val, col) => {
    if (!val) return;
    params.push(val);
    conds.push(`${col} ILIKE '%'||$${params.length}||'%'`);
  };
  addFilter(f.khach, 'info.ten_khach_hang');
  addFilter(f.don, 'info.ma_don_hang');
  addFilter(f.maHang, 'info.ma_hang');
  addFilter(f.mauVai, 'info.mau_vai');
  addFilter(f.kichVai, 'info.kich_vai');
  addFilter(f.kichPhim, 'info.kich_phim');
  // Lọc theo NGÀY IN TEM (created_date, giờ VN) — hỗ trợ 1 ngày (ngay) hoặc KHOẢNG (ngayTu/ngayDen).
  if (f.ngay) {
    params.push(f.ngay);
    conds.push(`(t.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $${params.length}::date`);
  }
  if (f.ngayTu) {
    params.push(f.ngayTu);
    conds.push(`(t.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= $${params.length}::date`);
  }
  if (f.ngayDen) {
    params.push(f.ngayDen);
    conds.push(`(t.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date <= $${params.length}::date`);
  }
  // Gửi SQL 1 dòng (IPS-safe). TEM_CTX không có comment '--' nên gộp an toàn.
  const sql = `${TEM_CTX} WHERE ${conds.join(' AND ')} ORDER BY t.created_date`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), params);
  return rows;
}
// KCS: tem đã khô, còn phần chưa kiểm. Sửa: còn phần chờ sửa. OQC: còn phần chờ kiểm cuối.
// (con_sua/con_oqc > 0 ⟹ đã qua KCS ⟹ đã khô — không cần lọc thêm da_qua_phoi.)
const listKcsCand = (opt) => listCandByCon(`t.trang_thai = 'DA_KHO' AND ${CON_KCS} > 0`, opt);
// Sửa: hủy tem sửa = xóa SL sửa khỏi sổ cái ⇒ con_sua về 0 ⇒ tem tự rời hàng đợi (không cần cờ ẩn).
const listSuaCand = (opt) => listCandByCon(`${CON_SUA} > 0`, opt);
const listOqcCand = (opt) => listCandByCon(`${CON_OQC} > 0`, opt);

async function getTemBasic(temId) {
  const { rows } = await query('SELECT id, ma_tem, so_luong, trang_thai FROM tem WHERE id = $1', [temId]);
  return rows[0] || null;
}

// Giờ/tuần VN (để suy ca) cho danh sách tem — query nhẹ theo PK, tách khỏi TEM_CTX (IPS-safe).
async function caPartsForTems(temIds) {
  if (!temIds || temIds.length === 0) return [];
  const { rows } = await query(
    `SELECT id AS tem_id,
            EXTRACT(HOUR    FROM created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::int AS ca_gio,
            EXTRACT(MINUTE  FROM created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::int AS ca_phut,
            EXTRACT(ISOYEAR FROM created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::int AS ca_nam,
            EXTRACT(WEEK    FROM created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::int AS ca_tuan
     FROM tem WHERE id = ANY($1::uuid[])`.replace(/\s+/g, ' '),
    [temIds]
  );
  return rows;
}

// Người XÁC NHẬN TRẠM TRƯỚC của từng tem (query nhẹ theo PK — IPS-safe, tách khỏi list nặng).
// nguoi_in (in tem) · nguoi_kcs (KCS) · nguoi_sua (Sửa) · nguoi_oqc (OQC) · nguoi_kcs_sua (KCS/Sửa mới nhất).
async function prevConfirmerByTems(temIds) {
  if (!temIds || temIds.length === 0) return [];
  const sql = `
    SELECT t.id AS tem_id,
      (SELECT nd.ho_ten FROM log_tem lt JOIN nguoi_dung nd ON nd.id = lt.nguoi_in_id
         WHERE lt.tem_id = t.id ORDER BY lt.tg_in LIMIT 1) AS nguoi_in,
      (SELECT nd.ho_ten FROM kcs x JOIN nguoi_dung nd ON nd.id = x.created_by
         WHERE x.tem_id = t.id ORDER BY x.created_date DESC LIMIT 1) AS nguoi_kcs,
      (SELECT nd.ho_ten FROM sua x JOIN nguoi_dung nd ON nd.id = x.created_by
         WHERE x.tem_id = t.id ORDER BY x.created_date DESC LIMIT 1) AS nguoi_sua,
      (SELECT nd.ho_ten FROM oqc x JOIN nguoi_dung nd ON nd.id = x.created_by
         WHERE x.tem_id = t.id ORDER BY x.created_date DESC LIMIT 1) AS nguoi_oqc,
      (SELECT nd.ho_ten FROM (
         SELECT created_by AS uid, created_date AS tg FROM kcs WHERE tem_id = t.id
         UNION ALL SELECT created_by, created_date FROM sua WHERE tem_id = t.id
       ) e JOIN nguoi_dung nd ON nd.id = e.uid ORDER BY e.tg DESC LIMIT 1) AS nguoi_kcs_sua,
      (SELECT nd.ho_ten FROM phieu_san_xuat ps JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
         JOIN nguoi_dung nd ON nd.id = ls.created_by WHERE ps.id = t.phieu_san_xuat_id) AS nguoi_release1,
      EXISTS (SELECT 1 FROM phieu_san_xuat ps JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
         JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id JOIN loai_chuyen lc ON lc.id = cs.loai_chuyen_id
         WHERE ps.id = t.phieu_san_xuat_id AND lc.ma_loai = 'GIA_CONG') AS la_gia_cong
    FROM tem t WHERE t.id = ANY($1::uuid[])`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [temIds]);
  return rows;
}

// ----- SỔ CÁI SỐ LƯỢNG (migration 043) -----
// Đọc ledger + SL còn lại từng công đoạn (để service validate số nhập ≤ còn lại).
async function getTemLedger(temId) {
  const { rows } = await query(
    `SELECT id, ma_tem, so_luong, trang_thai, da_qua_phoi, phieu_san_xuat_id, sl_chenh_lech,
            sl_kcs_dat, sl_kcs_sua, sl_kcs_huy, sl_sua_dat, sl_sua_huy, sl_oqc_dat, sl_da_giao,
            sl_oqc_dat_sua,
            ((so_luong + sl_chenh_lech) - (sl_kcs_dat+sl_kcs_sua+sl_kcs_huy)) AS con_kcs,
            (sl_kcs_sua - (sl_sua_dat+sl_sua_huy)) AS con_sua,
            ((sl_kcs_dat+sl_sua_dat) - sl_oqc_dat) AS con_oqc,
            (sl_kcs_dat - (sl_oqc_dat - sl_oqc_dat_sua)) AS con_oqc_kcs,
            (sl_sua_dat - sl_oqc_dat_sua) AS con_oqc_sua,
            (sl_oqc_dat - sl_da_giao) AS con_giao
     FROM tem WHERE id = $1`,
    [temId]
  );
  return rows[0] || null;
}

// Cộng dồn ledger KCS (client trong transaction). `chenh` = dư−thiếu đợt này (cộng vào tổng cần kiểm).
async function addKcsLedger(client, temId, { dat = 0, sua = 0, huy = 0, chenh = 0 }, actorId) {
  await client.query(
    `UPDATE tem SET sl_kcs_dat = sl_kcs_dat+$2, sl_kcs_sua = sl_kcs_sua+$3, sl_kcs_huy = sl_kcs_huy+$4,
       sl_chenh_lech = sl_chenh_lech+$5, updated_by=$6, updated_date=CURRENT_TIMESTAMP WHERE id=$1`,
    [temId, dat, sua, huy, chenh, actorId]
  );
}
async function addSuaLedger(client, temId, { dat = 0, huy = 0 }, actorId) {
  await client.query(
    `UPDATE tem SET sl_sua_dat = sl_sua_dat+$2, sl_sua_huy = sl_sua_huy+$3,
       updated_by=$4, updated_date=CURRENT_TIMESTAMP WHERE id=$1`,
    [temId, dat, huy, actorId]
  );
}
// Cộng dồn OQC-đạt (→ chờ giao). `nguonSua` true ⇒ phần nguồn SỬA (cộng cả sub-counter sl_oqc_dat_sua).
async function addOqcLedger(client, temId, dat, actorId, nguonSua = false) {
  await client.query(
    `UPDATE tem SET sl_oqc_dat = sl_oqc_dat+$2, sl_oqc_dat_sua = sl_oqc_dat_sua + $3,
       updated_by=$4, updated_date=CURRENT_TIMESTAMP WHERE id=$1`,
    [temId, dat, nguonSua ? dat : 0, actorId]
  );
}
async function addGiaoLedger(client, temId, qty, actorId) {
  await client.query(
    `UPDATE tem SET sl_da_giao = sl_da_giao+$2, updated_by=$3, updated_date=CURRENT_TIMESTAMP WHERE id=$1`,
    [temId, qty, actorId]
  );
}
// OQC trả về KCS: đưa phần chờ OQC (đạt KCS — tem 15-) quay lại "chưa kiểm" (giảm sl_kcs_dat → tăng con_kcs).
async function reduceKcsDat(client, temId, qty, actorId) {
  await client.query(
    `UPDATE tem SET sl_kcs_dat = GREATEST(sl_kcs_dat-$2,0), updated_by=$3, updated_date=CURRENT_TIMESTAMP WHERE id=$1`,
    [temId, qty, actorId]
  );
}
// OQC trả về SỬA: đưa phần chờ OQC (đã sửa — tem 17-) quay lại "chờ sửa" (giảm sl_sua_dat → tăng con_sua).
async function reduceSuaDat(client, temId, qty, actorId) {
  await client.query(
    `UPDATE tem SET sl_sua_dat = GREATEST(sl_sua_dat-$2,0), updated_by=$3, updated_date=CURRENT_TIMESTAMP WHERE id=$1`,
    [temId, qty, actorId]
  );
}

// Cập nhật trang_thai = công đoạn KÉM tiến độ nhất còn hàng (dominant) — cho dashboard/đơn hàng.
// Không đụng tem đang phơi (IN/DANG_PHOI) hay đã hủy (HUY).
const recomputeTemStage = (client, temId, actorId) => recomputeTemStageMany(client, [temId], actorId);

// Bản nhiều tem — 1 câu lệnh cho cả lô.
async function recomputeTemStageMany(client, temIds, actorId) {
  if (!temIds || temIds.length === 0) return;
  await client.query(
    `UPDATE tem SET trang_thai = CASE
        WHEN trang_thai IN ('IN','DANG_PHOI','HUY') THEN trang_thai
        WHEN ((so_luong+sl_chenh_lech)-(sl_kcs_dat+sl_kcs_sua+sl_kcs_huy)) > 0 THEN 'DA_KHO'
        WHEN (sl_kcs_sua-(sl_sua_dat+sl_sua_huy)) > 0 THEN 'CHO_SUA'
        WHEN ((sl_kcs_dat+sl_sua_dat)-sl_oqc_dat) > 0 THEN 'CHO_OQC'
        WHEN (sl_oqc_dat-sl_da_giao) > 0 THEN 'OQC_DAT'
        WHEN sl_da_giao > 0 THEN 'DA_GIAO'
        ELSE 'LOAI' END,
       updated_by=$2, updated_date=CURRENT_TIMESTAMP
     WHERE id = ANY($1::uuid[])`,
    [temIds, actorId]
  );
}

// ----- QC IN-LINE (kiểm tại chuyền — phiếu đang chạy) -----
const PHAN_INFO_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang,
           pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.ma_phan, pin.tinh_chat_in, dv.han_giao_hang
    FROM lenh_sx_dot_vai lsd
    JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
    JOIN phan_in pin ON pin.id = dv.phan_in_id
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    WHERE lsd.lenh_san_xuat_id = ls.id
    ORDER BY pin.ma_phan, dv.ma_dot_vai
    LIMIT 1
  ) info ON true`;

async function listInlineCandidates({ search = '' }) {
  const { rows } = await query(
    `SELECT ps.id AS phieu_id, ps.ma_phieu_san_xuat, ls.id AS lenh_id, ls.ma_lenh_san_xuat,
            ls.so_luong_release AS target, cs.ma_chuyen, cs.ten_chuyen,
            info.ten_khach_hang, info.ma_don_hang, info.ma_hang, info.ma_phan,
            info.mau_vai, info.kich_vai, info.kich_phim,
            (SELECT COALESCE(SUM(t.so_luong),0)::int FROM tem t WHERE t.phieu_san_xuat_id = ps.id) AS printed,
            (SELECT count(*) FROM qc_in_line q WHERE q.phieu_san_xuat_id = ps.id)::int AS so_lan_kiem
     FROM phieu_san_xuat ps
     JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
     LEFT JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
     ${PHAN_INFO_LATERAL}
     WHERE ps.trang_thai = 'DANG_CHAY'
       AND ($1 = '' OR ps.ma_phieu_san_xuat ILIKE '%'||$1||'%' OR ls.ma_lenh_san_xuat ILIKE '%'||$1||'%'
              OR ${lenhPhanInMatch('ls.id', '$1')})
     ORDER BY cs.ma_chuyen, ps.created_date`,
    [search]
  );
  return rows;
}

async function getPhieuRun(phieuId) {
  const { rows } = await query(
    'SELECT id, lenh_san_xuat_id, trang_thai, ma_phieu_san_xuat FROM phieu_san_xuat WHERE id = $1',
    [phieuId]
  );
  return rows[0] || null;
}

async function nextInlineRound(phieuId) {
  const { rows } = await query(
    'SELECT COALESCE(MAX(lan_kiem),0)+1 AS lan FROM qc_in_line WHERE phieu_san_xuat_id = $1',
    [phieuId]
  );
  return rows[0].lan;
}

async function insertQcInline(client, { phieuId, lenhId, lanKiem, soLuongMau, soLuongLoi, ketQua, nguyenNhan, khacPhuc, ghiChu }, actorId) {
  const { rows } = await client.query(
    `INSERT INTO qc_in_line (phieu_san_xuat_id, lenh_san_xuat_id, lan_kiem, so_luong_mau, so_luong_loi,
                             ket_qua, nguyen_nhan, khac_phuc, ghi_chu, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [phieuId, lenhId, lanKiem, soLuongMau, soLuongLoi, ketQua, nguyenNhan || null, khacPhuc || null, ghiChu || null, actorId]
  );
  return rows[0].id;
}

async function insertQcInlineLoi(client, qcId, { loaiLoiId, soLuong, ghiChu }, actorId) {
  await client.query(
    `INSERT INTO qc_in_line_loi (qc_in_line_id, loai_loi_id, so_luong, ghi_chu, created_by)
     VALUES ($1,$2,$3,$4,$5)`,
    [qcId, loaiLoiId, soLuong ?? null, ghiChu || null, actorId]
  );
}

async function inlineHistoryByDate(date) {
  const { rows } = await query(
    `SELECT q.created_date AS tg, nd.ho_ten AS nguoi, q.ket_qua, q.lan_kiem,
            q.so_luong_mau, q.so_luong_loi, q.nguyen_nhan, q.khac_phuc,
            ps.ma_phieu_san_xuat, ls.ma_lenh_san_xuat, info.ma_phan,
            (SELECT string_agg(ll.ten_loi, ', ')
               FROM qc_in_line_loi qll JOIN loai_loi ll ON ll.id = qll.loai_loi_id
               WHERE qll.qc_in_line_id = q.id) AS loi_list
     FROM qc_in_line q
     JOIN phieu_san_xuat ps ON ps.id = q.phieu_san_xuat_id
     JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
     LEFT JOIN nguoi_dung nd ON nd.id = q.created_by
     ${PHAN_INFO_LATERAL}
     WHERE (q.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $1::date
     ORDER BY q.created_date DESC`,
    [date]
  );
  return rows;
}

// ----- DANH MỤC LỖI (loai_loi) -----
async function listLoaiLoiActive() {
  const { rows } = await query(
    'SELECT id, ma_loi, ten_loi, nhom_loi FROM loai_loi WHERE dang_hoat_dong = true ORDER BY nhom_loi, ten_loi'
  );
  return rows;
}

async function listLoaiLoiAll(search = '') {
  const { rows } = await query(
    `SELECT id, ma_loi, ten_loi, nhom_loi, dang_hoat_dong
     FROM loai_loi
     WHERE ($1 = '' OR ma_loi ILIKE '%'||$1||'%' OR ten_loi ILIKE '%'||$1||'%' OR nhom_loi ILIKE '%'||$1||'%')
     ORDER BY dang_hoat_dong DESC, nhom_loi, ten_loi`,
    [search]
  );
  return rows;
}

async function insertLoaiLoi({ maLoi, tenLoi, nhomLoi }, actorId) {
  const { rows } = await query(
    `INSERT INTO loai_loi (ma_loi, ten_loi, nhom_loi, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
    [maLoi, tenLoi, nhomLoi || null, actorId]
  );
  return rows[0].id;
}

async function updateLoaiLoi(id, { tenLoi, nhomLoi }, actorId) {
  await query(
    `UPDATE loai_loi SET ten_loi = $2, nhom_loi = $3, updated_by = $4, updated_date = CURRENT_TIMESTAMP WHERE id = $1`,
    [id, tenLoi, nhomLoi || null, actorId]
  );
}

async function setLoaiLoiActive(id, active, actorId) {
  await query(
    `UPDATE loai_loi SET dang_hoat_dong = $2, updated_by = $3, updated_date = CURRENT_TIMESTAMP WHERE id = $1`,
    [id, active, actorId]
  );
}

async function setTemTrangThai(client, temId, trangThai, actorId) {
  await client.query(
    'UPDATE tem SET trang_thai = $2, updated_by = $3, updated_date = CURRENT_TIMESTAMP WHERE id = $1',
    [temId, trangThai, actorId]
  );
}

// Đổi trạng thái + số lượng (dùng khi tách tem: phần đạt giữ lại trên tem gốc với SL đạt).
async function setTemStatusQty(client, temId, trangThai, soLuong, actorId) {
  await client.query(
    'UPDATE tem SET trang_thai = $2, so_luong = $3, updated_by = $4, updated_date = CURRENT_TIMESTAMP WHERE id = $1',
    [temId, trangThai, soLuong, actorId]
  );
}

// Sinh mã tem kế tiếp (dùng cho tem con khi tách ở KCS/Sửa). Gọi trước transaction.
async function nextMaTem() {
  const { rows } = await query(
    `SELECT 'TEM' || LPAD((COALESCE(MAX(NULLIF(regexp_replace(ma_tem,'\\D','','g'),''))::int,0)+1)::text, 5, '0') AS ma
     FROM tem`
  );
  return rows[0].ma;
}

// Tem con (tách từ tem cha) — cùng phiếu sản xuất, trạng thái tùy công đoạn.
async function createChildTem(client, { phieuId, maTem, soLuong, trangThai }, actorId) {
  const { rows } = await client.query(
    `INSERT INTO tem (phieu_san_xuat_id, ma_tem, so_luong, trang_thai, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [phieuId, maTem, soLuong, trangThai, actorId]
  );
  return rows[0].id;
}

async function insertTemSplit(client, { chaId, conId, soLuong, lyDo }, actorId) {
  await client.query(
    `INSERT INTO tem_split (tem_cha_id, tem_con_id, so_luong, ly_do, created_by) VALUES ($1,$2,$3,$4,$5)`,
    [chaId, conId, soLuong ?? null, lyDo || null, actorId]
  );
}

async function getTemForSplit(temId) {
  const { rows } = await query(
    'SELECT id, ma_tem, so_luong, trang_thai, phieu_san_xuat_id FROM tem WHERE id = $1', [temId]
  );
  return rows[0] || null;
}

async function insertKcs(client, temId, d, actorId) {
  await client.query(
    `INSERT INTO kcs (tem_id, so_luong_kiem, so_luong_mau, so_luong_dat, so_luong_loi, so_luong_huy,
                      so_luong_chenh_lech, ket_qua, ghi_chu, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [temId, d.soLuongKiem, d.soLuongMau, d.soLuongDat, d.soLuongLoi, d.soLuongHuy,
     d.soLuongChenhLech, d.ketQua, d.ghiChu || null, actorId]
  );
}

async function insertSua(client, temId, d, actorId) {
  await client.query(
    `INSERT INTO sua (tem_id, so_luong_sua, so_luong_sua_dat, so_luong_sua_huy, ghi_chu, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [temId, d.soLuongSua, d.soLuongSuaDat, d.soLuongSuaHuy, d.ghiChu || null, actorId]
  );
}

async function nextOqcRound(temId) {
  const { rows } = await query(
    'SELECT COALESCE(MAX(lan_kiem_cua_phan),0)+1 AS lan FROM oqc WHERE tem_id = $1',
    [temId]
  );
  return rows[0].lan;
}

async function insertOqc(client, temId, d, actorId) {
  await client.query(
    `INSERT INTO oqc (tem_id, lan_kiem_cua_phan, so_luong_kiem, so_luong_dat, so_luong_loi, ket_qua,
                      cho_giao, ly_do_cho_giao, owner_cho_giao_id, truong_hop_giao_id, ghi_chu,
                      nguon, sl_qua_giao, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [temId, d.lanKiem, d.soLuongKiem, d.soLuongDat, d.soLuongLoi, d.ketQua,
     d.choGiao === true, d.lyDoChoGiao || null, d.ownerChoGiaoId || null, d.truongHopGiaoId || null,
     d.ghiChu || null, d.nguon || 'KCS', d.slQuaGiao || 0, actorId]
  );
}

// ----- DANH MỤC TRƯỜNG HỢP GIAO ĐẶC BIỆT (truong_hop_giao_dac_biet) -----
async function listGiaoDacBietActive() {
  const { rows } = await query(
    'SELECT id, ma, ten FROM truong_hop_giao_dac_biet WHERE dang_hoat_dong = true ORDER BY ten'
  );
  return rows;
}

async function listGiaoDacBietAll(search = '') {
  const { rows } = await query(
    `SELECT id, ma, ten, dang_hoat_dong FROM truong_hop_giao_dac_biet
     WHERE ($1 = '' OR ma ILIKE '%'||$1||'%' OR ten ILIKE '%'||$1||'%')
     ORDER BY dang_hoat_dong DESC, ten`,
    [search]
  );
  return rows;
}

async function insertGiaoDacBiet({ ma, ten }, actorId) {
  const { rows } = await query(
    `INSERT INTO truong_hop_giao_dac_biet (ma, ten, created_by) VALUES ($1,$2,$3) RETURNING id`,
    [ma, ten, actorId]
  );
  return rows[0].id;
}

async function updateGiaoDacBiet(id, { ten }, actorId) {
  await query(
    `UPDATE truong_hop_giao_dac_biet SET ten = $2, updated_by = $3, updated_date = CURRENT_TIMESTAMP WHERE id = $1`,
    [id, ten, actorId]
  );
}

async function setGiaoDacBietActive(id, active, actorId) {
  await query(
    `UPDATE truong_hop_giao_dac_biet SET dang_hoat_dong = $2, updated_by = $3, updated_date = CURRENT_TIMESTAMP WHERE id = $1`,
    [id, active, actorId]
  );
}

// ----- Lịch sử theo ngày (giờ VN) cho KCS / Sửa / OQC -----
const HIST_DATE = `(x.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $1::date`;

// Hành trình 1 tem: gộp KCS / Sửa / OQC / Giao theo thời gian (n1..n5 số, txt phụ chú).
async function temTimeline(temId) {
  const sql = `SELECT loai, tg, nguoi, n1, n2, n3, n4, n5, txt FROM (
      SELECT 'KCS' AS loai, x.created_date AS tg, nd.ho_ten AS nguoi, x.so_luong_kiem AS n1, x.so_luong_dat AS n2, x.so_luong_loi AS n3, x.so_luong_huy AS n4, x.so_luong_chenh_lech AS n5, x.ket_qua::text AS txt FROM kcs x LEFT JOIN nguoi_dung nd ON nd.id = x.created_by WHERE x.tem_id = $1 AND ${notCancelledQc('x', 'kcs')}
      UNION ALL
      SELECT 'SUA', x.created_date, nd.ho_ten, x.so_luong_sua, x.so_luong_sua_dat, x.so_luong_sua_huy, NULL, NULL, NULL FROM sua x LEFT JOIN nguoi_dung nd ON nd.id = x.created_by WHERE x.tem_id = $1 AND ${notCancelledQc('x', 'sua')}
      UNION ALL
      SELECT 'OQC', x.created_date, nd.ho_ten, x.so_luong_kiem, x.so_luong_dat, x.so_luong_loi, NULL, NULL, x.ket_qua::text FROM oqc x LEFT JOIN nguoi_dung nd ON nd.id = x.created_by WHERE x.tem_id = $1 AND ${notCancelledQc('x', 'oqc')}
      UNION ALL
      SELECT 'GIAO', COALESCE(gh.ngay_giao::timestamptz, gt.created_date), nd.ho_ten, gt.so_luong_giao, NULL, NULL, NULL, NULL, (gh.ma_phieu_giao || ' · ' || gh.trang_thai) FROM giao_hang_tem gt JOIN giao_hang gh ON gh.id = gt.giao_hang_id LEFT JOIN nguoi_dung nd ON nd.id = gt.created_by WHERE gt.tem_id = $1
    ) e ORDER BY tg ASC NULLS LAST, loai`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [temId]);
  return rows;
}

async function kcsHistoryByDate(date) {
  const { rows } = await query(
    `SELECT x.created_date AS tg, nd.ho_ten AS nguoi, x.ket_qua,
            x.so_luong_dat, x.so_luong_loi, x.so_luong_huy, x.so_luong_chenh_lech, t.ma_tem
     FROM kcs x JOIN tem t ON t.id = x.tem_id
     LEFT JOIN nguoi_dung nd ON nd.id = x.created_by
     WHERE ${HIST_DATE} AND ${notCancelledQc('x', 'kcs')} ORDER BY x.created_date DESC`,
    [date]
  );
  return rows;
}

async function suaHistoryByDate(date) {
  const { rows } = await query(
    `SELECT x.created_date AS tg, nd.ho_ten AS nguoi,
            x.so_luong_sua, x.so_luong_sua_dat, x.so_luong_sua_huy, t.ma_tem
     FROM sua x JOIN tem t ON t.id = x.tem_id
     LEFT JOIN nguoi_dung nd ON nd.id = x.created_by
     WHERE ${HIST_DATE} AND ${notCancelledQc('x', 'sua')} ORDER BY x.created_date DESC`,
    [date]
  );
  return rows;
}

async function oqcHistoryByDate(date) {
  const { rows } = await query(
    `SELECT x.created_date AS tg, nd.ho_ten AS nguoi, x.ket_qua,
            x.so_luong_dat, x.so_luong_loi, x.so_luong_kiem, x.nguon, x.sl_qua_giao, t.ma_tem
     FROM oqc x JOIN tem t ON t.id = x.tem_id
     LEFT JOIN nguoi_dung nd ON nd.id = x.created_by
     WHERE ${HIST_DATE} AND ${notCancelledQc('x', 'oqc')} ORDER BY x.created_date DESC`,
    [date]
  );
  return rows;
}

// ----- Danh sách tem "đã hoàn thành" checkpoint (KCS/Sửa/OQC) theo ngày (giờ VN) -----
// Trả hình dạng đối tượng cho DonePanel: ma (mã tem) + ngữ cảnh phần in + SL + giờ + người.
const TEM_INFO_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang, pin.mau_vai, pin.kich_vai, pin.kich_phim,
           pin.tinh_chat_in, dv.han_giao_hang
    FROM phieu_san_xuat ps JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
    JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
    JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
    JOIN phan_in pin ON pin.id = dv.phan_in_id
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    WHERE ps.id = t.phieu_san_xuat_id ORDER BY pin.ma_phan, dv.ma_dot_vai LIMIT 1
  ) info ON true`;

// table ∈ 'kcs'|'sua'|'oqc' (nội bộ, không nhận từ user).
async function temDoneByDate(table, date) {
  const qtyCol = table === 'sua' ? 'so_luong_sua_dat' : 'so_luong_dat';
  const kiemCol = table === 'sua' ? 'so_luong_sua' : 'so_luong_kiem'; // SL đã kiểm (cho in tem KCS)
  // OQC: thêm nguồn (KCS/Sửa) + SL chuyền qua giao từ nguồn đó (sl_qua_giao). Sửa: thêm SL sửa hủy.
  const oqcCols = table === 'oqc' ? ', x.nguon, x.sl_qua_giao' : '';
  const suaCols = table === 'sua' ? ', x.so_luong_sua_huy' : '';
  const sql = `
    SELECT x.created_date AS tg, nd.ho_ten AS nguoi, t.ma_tem AS ma, t.id AS tem_id,
           x.${qtyCol} AS so_luong, x.${kiemCol} AS so_luong_kiem${oqcCols}${suaCols},
           info.ten_khach_hang, info.ma_don_hang, info.ma_hang, info.mau_vai, info.kich_vai, info.kich_phim,
           info.tinh_chat_in, info.han_giao_hang
    FROM ${table} x JOIN tem t ON t.id = x.tem_id
    LEFT JOIN nguoi_dung nd ON nd.id = x.created_by
    ${TEM_INFO_LATERAL}
    WHERE (x.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $1::date
      AND ${notCancelledQc('x', table)}
    ORDER BY x.created_date DESC`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [date]);
  return rows;
}

async function inlineDoneByDate(date) {
  const sql = `
    SELECT q.created_date AS tg, nd.ho_ten AS nguoi, ps.ma_phieu_san_xuat AS ma,
           q.so_luong_mau AS so_luong, q.ket_qua,
           info.ten_khach_hang, info.ma_don_hang, info.ma_hang, info.mau_vai, info.kich_vai, info.kich_phim,
           info.tinh_chat_in, info.han_giao_hang
    FROM qc_in_line q
    JOIN phieu_san_xuat ps ON ps.id = q.phieu_san_xuat_id
    JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
    LEFT JOIN nguoi_dung nd ON nd.id = q.created_by
    ${PHAN_INFO_LATERAL}
    WHERE (q.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $1::date
    ORDER BY q.created_date DESC`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [date]);
  return rows;
}

// ============ QC TRẢ VỀ (qc_tra_ve) — dùng chung 3 luồng READY/TEST_RUN/OQC ============
// OQC trả về TÁCH THEO NGUỒN của phần chờ OQC: 'OQC' = trả về KCS (tem 15-), 'OQC_SUA' = trả về Sửa (tem 17-).
// Dùng chính cột `loai` (VARCHAR, không ràng buộc) nên KHÔNG cần migration; mỗi màn đọc đúng loại của mình.
const RETURN_COL = { READY: 'phan_in_id', TEST_RUN: 'dot_vai_ve_id', OQC: 'tem_id', OQC_SUA: 'tem_id' };

// Ghi 1 lần QC trả về (không transaction — gọi sau khi commit nghiệp vụ chính).
// Best-effort: bảng chưa tạo (migration 042 chưa chạy) → chỉ log, không làm hỏng thao tác trả về.
async function insertQcTraVe({ loai, phanInId, dotVaiId, lenhId, temId, checklistList, lyDo }, actorId) {
  try {
    await query(
      `INSERT INTO qc_tra_ve (loai, phan_in_id, dot_vai_ve_id, lenh_san_xuat_id, tem_id, checklist_list, ly_do, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [loai, phanInId || null, dotVaiId || null, lenhId || null, temId || null, checklistList || null, lyDo, actorId]
    );
  } catch (e) {
    console.error(`[qc-tra-ve] ✗ ghi trả về lỗi (kiểm tra migration 042): ${e.message}`);
  }
}

// Map { objId: {ly_do, checklist_list, tg, nguoi, so_lan} } các bản ghi trả về CHƯA xử lý — gắn badge + modal lý do.
// Best-effort (bảng chưa có → {}).
async function activeReturnsMap(loai, ids) {
  const col = RETURN_COL[loai];
  if (!col || !Array.isArray(ids) || ids.length === 0) return {};
  try {
    const { rows } = await query(
      `SELECT DISTINCT ON (q.${col}) q.${col} AS obj_id, q.ly_do, q.checklist_list,
              q.created_date AS tg, nd.ho_ten AS nguoi,
              (SELECT count(*) FROM qc_tra_ve q2 WHERE q2.loai = $1 AND q2.${col} = q.${col} AND q2.da_xu_ly = false)::int AS so_lan
       FROM qc_tra_ve q LEFT JOIN nguoi_dung nd ON nd.id = q.created_by
       WHERE q.loai = $1 AND q.da_xu_ly = false AND q.${col} = ANY($2::uuid[])
       ORDER BY q.${col}, q.created_date DESC`,
      [loai, ids]
    );
    const m = {};
    rows.forEach((r) => { m[r.obj_id] = { ly_do: r.ly_do, checklist_list: r.checklist_list, tg: r.tg, nguoi: r.nguoi, so_lan: r.so_lan }; });
    return m;
  } catch (e) { return {}; }
}

// Tắt cờ trả về (da_xu_ly=true) khi đối tượng đã làm lại xong. Best-effort.
async function resolveReturns(loai, id) {
  const col = RETURN_COL[loai];
  if (!col || !id) return;
  try {
    await query(
      `UPDATE qc_tra_ve SET da_xu_ly = true, updated_date = CURRENT_TIMESTAMP WHERE loai = $1 AND ${col} = $2 AND da_xu_ly = false`,
      [loai, id]
    );
  } catch (e) { /* migration 042 chưa chạy */ }
}

async function resolveReturnsMany(loai, ids) {
  for (const id of (ids || [])) await resolveReturns(loai, id);
}

// Lịch sử QC trả về theo loại + ngày (giờ VN) — cho trang "Lịch sử QC trả về".
// `loaiList` = 1 hoặc nhiều mã loại (tab OQC gộp cả 'OQC' → KCS và 'OQC_SUA' → Sửa).
async function listQcTraVe(loaiList, date) {
  const loais = Array.isArray(loaiList) ? loaiList : [loaiList];
  const sql = `
    SELECT qtv.created_date AS tg, nd.ho_ten AS nguoi, qtv.ly_do, qtv.checklist_list, qtv.da_xu_ly, qtv.loai,
           COALESCE(pin.ma_phan, pin2.ma_phan) AS ma_phan,
           COALESCE(mh.ma_hang, mh2.ma_hang) AS ma_hang,
           COALESCE(kh.ten_khach_hang, kh2.ten_khach_hang) AS ten_khach_hang,
           ls.ma_lenh_san_xuat, dv.ma_dot_vai, t.ma_tem
    FROM qc_tra_ve qtv
    LEFT JOIN nguoi_dung nd ON nd.id = qtv.created_by
    LEFT JOIN phan_in pin ON pin.id = qtv.phan_in_id
    LEFT JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    LEFT JOIN don_hang dh ON dh.id = mh.don_hang_id
    LEFT JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    LEFT JOIN lenh_san_xuat ls ON ls.id = qtv.lenh_san_xuat_id
    LEFT JOIN dot_vai_ve dv ON dv.id = qtv.dot_vai_ve_id
    LEFT JOIN phan_in pin2 ON pin2.id = dv.phan_in_id
    LEFT JOIN ma_hang mh2 ON mh2.id = pin2.ma_hang_id
    LEFT JOIN don_hang dh2 ON dh2.id = mh2.don_hang_id
    LEFT JOIN khach_hang kh2 ON kh2.id = dh2.khach_hang_id
    LEFT JOIN tem t ON t.id = qtv.tem_id
    WHERE qtv.loai = ANY($1) AND (qtv.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $2::date
    ORDER BY qtv.created_date DESC`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [loais, date]);
  return rows;
}

// ============ HỦY XÁC NHẬN KCS / SỬA / OQC (đảo sổ cái tem, đánh dấu audit_log) ============
// Danh sách bản ghi xác nhận theo ngày (giờ VN) — CHƯA bị hủy — để chọn hủy. Kèm ngữ cảnh phần in.
async function listCancelKcs(date) {
  const sql = `
    SELECT x.id, x.created_date AS tg, nd.ho_ten AS nguoi, t.id AS tem_id, t.ma_tem, x.ket_qua,
           x.so_luong_kiem, x.so_luong_dat, x.so_luong_loi, x.so_luong_huy, x.so_luong_chenh_lech,
           info.ten_khach_hang, info.ma_don_hang, info.ma_hang, info.mau_vai, info.kich_vai, info.kich_phim
    FROM kcs x JOIN tem t ON t.id = x.tem_id
    LEFT JOIN nguoi_dung nd ON nd.id = x.created_by
    ${TEM_INFO_LATERAL}
    WHERE (x.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $1::date AND ${notCancelledQc('x', 'kcs')}
    ORDER BY x.created_date DESC`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [date]);
  return rows;
}
async function listCancelSua(date) {
  const sql = `
    SELECT x.id, x.created_date AS tg, nd.ho_ten AS nguoi, t.id AS tem_id, t.ma_tem,
           x.so_luong_sua, x.so_luong_sua_dat, x.so_luong_sua_huy,
           info.ten_khach_hang, info.ma_don_hang, info.ma_hang, info.mau_vai, info.kich_vai, info.kich_phim
    FROM sua x JOIN tem t ON t.id = x.tem_id
    LEFT JOIN nguoi_dung nd ON nd.id = x.created_by
    ${TEM_INFO_LATERAL}
    WHERE (x.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $1::date AND ${notCancelledQc('x', 'sua')}
    ORDER BY x.created_date DESC`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [date]);
  return rows;
}
async function listCancelOqc(date) {
  const sql = `
    SELECT x.id, x.created_date AS tg, nd.ho_ten AS nguoi, t.id AS tem_id, t.ma_tem, x.ket_qua, x.cho_giao,
           x.so_luong_kiem, x.so_luong_dat, x.so_luong_loi,
           info.ten_khach_hang, info.ma_don_hang, info.ma_hang, info.mau_vai, info.kich_vai, info.kich_phim
    FROM oqc x JOIN tem t ON t.id = x.tem_id
    LEFT JOIN nguoi_dung nd ON nd.id = x.created_by
    ${TEM_INFO_LATERAL}
    WHERE (x.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $1::date AND ${notCancelledQc('x', 'oqc')}
    ORDER BY x.created_date DESC`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [date]);
  return rows;
}

// Lấy 1 bản ghi xác nhận + SỔ CÁI hiện tại của tem (để service validate đảo ngược an toàn).
const CANCEL_TARGET_TEM_COLS =
  `t.ma_tem, t.sl_kcs_dat, t.sl_kcs_sua, t.sl_kcs_huy, t.sl_sua_dat, t.sl_sua_huy, t.sl_oqc_dat, t.sl_oqc_dat_sua, t.sl_da_giao, t.sl_chenh_lech`;

async function getCancelKcsRow(id) {
  const { rows } = await query(
    `SELECT x.id, x.tem_id, x.so_luong_kiem, x.so_luong_dat, x.so_luong_loi, x.so_luong_huy, x.so_luong_chenh_lech,
            ${CANCEL_TARGET_TEM_COLS}, ${cancelledQc('x', 'kcs')} AS da_huy
     FROM kcs x JOIN tem t ON t.id = x.tem_id WHERE x.id = $1`.replace(/\s+/g, ' '),
    [id]
  );
  return rows[0] || null;
}
async function getCancelSuaRow(id) {
  const { rows } = await query(
    `SELECT x.id, x.tem_id, x.so_luong_sua, x.so_luong_sua_dat, x.so_luong_sua_huy,
            ${CANCEL_TARGET_TEM_COLS}, ${cancelledQc('x', 'sua')} AS da_huy
     FROM sua x JOIN tem t ON t.id = x.tem_id WHERE x.id = $1`.replace(/\s+/g, ' '),
    [id]
  );
  return rows[0] || null;
}
async function getCancelOqcRow(id) {
  const { rows } = await query(
    `SELECT x.id, x.tem_id, x.so_luong_dat, x.so_luong_loi, x.cho_giao, x.nguon, x.sl_qua_giao,
            ${CANCEL_TARGET_TEM_COLS}, ${cancelledQc('x', 'oqc')} AS da_huy
     FROM oqc x JOIN tem t ON t.id = x.tem_id WHERE x.id = $1`.replace(/\s+/g, ' '),
    [id]
  );
  return rows[0] || null;
}

// Ghi audit_log HỦY XÁC NHẬN (đánh dấu bản ghi đã hủy — loại khỏi mọi danh sách/lịch sử/hành trình).
async function logCancelQc(table, id, temId, maTem, lyDo, actorId) {
  await query(
    `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ($1, $2, 'HUY_XAC_NHAN', $3::jsonb, $4, CURRENT_TIMESTAMP, $4)`,
    [table, String(id), JSON.stringify({ tem_id: temId, ma_tem: maTem || null, ly_do: lyDo || null }), actorId]
  );
}

// ============ HỦY TEM SỬA — XÓA SL SỬA khỏi sổ cái (KHÔNG cần cột cờ / migration) ============
// "Tem sửa" (nhãn 16-) = phần chờ sửa `con_sua` của tem. Hủy = bỏ con_sua khỏi `sl_kcs_sua`:
//   · KCS đã có SL đạt (sl_kcs_dat > 0) → dồn con_sua sang `sl_kcs_huy` (loại hẳn, tem KHÔNG về KCS).
//   · Chưa có SL đạt (sl_kcs_dat = 0)   → chỉ trừ `sl_kcs_sua` ⇒ SL quay lại `con_kcs` (KCS kiểm lại).
// con_sua về 0 ⇒ tem tự rời màn Sửa. Mở lại = đảo đúng 2 delta trên (đọc snapshot từ audit_log).

// Tem sửa còn hiệu lực (con_sua > 0) — cho tab "Hủy tem sửa".
async function listTemSua({ search = '' } = {}) {
  const params = [];
  const conds = [`${CON_SUA} > 0`];
  if (search) {
    params.push(search);
    const i = params.length;
    conds.push(`(t.ma_tem ILIKE '%'||$${i}||'%' OR ls.ma_lenh_san_xuat ILIKE '%'||$${i}||'%' OR ${lenhPhanInMatch('ls.id', `$${i}`)})`);
  }
  const sql = `
    SELECT t.id AS tem_id, t.ma_tem, t.so_luong, t.trang_thai,
           t.sl_kcs_dat, t.sl_kcs_sua, t.sl_kcs_huy, t.sl_sua_dat, t.sl_sua_huy,
           ${CON_SUA} AS con_sua, ${CON_KCS} AS con_kcs, ${CON_OQC} AS con_oqc,
           ls.ma_lenh_san_xuat, cs.ten_chuyen,
           info.ten_khach_hang, info.ma_don_hang, info.ma_hang, info.mau_vai, info.kich_vai, info.kich_phim
    FROM tem t
    JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
    JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
    LEFT JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
    ${TEM_INFO_LATERAL}
    WHERE ${conds.join(' AND ')}
    ORDER BY t.created_date DESC`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), params);
  return rows;
}

// Tem sửa ĐANG bị hủy — suy từ audit_log: sự kiện MỚI NHẤT của tem là HUY_TEM_SUA (chưa bị MO_TEM_SUA
// đảo lại). Chịu được chuỗi hủy → mở → hủy. Cho tab "Mở lại tem sửa".
async function listTemSuaDaHuy({ search = '' } = {}) {
  const params = [];
  const conds = ["last.hanh_dong = 'HUY_TEM_SUA'"];
  if (search) {
    params.push(search);
    const i = params.length;
    conds.push(`(t.ma_tem ILIKE '%'||$${i}||'%' OR ls.ma_lenh_san_xuat ILIKE '%'||$${i}||'%' OR ${lenhPhanInMatch('ls.id', `$${i}`)})`);
  }
  const sql = `
    SELECT t.id AS tem_id, t.ma_tem, t.so_luong, t.trang_thai,
           t.sl_kcs_dat, t.sl_kcs_sua, t.sl_kcs_huy, ${CON_SUA} AS con_sua, ${CON_KCS} AS con_kcs,
           ls.ma_lenh_san_xuat, cs.ten_chuyen,
           info.ten_khach_hang, info.ma_don_hang, info.ma_hang, info.mau_vai, info.kich_vai, info.kich_phim,
           last.tg AS tg_huy, last.gia_tri_moi, nd.ho_ten AS nguoi_huy
    FROM (
      SELECT DISTINCT ON (a.id_ban_ghi) a.id_ban_ghi AS tem_id, a.hanh_dong, a.thoi_gian AS tg,
             a.gia_tri_moi, a.nguoi_thuc_hien_id
      FROM audit_log a
      WHERE a.ten_bang = 'tem' AND a.hanh_dong IN ('HUY_TEM_SUA','MO_TEM_SUA')
      ORDER BY a.id_ban_ghi, a.thoi_gian DESC
    ) last
    JOIN tem t ON t.id = last.tem_id::uuid
    JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
    JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
    LEFT JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
    LEFT JOIN nguoi_dung nd ON nd.id = last.nguoi_thuc_hien_id
    ${TEM_INFO_LATERAL}
    WHERE ${conds.join(' AND ')}
    ORDER BY last.tg DESC`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), params);
  return rows.map((r) => {
    const v = typeof r.gia_tri_moi === 'string' ? JSON.parse(r.gia_tri_moi || '{}') : (r.gia_tri_moi || {});
    const { gia_tri_moi, ...rest } = r;
    return { ...rest, sl_huy: Number(v.sl) || 0, da_cong_huy: !!v.da_cong_huy, ly_do: v.ly_do || null, tu_dong: !!v.tu_dong };
  });
}

// Tem + sổ cái phần sửa (để service validate trước khi hủy/mở lại). 1 query cho nhiều tem — IPS-safe.
// Truyền `client` khi cần đọc TRONG transaction đang mở (thấy các thay đổi chưa commit).
async function getTemSuaRows(temIds, client) {
  if (!temIds || temIds.length === 0) return [];
  const run = client ? client.query.bind(client) : query;
  const { rows } = await run(
    `SELECT t.id AS tem_id, t.ma_tem, t.sl_kcs_dat, t.sl_kcs_sua, t.sl_kcs_huy, t.sl_sua_dat, t.sl_sua_huy,
            (t.sl_kcs_sua - (t.sl_sua_dat + t.sl_sua_huy)) AS con_sua,
            ((t.so_luong + t.sl_chenh_lech) - (t.sl_kcs_dat + t.sl_kcs_sua + t.sl_kcs_huy)) AS con_kcs
     FROM tem t WHERE t.id = ANY($1::uuid[])`.replace(/\s+/g, ' '),
    [temIds]
  );
  return rows;
}
const getTemSuaRow = async (temId) => (await getTemSuaRows([temId]))[0] || null;

// Cộng delta vào sổ cái sửa/hủy của NHIỀU tem trong 1 câu lệnh (unnest) — tránh N round-trip.
// items = [{ temId, dSua, dHuy }] (hủy: dSua=-x, dHuy=+x|0 · mở lại: dSua=+x, dHuy=-x|0).
async function applyTemSuaLedgerMany(client, items, actorId) {
  if (!items || items.length === 0) return;
  await client.query(
    `UPDATE tem t SET sl_kcs_sua = t.sl_kcs_sua + v.ds, sl_kcs_huy = t.sl_kcs_huy + v.dh,
       updated_by = $4, updated_date = CURRENT_TIMESTAMP
     FROM unnest($1::uuid[], $2::int[], $3::int[]) AS v(id, ds, dh) WHERE t.id = v.id`.replace(/\s+/g, ' '),
    [items.map((i) => i.temId), items.map((i) => i.dSua), items.map((i) => i.dHuy), actorId]
  );
}

// Audit hủy/mở lại tem sửa (HUY_TEM_SUA / MO_TEM_SUA) — người/giờ/lý do + snapshot delta để đảo lại.
// Ghi NHIỀU dòng bằng 1 INSERT (unnest) — `items` = [{ temId, payload }].
async function logTemSuaMany(client, hanhDong, items, actorId) {
  if (!items || items.length === 0) return;
  await client.query(
    `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     SELECT 'tem', x.id, $2, x.val::jsonb, $4, CURRENT_TIMESTAMP, $4
     FROM unnest($1::text[], $3::text[]) AS x(id, val)`.replace(/\s+/g, ' '),
    [items.map((i) => String(i.temId)), hanhDong, items.map((i) => JSON.stringify(i.payload || {})), actorId]
  );
}

// ============ GỘP TEM (KCS) — chuyển SL các tem về tem đầu tiên, hủy các tem nguồn ============
// Lấy tem + phần in + cờ "chưa kiểm" (sổ cái = 0) để kiểm tra điều kiện gộp.
async function getTemsForMerge(temIds) {
  const { rows } = await query(
    `SELECT t.id, t.ma_tem, t.so_luong, t.trang_thai, t.da_qua_phoi,
            (COALESCE(t.sl_kcs_dat,0)+COALESCE(t.sl_kcs_sua,0)+COALESCE(t.sl_kcs_huy,0)
             +COALESCE(t.sl_sua_dat,0)+COALESCE(t.sl_sua_huy,0)+COALESCE(t.sl_oqc_dat,0)+COALESCE(t.sl_da_giao,0)) AS da_xu_ly,
            pin.id AS phan_in_id, pin.ma_phan
     FROM tem t
     JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
     JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
     LEFT JOIN LATERAL (
       SELECT dv.phan_in_id FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
       WHERE lsd.lenh_san_xuat_id = ls.id LIMIT 1
     ) dvp ON true
     LEFT JOIN phan_in pin ON pin.id = dvp.phan_in_id
     WHERE t.id = ANY($1::uuid[])`.replace(/\s+/g, ' '),
    [temIds]
  );
  return rows;
}

// Cộng SL gộp vào tem đích + cập nhật cờ đã-qua-phơi.
async function addTemSoLuong(client, temId, addQty, daQuaPhoi, actorId) {
  await client.query(
    `UPDATE tem SET so_luong = so_luong + $2, da_qua_phoi = da_qua_phoi OR $3,
       updated_by=$4, updated_date=CURRENT_TIMESTAMP WHERE id=$1`,
    [temId, addQty, !!daQuaPhoi, actorId]
  );
}

// Ghi audit gộp tem.
async function logGopTem(client, targetTemId, maTem, nguon, actorId) {
  await client.query(
    `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ('tem', $1, 'GOP_TEM', $2::jsonb, $3, CURRENT_TIMESTAMP, $3)`,
    [String(targetTemId), JSON.stringify({ ma_tem: maTem, nguon }), actorId]
  );
}

module.exports = {
  insertQcTraVe, activeReturnsMap, resolveReturns, resolveReturnsMany, listQcTraVe,
  listTemSua, listTemSuaDaHuy, getTemSuaRow, getTemSuaRows, applyTemSuaLedgerMany, logTemSuaMany,
  getTemsForMerge, addTemSoLuong, logGopTem,
  listCancelKcs, listCancelSua, listCancelOqc, getCancelKcsRow, getCancelSuaRow, getCancelOqcRow, logCancelQc,
  listKcsCand, listSuaCand, listOqcCand, caPartsForTems, prevConfirmerByTems, getTemBasic, setTemTrangThai, setTemStatusQty,
  getTemLedger, addKcsLedger, addSuaLedger, addOqcLedger, addGiaoLedger, reduceKcsDat, reduceSuaDat,
  recomputeTemStage, recomputeTemStageMany,
  temTimeline,
  nextMaTem, createChildTem, insertTemSplit, getTemForSplit,
  insertKcs, insertSua, nextOqcRound, insertOqc,
  kcsHistoryByDate, suaHistoryByDate, oqcHistoryByDate,
  temDoneByDate, inlineDoneByDate,
  listInlineCandidates, getPhieuRun, nextInlineRound, insertQcInline, insertQcInlineLoi, inlineHistoryByDate,
  listLoaiLoiActive, listLoaiLoiAll, insertLoaiLoi, updateLoaiLoi, setLoaiLoiActive,
  listGiaoDacBietActive, listGiaoDacBietAll, insertGiaoDacBiet, updateGiaoDacBiet, setGiaoDacBietActive,
};
