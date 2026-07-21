'use strict';

const { query } = require('../../config/db');

// ----- Log đồng bộ -----
async function createSyncLog({ nguon, fromDate, tuDong }, actorId) {
  const { rows } = await query(
    `INSERT INTO erp_sync_log (nguon, from_date, tu_dong, trang_thai, created_by)
     VALUES ($1,$2,$3,'DANG_CHAY',$4) RETURNING id`,
    [nguon, fromDate || null, !!tuDong, actorId || null]
  );
  return rows[0].id;
}

async function finishSyncLog(id, { tong, soMoi, soCapNhat, soLoi, trangThai, thongDiep }) {
  await query(
    `UPDATE erp_sync_log SET tg_kt=CURRENT_TIMESTAMP, tong_ban_ghi=$2, so_moi=$3, so_cap_nhat=$4,
       so_loi=$5, trang_thai=$6, thong_diep=$7 WHERE id=$1`,
    [id, tong ?? 0, soMoi ?? 0, soCapNhat ?? 0, soLoi ?? 0, trangThai, thongDiep || null]
  );
}

// Lưu NGUYÊN VĂN chuỗi ERP trả về (TEXT) cho lần đồng bộ này.
async function saveSyncRaw(logId, rawText) {
  await query('UPDATE erp_sync_log SET du_lieu_tho = $2 WHERE id = $1',
    [logId, typeof rawText === 'string' ? rawText : (rawText == null ? null : String(rawText))]);
}

// Đọc lại chuỗi thô của 1 lần đồng bộ. Cast ::text để luôn trả chuỗi (dù cột là JSONB hay TEXT).
async function getSyncRaw(logId) {
  const { rows } = await query('SELECT du_lieu_tho::text AS du_lieu_tho FROM erp_sync_log WHERE id = $1', [logId]);
  return rows[0] ? (rows[0].du_lieu_tho || null) : null;
}

// Lịch sử đồng bộ — lọc theo NGÀY BẮT ĐẦU (giờ VN) + phân trang.
async function listSyncHistory({ date, offset = 0, limit = 20 } = {}) {
  const params = [];
  let where = '';
  if (date) {
    params.push(date);
    where = `WHERE (l.tg_bd AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $${params.length}::date`;
  }
  const dataSql = `
    SELECT l.id, l.nguon, l.from_date, l.tg_bd, l.tg_kt, l.tong_ban_ghi, l.so_moi, l.so_cap_nhat,
           l.so_loi, l.trang_thai, l.tu_dong, l.thong_diep, nd.ho_ten AS nguoi,
           (l.du_lieu_tho IS NOT NULL) AS co_tho,
           COALESCE(length(l.du_lieu_tho::text), 0) AS so_ky_tu
    FROM erp_sync_log l LEFT JOIN nguoi_dung nd ON nd.id = l.created_by
    ${where}
    ORDER BY l.tg_bd DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  const countSql = `SELECT count(*)::int AS total FROM erp_sync_log l ${where}`;
  const [data, count] = await Promise.all([
    query(dataSql, [...params, limit, offset]),
    query(countSql, params),
  ]);
  return { rows: data.rows, total: count.rows[0].total };
}

// ----- Lưu dữ liệu THÔ (task 1) -----
// items: [{ maDotVai, codePart, boQua, payload(object) }]. Upsert theo ma_dot_vai (1 đợt = 1 dòng raw).
async function insertRawBatch(syncLogId, items) {
  if (!items.length) return;
  const cols = 4; // ma_dot_vai, code_part, bo_qua, payload  (+ erp_sync_log_id chung)
  const values = [];
  const params = [syncLogId];
  items.forEach((it, i) => {
    const b = i * cols + 2; // $1 = syncLogId
    values.push(`($${b}, $${b + 1}, $${b + 2}, $${b + 3}::jsonb, $1)`);
    params.push(it.maDotVai, it.codePart || null, !!it.boQua, JSON.stringify(it.payload));
  });
  await query(
    `INSERT INTO erp_phieu_nhan_vai_raw (ma_dot_vai, code_part, bo_qua, payload, erp_sync_log_id)
     VALUES ${values.join(',')}
     ON CONFLICT (ma_dot_vai) DO UPDATE SET
       code_part = EXCLUDED.code_part, bo_qua = EXCLUDED.bo_qua, payload = EXCLUDED.payload,
       erp_sync_log_id = EXCLUDED.erp_sync_log_id, updated_date = CURRENT_TIMESTAMP`,
    params
  );
}

// ----- Upsert cây dữ liệu (idempotent theo mã) -----
async function upsertKhachHang(client, { ma, ten }) {
  const { rows } = await client.query(
    `INSERT INTO khach_hang (ma_khach_hang, ten_khach_hang) VALUES ($1,$2)
     ON CONFLICT (ma_khach_hang) DO UPDATE SET ten_khach_hang = EXCLUDED.ten_khach_hang
     RETURNING id`,
    [ma, ten || ma]
  );
  return rows[0].id;
}

async function upsertDonHang(client, { maDon, khachHangId }) {
  const { rows } = await client.query(
    `INSERT INTO don_hang (khach_hang_id, ma_don_hang) VALUES ($1,$2)
     ON CONFLICT (ma_don_hang) DO UPDATE SET khach_hang_id = EXCLUDED.khach_hang_id
     RETURNING id`,
    [khachHangId, maDon]
  );
  return rows[0].id;
}

async function upsertMaHang(client, { donHangId, maHang, tenMaHang }) {
  const { rows } = await client.query(
    `INSERT INTO ma_hang (don_hang_id, ma_hang, ten_ma_hang) VALUES ($1,$2,$3)
     ON CONFLICT (don_hang_id, ma_hang) DO UPDATE SET ten_ma_hang = COALESCE(EXCLUDED.ten_ma_hang, ma_hang.ten_ma_hang)
     RETURNING id`,
    [donHangId, maHang, tenMaHang || null]
  );
  return rows[0].id;
}

// Kiểm tra cột barcode (mig 055) có tồn tại chưa — cache 1 lần. KHÔNG dùng try/catch trong transaction
// vì 1 statement lỗi làm ABORT cả transaction (Postgres) → fallback trong cùng client sẽ hỏng theo.
let _hasBarcodeCol = null;
async function hasBarcodeCol(client) {
  if (_hasBarcodeCol != null) return _hasBarcodeCol;
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name='phan_in' AND column_name='barcode' LIMIT 1`);
  _hasBarcodeCol = rows.length > 0;
  return _hasBarcodeCol;
}

// `tinhChatIn` = ERP `Tinhchatin`, `barcode` = ERP `barCode`. COALESCE khi update: ERP không gửi (null)
// thì GIỮ giá trị cũ, tránh re-sync bằng payload cũ (chưa có trường này) xóa mất giá trị đã lưu.
async function upsertPhanIn(client, { maHangId, maPhan, mauVai, kichVai, kichPhim, soLuongDonHang, tinhChatIn, barcode }) {
  const base = [maHangId, maPhan, mauVai || null, kichVai || null, kichPhim || null, soLuongDonHang ?? null, tinhChatIn || null];
  if (await hasBarcodeCol(client)) {
    const { rows } = await client.query(
      `INSERT INTO phan_in (ma_hang_id, ma_phan, mau_vai, kich_vai, kich_phim, so_luong_don_hang, tinh_chat_in, barcode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (ma_phan) DO UPDATE SET
         mau_vai = EXCLUDED.mau_vai, kich_vai = EXCLUDED.kich_vai, kich_phim = EXCLUDED.kich_phim,
         so_luong_don_hang = EXCLUDED.so_luong_don_hang,
         tinh_chat_in = COALESCE(EXCLUDED.tinh_chat_in, phan_in.tinh_chat_in),
         barcode = COALESCE(EXCLUDED.barcode, phan_in.barcode),
         updated_date = CURRENT_TIMESTAMP
       RETURNING id`,
      [...base, barcode || null]
    );
    return rows[0].id;
  }
  const { rows } = await client.query(
    `INSERT INTO phan_in (ma_hang_id, ma_phan, mau_vai, kich_vai, kich_phim, so_luong_don_hang, tinh_chat_in)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (ma_phan) DO UPDATE SET
       mau_vai = EXCLUDED.mau_vai, kich_vai = EXCLUDED.kich_vai, kich_phim = EXCLUDED.kich_phim,
       so_luong_don_hang = EXCLUDED.so_luong_don_hang,
       tinh_chat_in = COALESCE(EXCLUDED.tinh_chat_in, phan_in.tinh_chat_in),
       updated_date = CURRENT_TIMESTAMP
     RETURNING id`,
    base
  );
  return rows[0].id;
}

// Ghi thời gian chờ khô (ERP tgphoi) vào phần in — BEST-EFFORT, tách khỏi transaction chính:
// nếu cột chưa có (migration 038 chưa chạy ở môi trường nào đó) thì bỏ qua, KHÔNG làm hỏng cả lần sync.
async function setPhanInDryMin(phanInId, phut) {
  if (phut == null) return;
  try {
    await query('UPDATE phan_in SET thoi_gian_cho_kho_phut = $2, updated_date = CURRENT_TIMESTAMP WHERE id = $1',
      [phanInId, phut]);
  } catch (e) { /* migration 038 chưa chạy — bỏ qua */ }
}

// Tra id loại đợt vải CHUẨN theo ma_loai (SO_LUONG/BO_SUNG/MAU — đã seed). KHÔNG tạo mới loại rác từ mã ERP.
// Best-effort → null nếu không đọc được (đợt vải để loại trống, không phá sync).
async function getLoaiDotVaiId(maLoai) {
  try {
    const { rows } = await query('SELECT id FROM loai_dot_vai WHERE ma_loai = $1 LIMIT 1', [maLoai]);
    return rows[0] ? rows[0].id : null;
  } catch (e) { return null; }
}

// Trả về { id, inserted }. `soLuong` = received_qty (LŨY KẾ của code phần từ ERP).
// QUY TẮC SL đợt vải mới = received_qty − Σ(so_luong_vai_ve các đợt TRƯỚC của cùng phần in):
//  - phần in CHƯA có đợt nào (mới) → Σ = 0 → SL đợt = received_qty.
//  - phần in ĐÃ có đợt → SL đợt lần này = phần chênh (received_qty lũy kế − đã nhận trước đó). Clamp ≥ 0.
// Đợt đã tồn tại (re-sync idempotent theo ma_dot_vai) → GIỮ NGUYÊN so_luong_vai_ve đã tính lúc tạo,
//  chỉ cập nhật ngày/hạn/loại (tránh cộng dồn sai khi ERP trả lại dòng cũ).
// `tgChuyenReady`: Date = đợt vào READY ngay (mig 056); null = CHỜ chuyển (pending). Re-sync GIỮ NGUYÊN mốc cũ.
async function upsertDotVai(client, { maDotVai, phanInId, loaiDotVaiId, ngayVaiVe, hanGiao, soLuong, tgChuyenReady }) {
  const existing = await client.query('SELECT id FROM dot_vai_ve WHERE ma_dot_vai = $1', [maDotVai]);
  if (existing.rows.length) {
    await client.query(
      `UPDATE dot_vai_ve SET loai_dot_vai_id = COALESCE($2, loai_dot_vai_id),
         ngay_vai_ve = $3, han_giao_hang = $4, updated_date = CURRENT_TIMESTAMP
       WHERE ma_dot_vai = $1`,
      [maDotVai, loaiDotVaiId || null, ngayVaiVe || null, hanGiao || null]
    );
    return { id: existing.rows[0].id, inserted: false };
  }
  let sl = soLuong == null ? null : Number(soLuong);
  if (sl != null) {
    const prev = await client.query(
      'SELECT COALESCE(sum(so_luong_vai_ve),0)::int AS s FROM dot_vai_ve WHERE phan_in_id = $1', [phanInId]);
    sl -= (prev.rows[0].s || 0);
    if (sl < 0) sl = 0;
  }
  const { rows } = await client.query(
    `INSERT INTO dot_vai_ve (phan_in_id, loai_dot_vai_id, ma_dot_vai, ngay_vai_ve, han_giao_hang, so_luong_vai_ve, trang_thai, tg_chuyen_ready)
     VALUES ($1,$2,$3,$4,$5,$6,'NHAN_VAI',$7) RETURNING id`,
    [phanInId, loaiDotVaiId || null, maDotVai, ngayVaiVe || null, hanGiao || null, sl, tgChuyenReady || null]
  );
  return { id: rows[0].id, inserted: true };
}

// Tra id phần in theo ma_phan (để API chính thức biết code phần đã có từ -new chưa).
async function findPhanInIdByMaPhan(maPhan) {
  const { rows } = await query('SELECT id FROM phan_in WHERE ma_phan = $1 LIMIT 1', [maPhan]);
  return rows[0] ? rows[0].id : null;
}

// Chuyển phần in đã có (từ -new) sang READY: cập nhật barcode/tinh_chat_in + set mốc cho các đợt CHỜ chuyển.
// Trả về id các đợt vừa được chuyển (để theo dõi dòng chảy). Đợt đã ở READY (mốc ≠ null) không đụng.
async function promotePhanInToReady(pinId, { barcode, tinhChatIn }) {
  await query(
    `UPDATE phan_in SET tinh_chat_in = COALESCE($2, tinh_chat_in),
       barcode = COALESCE($3, barcode), updated_date = CURRENT_TIMESTAMP WHERE id = $1`,
    [pinId, tinhChatIn || null, barcode || null]
  );
  const { rows } = await query(
    `UPDATE dot_vai_ve SET tg_chuyen_ready = now(), updated_date = CURRENT_TIMESTAMP
      WHERE phan_in_id = $1 AND tg_chuyen_ready IS NULL AND trang_thai NOT IN ('DA_GOP','DA_HUY')
      RETURNING id`,
    [pinId]
  );
  return rows.map((r) => r.id);
}

module.exports = {
  createSyncLog, finishSyncLog, listSyncHistory, insertRawBatch, saveSyncRaw, getSyncRaw,
  upsertKhachHang, upsertDonHang, upsertMaHang, upsertPhanIn, setPhanInDryMin, getLoaiDotVaiId, upsertDotVai,
  findPhanInIdByMaPhan, promotePhanInToReady,
};
