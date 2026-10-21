const { query } = require('../../config/db');
const { mauTim } = require('../../utils/timKiem');
const { dotStageCase, STAGE_LABEL } = require('../../utils/stage');
const { chuanHoaDsMa } = require('../../utils/maPhanIn');

// ─────────────────────────────────────────────────────────────────────────────
// QUẢN TRỊ PHẦN IN — tra cứu 1 phần in rồi xem/sửa MỌI thứ của nó.
//
// ⚠⚠ GIAI ĐOẠN KHÔNG PHẢI MỘT CỘT — nó được SUY từ trạng thái runtime (lệnh/phiếu/tem/
//   `ket_qua_checkpoint`), xem CLAUDE.md §7 + DATABASE.md §11.5. Vì vậy trang này KHÔNG "ghi trạm"
//   mà DỰNG LẠI đúng trạng thái runtime tương ứng (hủy lệnh / hạ duyệt / hủy xác nhận READY…),
//   bằng cách gọi lại CHÍNH các service đang chạy ngoài giao diện. Đừng thêm cột `giai_doan`.
//
// ⚠ Đọc giai đoạn ở đây dùng CHUNG `utils/stage.js` với dashboard + màn Đơn hàng ⇒ không đẻ ra
//   con số thứ ba đá nhau.
// ─────────────────────────────────────────────────────────────────────────────

// Tra cứu nhanh: code phần · mã vạch phần in (TDTHĐH) · mã/barcode đợt vải · mã hàng · khách.
async function traCuu(search, limit = 30) {
  const sql = `
    SELECT pin.id, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.dang_hoat_dong,
           kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang,
           (SELECT count(*) FROM dot_vai_ve dv WHERE dv.phan_in_id = pin.id) AS so_dot_vai
    FROM phan_in pin
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    WHERE ($1 = '' OR pin.ma_phan ~* $1 OR pin.barcode ~* $1 OR mh.ma_hang ~* $1
           OR kh.ten_khach_hang ~* $1 OR dh.ma_don_hang ~* $1
           OR EXISTS (SELECT 1 FROM dot_vai_ve dv WHERE dv.phan_in_id = pin.id
                        AND (dv.ma_dot_vai ~* $1 OR dv.barcode ~* $1)))
    ORDER BY pin.dang_hoat_dong DESC, pin.ma_phan
    LIMIT $2`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [mauTim(search), limit]);
  return rows;
}

// Thông tin gốc của phần in + hồ sơ kỹ thuật đang hoạt động.
async function getPhanIn(phanInId) {
  const sql = `
    SELECT pin.*, mh.ma_hang, mh.ten_ma_hang, dh.ma_don_hang, dh.so_po, kh.ten_khach_hang,
           hs.id AS hskt_id, hs.barcode_hskt, hs.barcode_hskt_goc, hs.phuong_an_in, hs.pa_in_sua_tay
    FROM phan_in pin
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    LEFT JOIN LATERAL (
      SELECT h.id, h.barcode_hskt, h.barcode_hskt_goc, h.phuong_an_in, h.pa_in_sua_tay
        FROM hskt_phan_in hp JOIN ho_so_ky_thuat h ON h.id = hp.hskt_id
       WHERE hp.phan_in_id = pin.id AND hp.dang_hoat_dong AND h.dang_hoat_dong
       ORDER BY h.phien_ban DESC LIMIT 1) hs ON true
    WHERE pin.id = $1`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [phanInId]);
  return rows[0] || null;
}

// Các mục READY của phần in (Khuôn/Film/Mực + QC) — trạng thái + người + giờ.
// ⚠⚠ PHẢI lọc `cp.dang_hoat_dong` (fix khi kiểm thực): trạm READY còn 3 checkpoint ĐÃ VÔ HIỆU HÓA
//   trong DB — `HSKT` + `XAC_NHAN_KT` (gỡ ở mig 014–016/040) và `TEST_UP` — nên không lọc thì màn
//   hiện **7 mục** thay vì 4, người dùng tưởng phần in còn thiếu 3 mục chưa xác nhận.
//   Dùng cờ `dang_hoat_dong` chứ KHÔNG liệt kê mã cứng: workflow là cấu hình động, thêm/bớt checklist
//   ở màn Hệ thống thì trang này tự theo.
async function getReady(phanInId) {
  const sql = `
    SELECT cp.ma_checkpoint, cp.ten_checkpoint, k.trang_thai, k.gia_tri_text, k.tg_xac_nhan,
           nd.ho_ten AS nguoi
    FROM checkpoint cp
    JOIN tram t ON t.id = cp.tram_id
    JOIN workflow_version wv ON wv.id = t.workflow_version_id AND wv.la_hien_hanh
    LEFT JOIN ket_qua_checkpoint k ON k.checkpoint_id = cp.id AND k.phan_in_id = $1
    LEFT JOIN nguoi_dung nd ON nd.id = k.nguoi_xac_nhan_id
    WHERE t.ma_tram = 'READY' AND cp.dang_hoat_dong
    ORDER BY cp.thu_tu`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [phanInId]);
  return rows;
}

// Mọi đợt vải của phần in + GIAI ĐOẠN hiện tại + lệnh/phiếu/tem đang gắn.
// ⚠ Dùng CHUNG `dotStageCase` với dashboard/màn Đơn hàng để không đẻ ra con số thứ ba đá nhau.
// ⚠⚠ CỐ Ý KHÔNG dùng `dotSource()`: hàm đó lọc bỏ đợt `DA_GOP`/`DA_HUY` và đợt chưa vào READY —
//   đúng cho dashboard, nhưng trang QUẢN TRỊ phải thấy **mọi** đợt thì mới gỡ rối được (đợt vừa hủy
//   nhầm, đợt kẹt chưa vào READY…). Nguồn dưới đây giữ đủ 3 cột `dotStageCase` cần
//   (`phan_in_id`/`lenh_id`/`lenh_tt`) nên biểu thức giai đoạn vẫn y hệt.
const NGUON_DOT = `
  SELECT d.*, l.lenh_id, l.lenh_tt FROM dot_vai_ve d
  LEFT JOIN LATERAL (
    SELECT ls.id AS lenh_id, ls.trang_thai AS lenh_tt
      FROM lenh_sx_dot_vai lsd JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id
     WHERE lsd.dot_vai_ve_id = d.id AND ls.trang_thai <> 'HUY'
     ORDER BY ls.created_date DESC LIMIT 1) l ON true`;

async function getDotVaiList(phanInId) {
  const sql = `
    SELECT d.*, ${dotStageCase('d')} AS giai_doan,
           ldv.ten_loai AS loai_dot_vai, ldv.ma_loai AS ma_loai_dot_vai,
           ls.id AS lenh_id, ls.ma_lenh_san_xuat, ls.trang_thai AS lenh_trang_thai,
           ls.ngay_ke_hoach, ls.tg_bd_kh, ls.tg_kt_kh,
           cs.ten_chuyen, lc.ma_loai AS ma_loai_chuyen,
           lsd.so_luong AS sl_release_dot,
           (SELECT count(*) FROM phieu_san_xuat ps WHERE ps.lenh_san_xuat_id = ls.id AND ps.trang_thai <> 'HUY') AS so_phieu,
           (SELECT count(*) FROM phieu_san_xuat ps JOIN tem t ON t.phieu_san_xuat_id = ps.id
             WHERE ps.lenh_san_xuat_id = ls.id AND t.trang_thai <> 'HUY') AS so_tem,
           (SELECT count(*) FROM lenh_sx_dot_vai l2 WHERE l2.lenh_san_xuat_id = ls.id) AS so_dot_trong_lenh,
           (SELECT count(DISTINCT d2.phan_in_id) FROM lenh_sx_dot_vai l2
              JOIN dot_vai_ve d2 ON d2.id = l2.dot_vai_ve_id WHERE l2.lenh_san_xuat_id = ls.id) AS so_phan_in_trong_lenh,
           (SELECT gs.ma_set FROM gom_set_dot_vai gsd JOIN gom_set gs ON gs.id = gsd.gom_set_id
             WHERE gsd.dot_vai_ve_id = d.id AND gs.trang_thai = 'MO' LIMIT 1) AS ma_set,
           (SELECT tr.ma_tram FROM ton_tram tt JOIN tram tr ON tr.id = tt.tram_id
             WHERE tt.dot_vai_ve_id = d.id LIMIT 1) AS ton_tram
    FROM (${NGUON_DOT}) d
    LEFT JOIN loai_dot_vai ldv ON ldv.id = d.loai_dot_vai_id
    LEFT JOIN lenh_san_xuat ls ON ls.id = d.lenh_id
    LEFT JOIN lenh_sx_dot_vai lsd ON lsd.dot_vai_ve_id = d.id AND lsd.lenh_san_xuat_id = ls.id
    LEFT JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
    LEFT JOIN loai_chuyen lc ON lc.id = cs.loai_chuyen_id
    WHERE d.phan_in_id = $1
    ORDER BY d.created_date`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [phanInId]);
  return rows.map((r) => ({ ...r, giai_doan_ten: STAGE_LABEL[r.giai_doan] || r.giai_doan }));
}

// ─── SỬA TRƯỜNG (whitelist cứng — KHÔNG nhận tên cột từ client) ──────────────
// ⚠ Cố ý KHÔNG cho sửa: `ma_phan` (khóa nghiệp vụ, mọi nơi tra theo mã này), `ma_hang_id`,
//   `dang_hoat_dong` (đã có tab Hủy/Mở phần in), `trang_thai` đợt vải (đã có tab Hủy/Mở đợt vải)
//   — tránh biến trang này thành đường vòng lách các guard đã cân nhắc kỹ.
const COT_PHAN_IN = {
  mau_vai: 'text', kich_vai: 'text', kich_phim: 'text', tinh_chat_in: 'text',
  do_in: 'text', mau_in: 'text', ghi_chu: 'text', barcode: 'text',
  // ⚠ `ddh_sub_id` chuyển từ đợt vải sang phần in (mig 088) — ứng 1:1 với phần in, và bằng 3 số cuối
  //   của `barcode` (BarcodePTHDH). Sửa lệch nhau là ERP không đối soát được lượt in tem.
  ddh_sub_id: 'text',
  so_luong_don_hang: 'int', thoi_gian_cho_kho_phut: 'int',
  la_in_kieng: 'bool',
};
const COT_DOT_VAI = {
  ma_dot_vai: 'text', barcode: 'text', nha_gia_cong: 'text', ghi_chu: 'text',
  du_an: 'text',
  so_luong_vai_ve: 'int', so_luong_thieu: 'int', so_luong_hu: 'int', inset: 'int',
  ngay_vai_ve: 'date', han_giao_hang: 'date',
  can_lam_lai_ready: 'bool', kt_can_kiem_tra: 'bool',
  loai_dot_vai_id: 'uuid',
};

function dungCauUpdate(bang, whitelist, id, patch, actorId) {
  const set = []; const val = []; const cu = {};
  for (const [k, kieu] of Object.entries(whitelist)) {
    if (!(k in patch)) continue;
    let v = patch[k];
    if (v === '' || v === undefined) v = null;
    if (v !== null && kieu === 'int') { v = Number(v); if (!Number.isFinite(v)) continue; }
    if (v !== null && kieu === 'bool') v = !!v;
    // Mã vạch TDTHĐH sửa tay CÓ THỂ LÀ DANH SÁCH (gõ `a, b` cho dễ đọc) ⇒ chuẩn hóa về đúng dạng
    // đang lưu (bỏ khoảng trắng, khử trùng, ngăn bằng dấu phẩy) — cùng luật với đường ERP sync.
    if (v !== null && bang === 'phan_in' && k === 'barcode') v = chuanHoaDsMa(v);
    val.push(v);
    set.push(`${k} = $${val.length}${kieu === 'date' ? '::date' : kieu === 'uuid' ? '::uuid' : ''}`);
    cu[k] = true;
  }
  if (!set.length) return null;
  val.push(actorId); const pActor = val.length;
  val.push(id); const pId = val.length;
  return {
    sql: `UPDATE ${bang} SET ${set.join(', ')}, updated_by = $${pActor}, updated_date = CURRENT_TIMESTAMP WHERE id = $${pId} RETURNING *`,
    val,
    cols: Object.keys(cu),
  };
}

async function updatePhanIn(id, patch, actorId) {
  const q = dungCauUpdate('phan_in', COT_PHAN_IN, id, patch, actorId);
  if (!q) return null;
  const { rows } = await query(q.sql, q.val);
  return rows[0] ? { row: rows[0], cols: q.cols } : null;
}

async function updateDotVai(id, patch, actorId) {
  const q = dungCauUpdate('dot_vai_ve', COT_DOT_VAI, id, patch, actorId);
  if (!q) return null;
  const { rows } = await query(q.sql, q.val);
  return rows[0] ? { row: rows[0], cols: q.cols } : null;
}

async function getDotVaiRaw(id) {
  const { rows } = await query('SELECT * FROM dot_vai_ve WHERE id = $1', [id]);
  return rows[0] || null;
}

// SL đã in tem của 1 đợt vải — chặn hạ `so_luong_vai_ve` xuống dưới phần đã sản xuất.
async function slDaInCuaDotVai(dotVaiId) {
  const sql = `
    SELECT COALESCE(SUM(t.so_luong), 0)::int AS sl
      FROM lenh_sx_dot_vai lsd
      JOIN phieu_san_xuat ps ON ps.lenh_san_xuat_id = lsd.lenh_san_xuat_id AND ps.trang_thai <> 'HUY'
      JOIN tem t ON t.phieu_san_xuat_id = ps.id AND t.trang_thai <> 'HUY'
     WHERE lsd.dot_vai_ve_id = $1`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [dotVaiId]);
  return Number(rows[0]?.sl) || 0;
}

async function ghiAudit(tenBang, id, hanhDong, cu, moi, actorId) {
  await query(
    `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_cu, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, CURRENT_TIMESTAMP, $6)`,
    [tenBang, String(id), hanhDong, JSON.stringify(cu || {}), JSON.stringify(moi || {}), actorId]
  );
}

// ─── TOÀN CẢNH LỆNH / PHIẾU / TEM / XÁC NHẬN của 1 phần in (19/10/2026) ──────────────────────────────────
// Nguồn cho (1) khối "Lệnh · tem · xác nhận" của trang, (2) nút Hủy lẻ từng bản ghi (kiểm "có thuộc phần in này
// không" trước khi gọi service hủy), (3) bộ máy "Lùi về trạm" (`phaninadmin.service.dungBuocLui`).
// Mọi lệnh ≠ HUY có đợt của phần in. Lượt KCS / Sửa / OQC đã hủy xác nhận bị loại (`notCancelledQc` — CHUNG luật màn QC).
// Tem: tem sống + tem in đã hủy MỞ LẠI ĐƯỢC (luật `production.repository.MO_LAI_DUOC_SQL`).
async function toanCanh(phanInId) {
  const { notCancelledQc } = require('../quality/quality.repository');
  const { SU_KIEN_CUOI_LATERAL, MO_LAI_DUOC_SQL } = require('../production/production.repository');
  const { thoInPhieuSql } = require('../../utils/thoIn');
  const q1 = (sql, p) => query(sql.replace(/\s+/g, ' ').trim(), p).then((r) => r.rows);
  const lenh = await q1(`
    SELECT ls.id, ls.ma_lenh_san_xuat, ls.trang_thai, ls.so_luong_release, ls.ngay_ke_hoach, ls.created_date,
           cs.ma_chuyen, lc.ma_loai AS ma_loai_chuyen,
           (SELECT count(DISTINCT d2.phan_in_id) FROM lenh_sx_dot_vai l2 JOIN dot_vai_ve d2 ON d2.id = l2.dot_vai_ve_id
             WHERE l2.lenh_san_xuat_id = ls.id)::int AS so_phan_in,
           (SELECT string_agg(DISTINCT p2.ma_phan, ', ') FROM lenh_sx_dot_vai l3 JOIN dot_vai_ve d3 ON d3.id = l3.dot_vai_ve_id
              JOIN phan_in p2 ON p2.id = d3.phan_in_id WHERE l3.lenh_san_xuat_id = ls.id AND d3.phan_in_id <> $1) AS phan_in_khac,
           EXISTS (SELECT 1 FROM ket_qua_checkpoint k JOIN checkpoint c ON c.id = k.checkpoint_id
                    WHERE k.lenh_san_xuat_id = ls.id AND c.ma_checkpoint = 'TEST_QA' AND k.trang_thai = 'DAT') AS test_dat
      FROM lenh_san_xuat ls
      LEFT JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
      LEFT JOIN loai_chuyen lc ON lc.id = cs.loai_chuyen_id
     WHERE ls.trang_thai <> 'HUY'
       AND ls.id IN (SELECT lsd.lenh_san_xuat_id FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
                      WHERE dv.phan_in_id = $1)
     ORDER BY ls.created_date`, [phanInId]);
  const lenhIds = lenh.map((l) => l.id);
  if (!lenhIds.length) return { lenh: [], phieu: [], tem: [], kcs: [], sua: [], oqc: [], pll: [], giao: [], test: [] };

  const coPll = (await q1("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='phan_loai_loi'")).length > 0;
  const [phieu, tem, test] = await Promise.all([
    q1(`SELECT ps.id, ps.lenh_san_xuat_id, ps.ma_phieu_san_xuat, ps.trang_thai, ps.tg_bd, ps.tg_kt, ps.chuyen_truong,
               ps.ca_truong_id, ct.ho_ten AS ca_truong, ps.to_in_id, ti.ma_to, cs.ma_chuyen, ${thoInPhieuSql('ps.id')} AS tho_in
          FROM phieu_san_xuat ps
          LEFT JOIN nguoi_dung ct ON ct.id = ps.ca_truong_id
          LEFT JOIN to_in ti ON ti.id = ps.to_in_id
          LEFT JOIN chuyen_san_xuat cs ON cs.id = ps.chuyen_id
         WHERE ps.lenh_san_xuat_id = ANY($1::uuid[]) AND ps.trang_thai <> 'HUY'
         ORDER BY ps.created_date`, [lenhIds]),
    q1(`SELECT t.id, t.phieu_san_xuat_id, ps.lenh_san_xuat_id, t.ma_tem, t.so_luong, t.trang_thai, t.tem_goc_id, t.created_date,
               t.sl_kcs_dat, t.sl_kcs_sua, t.sl_kcs_huy, t.sl_sua_dat, t.sl_sua_huy, t.sl_oqc_dat, t.sl_da_giao,
               (to_jsonb(t)->>'da_tich_giao')::boolean AS da_tich_giao, (to_jsonb(t)->>'ma_lo') AS ma_lo,
               COALESCE(${MO_LAI_DUOC_SQL}, false) AS mo_lai_duoc
          FROM tem t
          JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
          JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
          ${SU_KIEN_CUOI_LATERAL}
         WHERE ps.lenh_san_xuat_id = ANY($1::uuid[]) AND (t.trang_thai <> 'HUY' OR COALESCE(${MO_LAI_DUOC_SQL}, false))
         ORDER BY t.created_date`, [lenhIds]),
    q1(`SELECT tr.id, tr.lenh_san_xuat_id, tr.lan_test, tr.ket_qua, tr.ghi_chu, tr.created_date
          FROM test_run tr WHERE tr.lenh_san_xuat_id = ANY($1::uuid[]) AND COALESCE(tr.ket_qua, '') <> 'HUY'
         ORDER BY tr.created_date`, [lenhIds]),
  ]);
  const temIds = tem.filter((t) => t.trang_thai !== 'HUY').map((t) => t.id);
  if (!temIds.length) return { lenh, phieu, tem, kcs: [], sua: [], oqc: [], pll: [], giao: [], test };
  const [kcs, sua, oqc, pll, giao] = await Promise.all([
    q1(`SELECT k.id, k.tem_id, k.created_date, k.so_luong_kiem, k.so_luong_dat, k.so_luong_loi, k.so_luong_huy, nd.ho_ten AS nguoi
          FROM kcs k LEFT JOIN nguoi_dung nd ON nd.id = k.created_by
         WHERE k.tem_id = ANY($1::uuid[]) AND ${notCancelledQc('k', 'kcs')} ORDER BY k.created_date`, [temIds]),
    q1(`SELECT s.id, s.tem_id, s.created_date, s.so_luong_sua, s.so_luong_sua_dat, s.so_luong_sua_huy, s.tem_con_id, nd.ho_ten AS nguoi
          FROM sua s LEFT JOIN nguoi_dung nd ON nd.id = s.created_by
         WHERE s.tem_id = ANY($1::uuid[]) AND ${notCancelledQc('s', 'sua')} ORDER BY s.created_date`, [temIds]),
    q1(`SELECT o.id, o.tem_id, o.created_date, o.nguon, o.so_luong_kiem, o.so_luong_dat, o.sl_qua_giao, o.ket_qua, nd.ho_ten AS nguoi
          FROM oqc o LEFT JOIN nguoi_dung nd ON nd.id = o.created_by
         WHERE o.tem_id = ANY($1::uuid[]) AND ${notCancelledQc('o', 'oqc')} ORDER BY o.created_date`, [temIds]),
    coPll ? q1(`SELECT p.id, p.tem_id, COALESCE(p.updated_date, p.created_date) AS tg, p.sl_sua_luc_luu, p.sl_huy_luc_luu
                  FROM phan_loai_loi p WHERE p.tem_id = ANY($1::uuid[]) ORDER BY p.created_date`, [temIds]) : [],
    q1(`SELECT gh.id, gh.ma_phieu_giao, gh.trang_thai, gh.created_date, SUM(ght.so_luong_giao)::int AS so_luong,
               array_agg(DISTINCT ght.tem_id) AS tem_ids
          FROM giao_hang gh JOIN giao_hang_tem ght ON ght.giao_hang_id = gh.id
         WHERE ght.tem_id = ANY($1::uuid[]) AND gh.trang_thai <> 'HUY'
         GROUP BY gh.id ORDER BY gh.created_date`, [temIds]),
  ]);
  return { lenh, phieu, tem, kcs, sua, oqc, pll, giao, test };
}

async function danhMucLoaiDotVai() {
  const { rows } = await query(
    'SELECT id, ma_loai, ten_loai FROM loai_dot_vai WHERE dang_hoat_dong ORDER BY ten_loai'
  );
  return rows;
}

module.exports = {
  traCuu, getPhanIn, getReady, getDotVaiList, getDotVaiRaw,
  updatePhanIn, updateDotVai, slDaInCuaDotVai, ghiAudit, danhMucLoaiDotVai, toanCanh,
  COT_PHAN_IN, COT_DOT_VAI,
};
