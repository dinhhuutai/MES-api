'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// PHÂN LOẠI LỖI (mig 075) — trang trong module SẢN XUẤT, nằm dưới KCS.
//
// Chia SL HƯ của 1 tem thành SỬA / HỦY theo từng loại lỗi + biện pháp xử lý; con số ở đây là
// CHÍNH THỨC ⇒ ghi đè `tem.sl_kcs_sua` / `tem.sl_kcs_huy` (xem service).
//
// ⚠ Query gửi 1 dòng (`.replace(/\s+/g,' ')`) cho IPS ⇒ TUYỆT ĐỐI không viết comment `--` bên trong
//   chuỗi SQL (nuốt sạch phần sau, lỗi `42601 syntax error at end of input`) — §9 CLAUDE.md.
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../../config/db');
const { mauTim } = require('../../utils/timKiem');
const { timTem } = require('../../utils/temPrefix');
const { dkTrang } = require('../../utils/phuongAnIn');

// Thông tin phần in / đơn hàng của 1 tem — cùng khuôn `TEM_INFO_LATERAL` của quality.repository.
const INFO = `
  LEFT JOIN LATERAL (
    SELECT kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang, pin.ma_phan,
           pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.tinh_chat_in, dv.han_giao_hang
    FROM phieu_san_xuat ps JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
    JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
    JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
    JOIN phan_in pin ON pin.id = dv.phan_in_id
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    WHERE ps.id = t.phieu_san_xuat_id ORDER BY pin.ma_phan, dv.ma_dot_vai LIMIT 1
  ) info ON true`;

// Sổ cái + tổng đã phân loại của 1 tem. `sl_hu` = phần KHÔNG đạt của KCS (sửa + hủy) — chính là
// con số mà bảng phân loại phải chia hết.
const CHI_SO = `
  t.so_luong, t.sl_chenh_lech, t.sl_kcs_dat, t.sl_kcs_sua, t.sl_kcs_huy,
  t.sl_sua_dat, t.sl_sua_huy, t.sl_oqc_dat, t.sl_da_giao,
  (t.sl_kcs_sua + t.sl_kcs_huy) AS sl_hu,
  (t.so_luong + COALESCE(t.sl_chenh_lech,0) - (t.sl_kcs_dat + t.sl_kcs_sua + t.sl_kcs_huy)) AS con_kcs`;

// ─── Danh sách tem ĐÃ PHÂN LOẠI theo ngày (bảng chính của trang) ─────────────
async function listTheoNgay({ ngay = '', search = '', page = 1, limit = 20 } = {}) {
  const dkPain = await dkTrang('SX_PHAN_LOAI_LOI', 'phieu', 't.phieu_san_xuat_id');
  const params = []; const conds = [dkPain];
  if (ngay) {
    params.push(ngay);
    conds.push(`(pl.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $${params.length}::date`);
  }
  if (search) {
    params.push(mauTim(timTem(search)));
    const i = params.length;
    conds.push(`(t.ma_tem ~* $${i} OR ls.ma_lenh_san_xuat ~* $${i} OR info.ma_phan ~* $${i}
                 OR info.ten_khach_hang ~* $${i} OR info.ma_don_hang ~* $${i} OR info.ma_hang ~* $${i})`);
  }
  const where = `WHERE ${conds.join(' AND ')}`;
  const off = (Math.max(1, page) - 1) * limit;
  params.push(limit, off);
  const sql = `
    SELECT pl.id, pl.tem_id, pl.ghi_chu, pl.created_date, nd.ho_ten AS nguoi,
           t.ma_tem, ${CHI_SO},
           ls.ma_lenh_san_xuat, cs.ten_chuyen,
           info.ten_khach_hang, info.ma_don_hang, info.ma_hang, info.ma_phan,
           info.mau_vai, info.kich_vai, info.kich_phim, info.tinh_chat_in, info.han_giao_hang,
           (SELECT count(*) FROM phan_loai_loi_ct ct WHERE ct.phan_loai_loi_id = pl.id) AS so_dong,
           (SELECT string_agg(DISTINCT ll.ten_loi, ', ') FROM phan_loai_loi_ct ct
              JOIN loai_loi ll ON ll.id = ct.loai_loi_id WHERE ct.phan_loai_loi_id = pl.id) AS cac_loi
    FROM phan_loai_loi pl
    JOIN tem t ON t.id = pl.tem_id
    JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
    JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
    LEFT JOIN chuyen_san_xuat cs ON cs.id = ps.chuyen_id
    LEFT JOIN nguoi_dung nd ON nd.id = pl.created_by
    ${INFO}
    ${where}
    ORDER BY pl.created_date DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}`;
  const countSql = `
    SELECT count(*)::int AS total FROM phan_loai_loi pl
    JOIN tem t ON t.id = pl.tem_id
    JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
    JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
    ${INFO} ${where}`;
  const [d, c] = await Promise.all([
    query(sql.replace(/\s+/g, ' '), params),
    query(countSql.replace(/\s+/g, ' '), params.slice(0, params.length - 2)),
  ]);
  return { rows: d.rows, total: c.rows[0].total };
}

// ─── Tra 1 TEM để mở SidePanel phân loại (quét mã vạch / gõ tay) ─────────────
// `baseMaTem` đã quy mọi tiền tố công đoạn về mã gốc trước khi gọi vào đây.
async function timTemDePhanLoai(maTem) {
  const sql = `
    SELECT t.id AS tem_id, t.ma_tem, t.trang_thai, t.created_date AS tg_in, ${CHI_SO},
           ls.ma_lenh_san_xuat, cs.ten_chuyen, ps.id AS phieu_id,
           info.ten_khach_hang, info.ma_don_hang, info.ma_hang, info.ma_phan,
           info.mau_vai, info.kich_vai, info.kich_phim, info.tinh_chat_in, info.han_giao_hang
    FROM tem t
    JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
    JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
    LEFT JOIN chuyen_san_xuat cs ON cs.id = ps.chuyen_id
    ${INFO}
    WHERE t.ma_tem = $1 LIMIT 1`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [maTem]);
  return rows[0] || null;
}

// Phiếu phân loại (nếu đã có) + các dòng chi tiết.
async function getPhieuTheoTem(temId) {
  const { rows } = await query(
    `SELECT pl.id, pl.tem_id, pl.ghi_chu, pl.created_date, pl.updated_date, nd.ho_ten AS nguoi
       FROM phan_loai_loi pl LEFT JOIN nguoi_dung nd ON nd.id = COALESCE(pl.updated_by, pl.created_by)
      WHERE pl.tem_id = $1`, [temId]
  );
  if (!rows[0]) return null;
  const { rows: ct } = await query(
    `SELECT ct.id, ct.loai_loi_id, ll.ma_loi, ll.ten_loi, ll.nhom_loi,
            ct.bien_phap_id, bp.ma_bien_phap, bp.ten_bien_phap,
            ct.so_luong_sua, ct.so_luong_huy, ct.ghi_chu, ct.thu_tu
       FROM phan_loai_loi_ct ct
       JOIN loai_loi ll ON ll.id = ct.loai_loi_id
       LEFT JOIN bien_phap_xu_ly bp ON bp.id = ct.bien_phap_id
      WHERE ct.phan_loai_loi_id = $1 ORDER BY ct.thu_tu, ct.created_date`, [rows[0].id]
  );
  return { ...rows[0], dong: ct };
}

// ─── Ghi phiếu (upsert theo tem) ─────────────────────────────────────────────
async function upsertPhieuTx(client, temId, { ghiChu, slHu, slSua, slHuy }, actorId) {
  const { rows } = await client.query(
    `INSERT INTO phan_loai_loi (tem_id, ghi_chu, sl_hu_luc_luu, sl_sua_luc_luu, sl_huy_luc_luu, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tem_id) DO UPDATE SET ghi_chu = EXCLUDED.ghi_chu,
       sl_hu_luc_luu = EXCLUDED.sl_hu_luc_luu, sl_sua_luc_luu = EXCLUDED.sl_sua_luc_luu,
       sl_huy_luc_luu = EXCLUDED.sl_huy_luc_luu,
       updated_by = EXCLUDED.created_by, updated_date = CURRENT_TIMESTAMP
     RETURNING id`,
    [temId, ghiChu || null, slHu, slSua, slHuy, actorId || null]
  );
  return rows[0].id;
}

// Xóa sạch dòng cũ rồi ghi lại — luôn khớp đúng bảng người dùng đang thấy (cần GRANT DELETE, mig 075).
async function replaceChiTietTx(client, phieuId, dong, actorId) {
  await client.query('DELETE FROM phan_loai_loi_ct WHERE phan_loai_loi_id = $1', [phieuId]);
  for (let i = 0; i < dong.length; i += 1) {
    const d = dong[i];
    await client.query(
      `INSERT INTO phan_loai_loi_ct
         (phan_loai_loi_id, loai_loi_id, bien_phap_id, so_luong_sua, so_luong_huy, ghi_chu, thu_tu, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [phieuId, d.loaiLoiId, d.bienPhapId || null, d.soLuongSua || 0, d.soLuongHuy || 0,
        d.ghiChu || null, i, actorId || null]
    );
  }
}

// Đặt THẲNG phần chia sửa/hủy của tem (KHÔNG cộng dồn như `addKcsLedger`) — đây là điểm khác biệt
// cốt lõi của tính năng: bảng phân loại là nguồn CHÍNH THỨC. `sl_kcs_dat` và `so_luong` KHÔNG đụng
// nên tổng kiểm giữ nguyên, sổ cái §11.4 vẫn cân.
async function datChiaSuaHuyTx(client, temId, { sua, huy }, actorId) {
  await client.query(
    `UPDATE tem SET sl_kcs_sua = $2, sl_kcs_huy = $3, updated_by = $4, updated_date = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [temId, sua, huy, actorId || null]
  );
}

// ─── Danh mục biện pháp xử lý ────────────────────────────────────────────────
async function listBienPhap({ search = '', all = false } = {}) {
  const { rows } = await query(
    `SELECT id, ma_bien_phap, ten_bien_phap, mo_ta, dang_hoat_dong
       FROM bien_phap_xu_ly
      WHERE ($1 = '' OR ma_bien_phap ~* $1 OR ten_bien_phap ~* $1)
        ${all ? '' : 'AND dang_hoat_dong'}
      ORDER BY ten_bien_phap`.replace(/\s+/g, ' '),
    [mauTim(search)]
  );
  return rows;
}

async function createBienPhap(d, actorId) {
  const { rows } = await query(
    `INSERT INTO bien_phap_xu_ly (ma_bien_phap, ten_bien_phap, mo_ta, created_by)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [d.maBienPhap, d.tenBienPhap, d.moTa || null, actorId || null]
  );
  return rows[0].id;
}

async function updateBienPhap(id, d, actorId) {
  await query(
    `UPDATE bien_phap_xu_ly SET ten_bien_phap = COALESCE($2, ten_bien_phap), mo_ta = $3,
       updated_by = $4, updated_date = CURRENT_TIMESTAMP WHERE id = $1`,
    [id, d.tenBienPhap ?? null, d.moTa ?? null, actorId || null]
  );
}

async function setBienPhapActive(id, active, actorId) {
  await query(
    `UPDATE bien_phap_xu_ly SET dang_hoat_dong = $2, updated_by = $3, updated_date = CURRENT_TIMESTAMP
      WHERE id = $1`, [id, active, actorId || null]
  );
}

const existsMaBienPhap = async (ma) => (
  await query('SELECT 1 FROM bien_phap_xu_ly WHERE ma_bien_phap = $1', [ma])
).rows.length > 0;

module.exports = {
  listTheoNgay, timTemDePhanLoai, getPhieuTheoTem,
  upsertPhieuTx, replaceChiTietTx, datChiaSuaHuyTx,
  listBienPhap, createBienPhap, updateBienPhap, setBienPhapActive, existsMaBienPhap,
};
