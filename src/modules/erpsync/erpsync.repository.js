'use strict';

const { query, withTransaction } = require('../../config/db');
// Số cuối `barcode_hskt` = phương án in (mig 064) — dùng chung với trang Hồ sơ kỹ thuật.
const { applyPainToBarcode } = require('../../utils/hskt');

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

// Cột `dot_vai_ve.nha_gia_cong` (mig 072) có chưa — cache khi ĐÃ có ⇒ chạy migration xong nhận ngay,
// khỏi restart BE. Cùng khuôn với `hasBarcodeCol`: KHÔNG try/catch trong transaction.
let _hasNgcCol = null;
async function hasNgcCol(client) {
  if (_hasNgcCol) return true;
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name='dot_vai_ve' AND column_name='nha_gia_cong' LIMIT 1`);
  _hasNgcCol = rows.length > 0;
  return _hasNgcCol;
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

// Trả về { id, inserted }. `soLuong` = ERP `received_qty` (≡ `SLnhanvai`, 2 trường luôn bằng nhau).
// ⚠⚠⚠ QUY TẮC SL ĐỢT VẢI — **LẤY NGUYÊN SỐ ERP GỬI, KHÔNG LŨY KẾ, KHÔNG TRỪ GÌ HẾT**
// (người dùng chốt 07/08/2026): `received_qty` là SL nhận của CHÍNH đợt đó.
// **ĐỪNG khôi phục luật delta** — lịch sử đã 3 lần đi sai đường ở chỗ này:
//   (1) bản gốc luôn trừ Σ đợt trước rồi clamp ≥ 0 ⇒ mọi đợt sau đợt 1 ra **0** ("từ đợt 2 toàn 0");
//   (2) mig 070 phải mở ngoại lệ cho loại `6I` (MẪU SỐ LƯỢNG) vì đợt mẫu SL nhỏ bị clamp 0;
//   (3) bản 07/08 đoán "received_qty < Σ ⇒ số riêng, ngược lại lũy kế" — vẫn sai với ca gửi số riêng
//       mà LỚN HƠN Σ đã nhận (vd 198 → 204: thực tế nhận 204, luật đoán ra 6).
// Nay bỏ HẲN mọi suy đoán ⇒ cờ `nguyenSoLuong`/`LOAIKD_NGUYEN_SL` không còn cần (mọi loại đều nguyên số).
// Đợt đã tồn tại (re-sync idempotent theo ma_dot_vai) → GIỮ NGUYÊN `so_luong_vai_ve`, chỉ cập nhật
//  ngày/hạn/loại/barcode/inset/NGC (ERP trả lại cùng dòng mỗi 5 phút; ghi đè SL sẽ xóa mất số đã sửa tay).
// `tgChuyenReady`: Date = đợt vào READY ngay (mig 056); null = CHỜ chuyển (pending). Re-sync GIỮ NGUYÊN mốc cũ.
async function upsertDotVai(client, { maDotVai, phanInId, loaiDotVaiId, ngayVaiVe, hanGiao, soLuong, tgChuyenReady, barcode, inset, nhaGiaCong }) {
  // Cột `nha_gia_cong` (mig 072) — dò TRƯỚC khi dựng câu SQL. ⚠ KHÔNG try/catch quanh INSERT:
  // hàm chạy trong transaction, lỗi 42703 làm ABORT cả transaction (cùng bẫy đã ghi ở `createTem`).
  const coNGC = await hasNgcCol(client);
  const existing = await client.query('SELECT id FROM dot_vai_ve WHERE ma_dot_vai = $1', [maDotVai]);
  if (existing.rows.length) {
    await client.query(
      `UPDATE dot_vai_ve SET loai_dot_vai_id = COALESCE($2, loai_dot_vai_id),
         ngay_vai_ve = $3, han_giao_hang = $4, barcode = COALESCE($5, barcode),
         inset = COALESCE($6, inset)${coNGC ? ', nha_gia_cong = COALESCE($7, nha_gia_cong)' : ''},
         updated_date = CURRENT_TIMESTAMP
       WHERE ma_dot_vai = $1`,
      [maDotVai, loaiDotVaiId || null, ngayVaiVe || null, hanGiao || null, barcode || null, inset ?? null,
        ...(coNGC ? [nhaGiaCong || null] : [])]
    );
    return { id: existing.rows[0].id, inserted: false };
  }
  // LẤY NGUYÊN số ERP gửi (xem ghi chú ở đầu hàm). Chỉ chặn số âm do dữ liệu ERP lỗi.
  let sl = soLuong == null ? null : Number(soLuong);
  if (sl != null && sl < 0) sl = 0;
  const { rows } = await client.query(
    `INSERT INTO dot_vai_ve (phan_in_id, loai_dot_vai_id, ma_dot_vai, ngay_vai_ve, han_giao_hang, so_luong_vai_ve, trang_thai, tg_chuyen_ready, barcode, inset${coNGC ? ', nha_gia_cong' : ''})
     VALUES ($1,$2,$3,$4,$5,$6,'NHAN_VAI',$7,$8,$9${coNGC ? ',$10' : ''}) RETURNING id`,
    [phanInId, loaiDotVaiId || null, maDotVai, ngayVaiVe || null, hanGiao || null, sl, tgChuyenReady || null, barcode || null, inset ?? null,
      ...(coNGC ? [nhaGiaCong || null] : [])]
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
    `UPDATE phan_in SET tinh_chat_in = COALESCE($2, tinh_chat_in), updated_date = CURRENT_TIMESTAMP WHERE id = $1`,
    [pinId, tinhChatIn || null]
  );
  // barcode (IDDotReady) thuộc ĐỢT VẢI: gán cho các đợt đang CHỜ chuyển của phần in nếu chưa có + chuyển vào READY.
  const { rows } = await query(
    `UPDATE dot_vai_ve SET tg_chuyen_ready = now(), barcode = COALESCE(barcode, $2), updated_date = CURRENT_TIMESTAMP
      WHERE phan_in_id = $1 AND tg_chuyen_ready IS NULL AND trang_thai NOT IN ('DA_GOP','DA_HUY')
      RETURNING id`,
    [pinId, barcode || null]
  );
  return rows.map((r) => r.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// HSKT + KTCankiemtra (thay trigger mig 054, mig 059/060). Tất cả BEST-EFFORT gọi
// ngoài transaction chính của processRow — lỗi phụ không chặn đồng bộ đợt vải.
// ─────────────────────────────────────────────────────────────────────────────

// id các checkpoint trạm READY (KHUON/FILM/MUC/QC_XAC_NHAN) của workflow hiện hành.
async function readyCheckpointIds() {
  const { rows } = await query(
    `SELECT cp.ma_checkpoint, cp.id FROM workflow_version wv JOIN tram t ON t.workflow_version_id=wv.id AND t.ma_tram='READY' JOIN checkpoint cp ON cp.tram_id=t.id AND cp.dang_hoat_dong=true WHERE wv.la_hien_hanh=true AND cp.ma_checkpoint = ANY($1)`,
    [['KHUON', 'FILM', 'MUC', 'QC_XAC_NHAN']]
  );
  const m = {};
  rows.forEach((r) => { m[r.ma_checkpoint] = r.id; });
  return m;
}

// KTCankiemtra=0 → GIẢ LẬP kỹ thuật đã xác nhận: đặt DAT cho KHUON/FILM/MUC + QC_XAC_NHAN
// → phần in tech_done + qc_done → vào thẳng Release 1 (không cần thao tác READY).
async function simulateReadyDone(pinId) {
  const cp = await readyCheckpointIds();
  const ids = ['KHUON', 'FILM', 'MUC', 'QC_XAC_NHAN'].map((m) => cp[m]).filter(Boolean);
  if (!ids.length) return;
  await withTransaction(async (client) => {
    for (const id of ids) {
      await client.query(
        `WITH upd AS (UPDATE ket_qua_checkpoint SET trang_thai='DAT', tg_xac_nhan=now(), updated_date=now() WHERE phan_in_id=$1 AND checkpoint_id=$2 RETURNING id) INSERT INTO ket_qua_checkpoint (checkpoint_id, phan_in_id, trang_thai, tg_xac_nhan) SELECT $2,$1,'DAT',now() WHERE NOT EXISTS (SELECT 1 FROM upd)`,
        [pinId, id]
      );
    }
  });
}

// Phần in đã từng release (có lệnh ≠ HUY)?
// `boQuaDotVaiIds` = đợt vải VỪA nhận ở lần sync này — loại ra để không tự coi "đã release" bằng chính
// lệnh của mình (luật KTCankiemtra=1 hỏi: các ĐỢT TRƯỚC đã release chưa?).
async function isPhanInReleased(pinId, boQuaDotVaiIds = []) {
  const ids = (boQuaDotVaiIds || []).filter(Boolean);
  const { rows } = await query(
    `SELECT EXISTS(SELECT 1 FROM lenh_sx_dot_vai lsd JOIN lenh_san_xuat ls ON ls.id=lsd.lenh_san_xuat_id JOIN dot_vai_ve dv ON dv.id=lsd.dot_vai_ve_id WHERE dv.phan_in_id=$1 AND ls.trang_thai<>'HUY' AND ($2::uuid[] IS NULL OR NOT (dv.id = ANY($2::uuid[])))) AS e`,
    [pinId, ids.length ? ids : null]
  );
  return !!rows[0].e;
}

// KTCankiemtra=1 cho phần in ĐÃ release (đợt mới) → MỞ LẠI READY (port SQL trigger mig 054):
// hủy xác nhận READY (Khuôn/Film/Mực/QC) + gắn cờ can_lam_lai_ready cho đợt chưa release.
async function reopenReadyForPhanIn(pinId) {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE ket_qua_checkpoint SET trang_thai='HUY', nguoi_xac_nhan_id=NULL, tg_xac_nhan=NULL, updated_date=now() WHERE phan_in_id=$1 AND trang_thai='DAT' AND checkpoint_id IN (SELECT cp.id FROM checkpoint cp JOIN tram t ON t.id=cp.tram_id JOIN workflow_version wv ON wv.id=t.workflow_version_id AND wv.la_hien_hanh WHERE t.ma_tram='READY')`,
      [pinId]
    );
    await client.query(
      `UPDATE dot_vai_ve dv SET can_lam_lai_ready=true, updated_date=now() WHERE dv.phan_in_id=$1 AND dv.trang_thai NOT IN ('DA_GOP','DA_HUY') AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai l JOIN lenh_san_xuat ls ON ls.id=l.lenh_san_xuat_id WHERE l.dot_vai_ve_id=dv.id AND ls.trang_thai<>'HUY')`,
      [pinId]
    );
  });
}

// Lưu vết KTCankiemtra vào đợt vải (boolean: 1=cần KT → true).
async function setDotVaiKtCanKiemTra(dotVaiIds, val) {
  if (!dotVaiIds || !dotVaiIds.length || val == null) return;
  await query('UPDATE dot_vai_ve SET kt_can_kiem_tra=$2, updated_date=now() WHERE id = ANY($1::uuid[])',
    [dotVaiIds, Number(val) === 1]);
}

// Upsert HSKT cho 1 phần in theo barcode_hskt (mô hình nhiều–nhiều + phiên bản, mig 059).
// - Chưa có HSKT active theo barcode → tạo mới (phiên bản 1) + ghi lịch sử TAO.
// - Đã có, Pain khác → tạo PHIÊN BẢN MỚI (deactivate bản cũ + relink phần in) + lịch sử.
// - Link phần in vào HSKT active (junction hskt_phan_in).
// ERP có dòng gửi `Pain` nhưng THIẾU `BarcodeHKT` (thực tế 29/07: 15/130 dòng) — trước đây bỏ qua hẳn
// ⇒ phần in đó KHÔNG có HSKT ⇒ mọi màn hiện "Phương án in = —". Nay vẫn tạo HSKT (barcode NULL, ma_hskt
// = code phần) để giữ phương án in; không quét được bằng mã vạch (không có) và KHÔNG gom set (cần barcode).
// Khi ERP gửi barcode thật về sau, bản không-barcode bị vô hiệu hóa để không tồn tại 2 HSKT active.
async function upsertHsktNoBarcode(client, { pinId, maPhan, pain, inset, actorId }) {
  const { rows: cur } = await client.query(
    `SELECT h.id, h.phuong_an_in, h.pa_in_sua_tay FROM hskt_phan_in hp JOIN ho_so_ky_thuat h ON h.id = hp.hskt_id
      WHERE hp.phan_in_id = $1 AND hp.dang_hoat_dong AND h.dang_hoat_dong AND h.barcode_hskt IS NULL LIMIT 1`,
    [pinId]
  );
  if (cur.length) {
    // MES THẮNG: đã sửa tay thì ERP không ghi đè phương án in (chỉ còn cập nhật inset).
    const painGhi = cur[0].pa_in_sua_tay === true ? null : (pain ?? null);
    await client.query(
      `UPDATE ho_so_ky_thuat SET phuong_an_in = COALESCE($2, phuong_an_in), inset = COALESCE($3, inset),
         updated_date = now() WHERE id = $1`,
      [cur[0].id, painGhi, inset ?? null]
    );
    return cur[0].id;
  }
  const ins = await client.query(
    `INSERT INTO ho_so_ky_thuat (barcode_hskt, ma_hskt, phuong_an_in, inset, phien_ban, dang_hoat_dong, created_by)
     VALUES (NULL,$1,$2,$3,1,true,$4) RETURNING id`,
    [maPhan || null, pain ?? null, inset ?? null, actorId]
  );
  const id = ins.rows[0].id;
  await client.query(
    `INSERT INTO hskt_phan_in (hskt_id, phan_in_id, created_by) VALUES ($1,$2,$3)
     ON CONFLICT (hskt_id, phan_in_id) DO UPDATE SET dang_hoat_dong=true`,
    [id, pinId, actorId]
  );
  await client.query(
    `INSERT INTO lich_su_hskt (hskt_id, phan_in_id, hanh_dong, chi_tiet, phien_ban, nguoi_id) VALUES ($1,$2,'TAO',$3,1,$4)`,
    [id, pinId, 'Tạo HSKT từ ERP (ERP thiếu BarcodeHKT — chỉ lưu phương án in)', actorId]
  );
  return id;
}

// ─── LUẬT SẢN LƯỢNG → PHƯƠNG ÁN IN (chốt 2026-08-03) ─────────────────────────
// Tổng SL VẢI VỀ của CẢ HSKT (mọi đợt vải của mọi phần in trong HSKT — đúng nghĩa "set" khi gom set):
//   ≥ 2000 → in MÁY (Pain 2) · < 2000 → in BÀN (Pain 1).
// ⚠ Luật này ĐÈ `Pain` mà ERP gửi (ERP chỉ còn là giá trị khởi tạo), nhưng VẪN TÔN TRỌNG
// `pa_in_sua_tay` — kỹ thuật đã sửa tay ở trang Hồ sơ kỹ thuật thì không ai ghi đè.
// KHÔNG đụng `barcode_hskt`: barcode do ERP cấp, MES chỉ đổi số cuối khi NGƯỜI DÙNG sửa tay (mig 064).
const NGUONG_VAI_IN_MAY = 2000;
const PAIN_MAY = 2;
const PAIN_BAN = 1;

// Tạo PHIÊN BẢN MỚI khi đổi phương án in (dùng chung cho nhánh ERP `Pain` và luật sản lượng).
// Đổi phương án in → tạo PHIÊN BẢN MỚI. **ĐỔI LUÔN SỐ CUỐI `barcode_hskt`** theo phương án in
// (quy tắc mig 064: 11 số đầu = định danh, số cuối = 1 Bàn / 2 Máy / 3 Robot) — giống hệt khi sửa tay ở
// trang Hồ sơ kỹ thuật, để mã vạch luôn khớp phương án in đang hiệu lực. `barcode_hskt_goc` GIỮ NGUYÊN
// (mã ERP cấp) và mọi đường tra cứu so **11 SỐ ĐẦU** nên đổi đuôi KHÔNG làm mất dấu hồ sơ.
// Barcode sai định dạng (không phải 12 số) → giữ nguyên, không bịa mã.
async function taoPhienBanPain(client, { hsktId, phienBan, curPain, pain, pinId, chiTiet, actorId }) {
  const { rows: old } = await client.query(
    'SELECT barcode_hskt, ma_hskt FROM ho_so_ky_thuat WHERE id=$1', [hsktId]);
  const bcCu = old.length ? old[0].barcode_hskt : null;
  const bcMoi = applyPainToBarcode(bcCu, pain) || bcCu;
  // `ma_hskt` được set = barcode lúc tạo ⇒ chỉ đổi theo khi nó đang ĐÚNG BẰNG barcode cũ.
  const maMoi = old.length && old[0].ma_hskt && old[0].ma_hskt === bcCu ? bcMoi : (old.length ? old[0].ma_hskt : null);
  await client.query('UPDATE ho_so_ky_thuat SET dang_hoat_dong=false, updated_date=now() WHERE id=$1', [hsktId]);
  const ins = await client.query(
    `INSERT INTO ho_so_ky_thuat (barcode_hskt, barcode_hskt_goc, pa_in_sua_tay, ma_hskt, phuong_an_in, inset, phien_ban, ma_don_ready, so_luong_vai_pass, so_lan_in, so_pass_bo, thong_so_json, ghi_chu, dang_hoat_dong, created_by) SELECT $5, COALESCE(barcode_hskt_goc, barcode_hskt), false, $6, $2, inset, $3, ma_don_ready, so_luong_vai_pass, so_lan_in, so_pass_bo, thong_so_json, ghi_chu, true, $4 FROM ho_so_ky_thuat WHERE id=$1 RETURNING id`,
    [hsktId, pain, phienBan + 1, actorId, bcMoi, maMoi]
  );
  const newId = ins.rows[0].id;
  await client.query(
    `INSERT INTO hskt_phan_in (hskt_id, phan_in_id, created_by) SELECT $2, phan_in_id, $3 FROM hskt_phan_in WHERE hskt_id=$1 AND dang_hoat_dong ON CONFLICT (hskt_id, phan_in_id) DO NOTHING`,
    [hsktId, newId, actorId]
  );
  await client.query('UPDATE hskt_phan_in SET dang_hoat_dong=false WHERE hskt_id=$1', [hsktId]);
  await client.query(
    `INSERT INTO lich_su_hskt (hskt_id, phan_in_id, hanh_dong, chi_tiet, phien_ban, nguoi_id) VALUES ($1,$2,'DOI_PHUONG_AN_IN',$3,$4,$5)`,
    [newId, pinId || null,
     (chiTiet || `Đổi phương án in ${curPain ?? '—'}→${pain}`)
       + (bcMoi && bcCu && bcMoi !== bcCu ? ` · mã vạch ${bcCu} → ${bcMoi}` : ''),
     phienBan + 1, actorId]
  );
  return newId;
}

// Áp luật sản lượng cho 1 HSKT. Gọi SAU KHI đã upsert xong đợt vải của cả lần sync (post-pass) để
// tổng SL là số CUỐI CÙNG — nếu gọi giữa vòng lặp thì tổng còn thiếu, sinh phiên bản rác.
// Trả `{ doi: bool, tong, pain }` (best-effort, lỗi thì ném để caller log).
async function applyPainTheoSanLuong(hsktId, actorId = null) {
  return withTransaction(async (client) => {
    const { rows: cur } = await client.query(
      `SELECT id, phuong_an_in, phien_ban, pa_in_sua_tay FROM ho_so_ky_thuat
        WHERE id = $1 AND dang_hoat_dong = true`, [hsktId]);
    if (!cur.length) return { doi: false, tong: null, pain: null };
    const h = cur[0];
    const { rows: [sl] } = await client.query(
      `SELECT COALESCE(SUM(dv.so_luong_vai_ve),0)::int AS tong
         FROM hskt_phan_in hp
         JOIN phan_in pin ON pin.id = hp.phan_in_id AND pin.dang_hoat_dong
         JOIN dot_vai_ve dv ON dv.phan_in_id = pin.id AND dv.trang_thai NOT IN ('DA_GOP','DA_HUY')
        WHERE hp.hskt_id = $1 AND hp.dang_hoat_dong`.replace(/\s+/g, ' '), [hsktId]);
    const tong = Number(sl.tong) || 0;
    const pain = tong >= NGUONG_VAI_IN_MAY ? PAIN_MAY : PAIN_BAN;
    if (h.pa_in_sua_tay === true) return { doi: false, tong, pain, bo_qua: 'sua_tay' };
    if (Number(h.phuong_an_in) === pain) return { doi: false, tong, pain };
    const { rows: [pin0] } = await client.query(
      'SELECT phan_in_id FROM hskt_phan_in WHERE hskt_id=$1 AND dang_hoat_dong LIMIT 1', [hsktId]);
    const newId = await taoPhienBanPain(client, {
      hsktId, phienBan: h.phien_ban || 1, curPain: h.phuong_an_in, pain,
      pinId: pin0 ? pin0.phan_in_id : null, actorId,
      chiTiet: `Đổi phương án in ${h.phuong_an_in ?? '—'}→${pain} (tự động theo sản lượng: `
        + `${tong} m vải ${tong >= NGUONG_VAI_IN_MAY ? '≥' : '<'} ${NGUONG_VAI_IN_MAY} ⇒ `
        + `${pain === PAIN_MAY ? 'in Máy' : 'in Bàn'})`,
    });
    return { doi: true, tong, pain, hskt_id: newId };
  });
}

async function upsertHsktForPin({ pinId, barcodeHskt, pain, inset, maDonReady, maPhan, actorId = null }) {
  if (!barcodeHskt) {
    if (pain == null) return null; // không có gì để lưu
    return withTransaction((client) => upsertHsktNoBarcode(client, { pinId, maPhan, pain, inset, actorId }));
  }
  return withTransaction(async (client) => {
    // ⚠⚠ TRA BỎ SỐ CUỐI — SO **11 SỐ ĐẦU** (chốt 2026-08-04): số cuối barcode = phương án in, mà MES
    // đổi phương án in (sửa tay hoặc luật sản lượng) là đổi luôn số cuối, còn ERP **giữ nguyên** mã cũ.
    // So đủ 12 số thì không tìm thấy ⇒ TẠO HSKT TRÙNG LẶP (2 bản active/phần in). So 11 số đầu là cách
    // chắc nhất, không phụ thuộc `barcode_hskt_goc` có được set hay không.
    // An toàn vì 11 số đầu DUY NHẤT (đối chiếu prod: 252/252 HSKT active, 0 va chạm — xem DATABASE.md §3).
    // Vẫn giữ 2 vế khớp chính xác cho barcode KHÔNG đúng dạng 12 số.
    const { rows: act } = await client.query(
      `SELECT id, phuong_an_in, phien_ban, pa_in_sua_tay FROM ho_so_ky_thuat
        WHERE dang_hoat_dong=true
          AND (barcode_hskt=$1 OR barcode_hskt_goc=$1
               OR (barcode_hskt ~ '^[0-9]{12}$' AND $1 ~ '^[0-9]{12}$'
                   AND left(barcode_hskt,11) = left($1,11)))
        ORDER BY phien_ban DESC LIMIT 1`.replace(/\s+/g, ' '),
      [barcodeHskt]
    );
    let hsktId; let phienBan; let curPain;
    if (!act.length) {
      const ins = await client.query(
        `INSERT INTO ho_so_ky_thuat (barcode_hskt, barcode_hskt_goc, ma_hskt, phuong_an_in, inset, phien_ban, ma_don_ready, dang_hoat_dong, created_by) VALUES ($1,$1,$1,$2,$3,1,$4,true,$5) RETURNING id`,
        [barcodeHskt, pain ?? null, inset ?? null, maDonReady || null, actorId]
      );
      hsktId = ins.rows[0].id;
      await client.query(
        `INSERT INTO lich_su_hskt (hskt_id, phan_in_id, hanh_dong, chi_tiet, phien_ban, nguoi_id) VALUES ($1,$2,'TAO',$3,1,$4)`,
        [hsktId, pinId, `Tạo HSKT từ ERP (barcode ${barcodeHskt})`, actorId]
      );
    } else {
      hsktId = act[0].id; phienBan = act[0].phien_ban || 1; curPain = act[0].phuong_an_in;
      // MES THẮNG: đã sửa tay ở trang Hồ sơ kỹ thuật thì ERP KHÔNG ghi đè phương án in nữa
      // (cũng không đụng barcode). Vẫn cập nhật inset/ma_don_ready ở dưới.
      // CỐ Ý không ghi `lich_su_hskt` cho lần bỏ qua: job ERP chạy 5 PHÚT/LẦN sẽ spam lịch sử —
      // thay bằng badge "Đã sửa tay" ở trang Hồ sơ kỹ thuật.
      // ⚠⚠ KHÔNG ghi đè `phuong_an_in` bằng Pain của ERP cho HSKT ĐÃ TỒN TẠI — `Pain` chỉ là giá trị
      // KHỞI TẠO (nhánh tạo mới ở trên). Từ 2026-08-03 phương án in do **LUẬT SẢN LƯỢNG** quyết định
      // (`applyPainTheoSanLuong`, ≥2000 → Máy), nên nếu ở đây vẫn kéo về Pain của ERP thì 2 bên đá nhau:
      //   sync N   : ERP ghi Pain=2 → phiên bản mới
      //   post-pass: sản lượng 100 m < 2000 → đổi về 1 → phiên bản mới
      //   sync N+1 : ERP lại ghi Pain=2 …  ⇒ **+2 phiên bản mỗi 5 PHÚT, vô hạn**.
      // Đã xảy ra thật (04/08/2026): 1 HSKT lên `phien_ban=134`, 1101/1434 bản ghi là phiên bản rác,
      // 525 dòng lịch sử "(ERP)" ↔ 555 dòng "theo sản lượng". Giữ nguyên bản active, chỉ cập nhật
      // inset/ma_don_ready ở dưới. (`pa_in_sua_tay` vẫn giữ ý nghĩa: chặn cả luật sản lượng.)
      // Số nhóm gom set + đợt ready THEO LẦN ĐỒNG BỘ MỚI NHẤT (phần in có thể sang đợt ready khác
      // với số nhóm khác) — giữ bản active khớp ERP để trang Hồ sơ kỹ thuật hiển thị đúng.
      await client.query(
        `UPDATE ho_so_ky_thuat SET inset = COALESCE($2, inset), ma_don_ready = COALESCE($3, ma_don_ready),
           updated_date = now() WHERE id = $1`,
        [hsktId, inset ?? null, maDonReady || null]
      );
    }
    await client.query(
      `INSERT INTO hskt_phan_in (hskt_id, phan_in_id, created_by) VALUES ($1,$2,$3) ON CONFLICT (hskt_id, phan_in_id) DO UPDATE SET dang_hoat_dong=true`,
      [hsktId, pinId, actorId]
    );
    // Đã có HSKT thật (có barcode) → vô hiệu hóa bản tạm không-barcode của phần in này (nếu có),
    // để `activeHsktOfPhanIn`/candidate không bắt nhầm bản tạm.
    await client.query(
      `UPDATE ho_so_ky_thuat SET dang_hoat_dong=false, updated_date=now()
        WHERE barcode_hskt IS NULL AND dang_hoat_dong
          AND id IN (SELECT hskt_id FROM hskt_phan_in WHERE phan_in_id = $1)`,
      [pinId]
    );
    return hsktId;
  });
}

// Đợt vải đủ điều kiện auto gom set từ ERP: chưa release, còn READY, chưa thuộc set mở.
// Lọc theo CHÍNH các đợt vải của nhóm Inset (không lấy theo phần in — phần in có thể còn đợt
// vải của đợt ready khác, không thuộc nhóm gom set này).
async function eligibleDotVaiByIds(dotVaiIds) {
  const { rows } = await query(
    `SELECT dv.id, dv.phan_in_id FROM dot_vai_ve dv WHERE dv.id = ANY($1::uuid[]) AND dv.trang_thai NOT IN ('DA_GOP','DA_HUY') AND dv.tg_chuyen_ready IS NOT NULL AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai lsd JOIN lenh_san_xuat ls ON ls.id=lsd.lenh_san_xuat_id WHERE lsd.dot_vai_ve_id=dv.id AND ls.trang_thai<>'HUY') AND NOT EXISTS (SELECT 1 FROM gom_set_dot_vai gsd JOIN gom_set gs ON gs.id=gsd.gom_set_id WHERE gsd.dot_vai_ve_id=dv.id AND gs.trang_thai='MO')`,
    [dotVaiIds]
  );
  return rows;
}

// Set gom ERP đã tạo cho barcode HSKT này chưa (idempotent) — nhận diện qua ghi_chu.
async function openSetByGhiChu(ghiChu) {
  const { rows } = await query(`SELECT id FROM gom_set WHERE ghi_chu=$1 AND trang_thai='MO' LIMIT 1`, [ghiChu]);
  return rows[0] ? rows[0].id : null;
}

module.exports = {
  createSyncLog, finishSyncLog, listSyncHistory, insertRawBatch, saveSyncRaw, getSyncRaw,
  upsertKhachHang, upsertDonHang, upsertMaHang, upsertPhanIn, setPhanInDryMin, getLoaiDotVaiId, upsertDotVai,
  findPhanInIdByMaPhan, promotePhanInToReady,
  readyCheckpointIds, simulateReadyDone, isPhanInReleased, reopenReadyForPhanIn, setDotVaiKtCanKiemTra,
  upsertHsktForPin, eligibleDotVaiByIds, openSetByGhiChu,
  applyPainTheoSanLuong, NGUONG_VAI_IN_MAY,
};
