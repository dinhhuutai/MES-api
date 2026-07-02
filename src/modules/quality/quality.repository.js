'use strict';

const { query } = require('../../config/db');
const { lenhPhanInMatch } = require('../../utils/search');

const TEM_CTX = `
  SELECT t.id AS tem_id, t.ma_tem, t.so_luong, t.trang_thai,
         ls.ma_lenh_san_xuat, cs.ma_chuyen,
         info.ten_khach_hang, info.ma_don_hang, info.ma_hang, info.mau_vai, info.kich_vai, info.kich_phim,
         sla.tg_vao, sla.sla_phut, sla.canh_bao_truoc_phut,
         (SELECT string_agg(DISTINCT pin.ma_phan, ', ')
            FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
            JOIN phan_in pin ON pin.id = dv.phan_in_id WHERE lsd.lenh_san_xuat_id = ls.id) AS phan_list
  FROM tem t
  JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
  JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
  LEFT JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
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

async function listByTemStatus(status, { search = '' }) {
  const { rows } = await query(
    `${TEM_CTX}
     WHERE t.trang_thai = $1 AND ($2 = '' OR t.ma_tem ILIKE '%'||$2||'%' OR ls.ma_lenh_san_xuat ILIKE '%'||$2||'%'
            OR ${lenhPhanInMatch('ls.id', '$2')})
     ORDER BY t.created_date`,
    [status, search]
  );
  return rows;
}

async function getTemBasic(temId) {
  const { rows } = await query('SELECT id, ma_tem, so_luong, trang_thai FROM tem WHERE id = $1', [temId]);
  return rows[0] || null;
}

// ----- QC IN-LINE (kiểm tại chuyền — phiếu đang chạy) -----
const PHAN_INFO_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang,
           pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.ma_phan
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
                      cho_giao, ly_do_cho_giao, owner_cho_giao_id, ghi_chu, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [temId, d.lanKiem, d.soLuongKiem, d.soLuongDat, d.soLuongLoi, d.ketQua,
     d.choGiao === true, d.lyDoChoGiao || null, d.ownerChoGiaoId || null, d.ghiChu || null, actorId]
  );
}

// ----- Lịch sử theo ngày (giờ VN) cho KCS / Sửa / OQC -----
const HIST_DATE = `(x.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $1::date`;

async function kcsHistoryByDate(date) {
  const { rows } = await query(
    `SELECT x.created_date AS tg, nd.ho_ten AS nguoi, x.ket_qua,
            x.so_luong_dat, x.so_luong_loi, t.ma_tem
     FROM kcs x JOIN tem t ON t.id = x.tem_id
     LEFT JOIN nguoi_dung nd ON nd.id = x.created_by
     WHERE ${HIST_DATE} ORDER BY x.created_date DESC`,
    [date]
  );
  return rows;
}

async function suaHistoryByDate(date) {
  const { rows } = await query(
    `SELECT x.created_date AS tg, nd.ho_ten AS nguoi,
            x.so_luong_sua, x.so_luong_sua_dat, t.ma_tem
     FROM sua x JOIN tem t ON t.id = x.tem_id
     LEFT JOIN nguoi_dung nd ON nd.id = x.created_by
     WHERE ${HIST_DATE} ORDER BY x.created_date DESC`,
    [date]
  );
  return rows;
}

async function oqcHistoryByDate(date) {
  const { rows } = await query(
    `SELECT x.created_date AS tg, nd.ho_ten AS nguoi, x.ket_qua,
            x.so_luong_dat, x.so_luong_loi, t.ma_tem
     FROM oqc x JOIN tem t ON t.id = x.tem_id
     LEFT JOIN nguoi_dung nd ON nd.id = x.created_by
     WHERE ${HIST_DATE} ORDER BY x.created_date DESC`,
    [date]
  );
  return rows;
}

module.exports = {
  listByTemStatus, getTemBasic, setTemTrangThai, setTemStatusQty,
  nextMaTem, createChildTem, insertTemSplit, getTemForSplit,
  insertKcs, insertSua, nextOqcRound, insertOqc,
  kcsHistoryByDate, suaHistoryByDate, oqcHistoryByDate,
  listInlineCandidates, getPhieuRun, nextInlineRound, insertQcInline, insertQcInlineLoi, inlineHistoryByDate,
  listLoaiLoiActive, listLoaiLoiAll, insertLoaiLoi, updateLoaiLoi, setLoaiLoiActive,
};
