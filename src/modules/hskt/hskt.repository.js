'use strict';

const { query, withTransaction } = require('../../config/db');
const { applyPainToBarcode } = require('../../utils/hskt');

// SELECT phần in dùng chung (kèm khách/đơn/mã hàng).
const PIN_SELECT = `pin.id, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.barcode,
  pin.so_luong_don_hang, mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang`;
const PIN_JOIN = `JOIN phan_in pin ON pin.id = hp.phan_in_id AND pin.dang_hoat_dong
  JOIN ma_hang mh ON mh.id = pin.ma_hang_id
  JOIN don_hang dh ON dh.id = mh.don_hang_id
  JOIN khach_hang kh ON kh.id = dh.khach_hang_id`;

// Danh sách HSKT MỚI NHẤT (dang_hoat_dong) + số phần in + code phần gộp + thông tin đơn hàng
// (khách/đơn/mã hàng/màu/kích/loại đợt vải) GỘP DISTINCT theo các phần in trong HSKT — 1 HSKT có thể nhiều phần in.
// Tìm theo barcode HSKT / code phần.
async function listHskt({ search = '', offset = 0, limit = 20 }) {
  const sql = `
    SELECT h.id, h.barcode_hskt, h.barcode_hskt_goc, h.pa_in_sua_tay,
           h.ma_hskt, h.phuong_an_in, h.phien_ban, h.inset, h.ma_don_ready,
           h.created_date, h.updated_date,
           info.so_phan_in, info.code_phan_list, info.ten_khach_hang, info.ma_don_hang, info.ma_hang,
           info.mau_vai, info.kich_vai, info.kich_phim, info.loai_dot_vai,
           count(*) OVER()::int AS total
    FROM ho_so_ky_thuat h
    LEFT JOIN LATERAL (
      SELECT count(DISTINCT pin.id)::int AS so_phan_in,
             string_agg(DISTINCT pin.ma_phan, ', ') AS code_phan_list,
             string_agg(DISTINCT kh.ten_khach_hang, ', ') AS ten_khach_hang,
             string_agg(DISTINCT dh.ma_don_hang, ', ') AS ma_don_hang,
             string_agg(DISTINCT mh.ma_hang, ', ') AS ma_hang,
             string_agg(DISTINCT pin.mau_vai, ', ') AS mau_vai,
             string_agg(DISTINCT pin.kich_vai, ', ') AS kich_vai,
             string_agg(DISTINCT pin.kich_phim, ', ') AS kich_phim,
             string_agg(DISTINCT ldv.ten_loai, ', ') AS loai_dot_vai
      FROM hskt_phan_in hp
      JOIN phan_in pin ON pin.id = hp.phan_in_id AND pin.dang_hoat_dong
      JOIN ma_hang mh ON mh.id = pin.ma_hang_id
      JOIN don_hang dh ON dh.id = mh.don_hang_id
      JOIN khach_hang kh ON kh.id = dh.khach_hang_id
      LEFT JOIN dot_vai_ve dv ON dv.phan_in_id = pin.id AND dv.trang_thai NOT IN ('DA_GOP','DA_HUY')
      LEFT JOIN loai_dot_vai ldv ON ldv.id = dv.loai_dot_vai_id
      WHERE hp.hskt_id = h.id AND hp.dang_hoat_dong
    ) info ON true
    WHERE h.dang_hoat_dong = true
      AND ($1 = '' OR h.barcode_hskt ILIKE '%'||$1||'%' OR h.ma_hskt ILIKE '%'||$1||'%'
           OR EXISTS (SELECT 1 FROM hskt_phan_in hp JOIN phan_in pin ON pin.id = hp.phan_in_id
                      WHERE hp.hskt_id = h.id AND hp.dang_hoat_dong AND pin.ma_phan ILIKE '%'||$1||'%'))
    ORDER BY h.updated_date DESC NULLS LAST, h.created_date DESC
    LIMIT $2 OFFSET $3`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), [search, limit, offset]);
  const total = rows[0] ? rows[0].total : 0;
  return { rows, total };
}

async function getHsktById(id) {
  const { rows } = await query(
    `SELECT id, barcode_hskt, barcode_hskt_goc, pa_in_sua_tay, ma_hskt, phuong_an_in, phien_ban,
            inset, ma_don_ready,
            so_luong_vai_pass, so_lan_in, so_pass_bo, ghi_chu, dang_hoat_dong, created_date, updated_date
     FROM ho_so_ky_thuat WHERE id = $1`, [id]);
  return rows[0] || null;
}

// Phần in thuộc 1 HSKT (junction active).
async function phanInOfHskt(hsktId) {
  const { rows } = await query(
    `SELECT ${PIN_SELECT} FROM hskt_phan_in hp ${PIN_JOIN}
     WHERE hp.hskt_id = $1 AND hp.dang_hoat_dong ORDER BY pin.mau_vai, pin.ma_phan`,
    [hsktId]);
  return rows;
}

// HSKT active của 1 phần in (nếu có).
async function activeHsktOfPhanIn(phanInId) {
  const { rows } = await query(
    `SELECT h.id, h.barcode_hskt, h.ma_hskt, h.phuong_an_in, h.phien_ban, h.inset, h.ma_don_ready
     FROM hskt_phan_in hp JOIN ho_so_ky_thuat h ON h.id = hp.hskt_id
     WHERE hp.phan_in_id = $1 AND hp.dang_hoat_dong AND h.dang_hoat_dong LIMIT 1`, [phanInId]);
  return rows[0] || null;
}

// HSKT active theo barcode (cho luồng quét).
// ⚠ CỐ Ý khớp CHÍNH XÁC `barcode_hskt` (mã đang hiển thị/in), KHÔNG khớp `barcode_hskt_goc`:
// chốt nghiệp vụ là phiếu giấy in barcode CŨ thì thôi không quét được nữa, phải in lại phiếu.
async function activeHsktByBarcode(barcode) {
  const { rows } = await query(
    `SELECT id, barcode_hskt, barcode_hskt_goc, pa_in_sua_tay, ma_hskt, phuong_an_in, phien_ban,
            inset, ma_don_ready
     FROM ho_so_ky_thuat WHERE barcode_hskt = $1 AND dang_hoat_dong = true LIMIT 1`, [barcode]);
  return rows[0] || null;
}

// Lịch sử thao tác của HSKT — gộp MỌI phiên bản theo ĐỊNH DANH GỐC, không theo barcode hiện tại:
// đổi phương án in làm đổi số cuối barcode, nếu gom theo `barcode_hskt` thì lịch sử bị TÁCH ĐÔI
// (phiên bản cũ mang `...1`, phiên bản mới mang `...2`).
async function historyByBarcode(barcode) {
  const { rows } = await query(
    `SELECT lh.hanh_dong, lh.chi_tiet, lh.phien_ban, lh.tg, nd.ho_ten AS nguoi, pin.ma_phan
     FROM lich_su_hskt lh
     JOIN ho_so_ky_thuat h ON h.id = lh.hskt_id
     LEFT JOIN nguoi_dung nd ON nd.id = lh.nguoi_id
     LEFT JOIN phan_in pin ON pin.id = lh.phan_in_id
     WHERE COALESCE(h.barcode_hskt_goc, h.barcode_hskt) = (
       SELECT COALESCE(h2.barcode_hskt_goc, h2.barcode_hskt) FROM ho_so_ky_thuat h2
        WHERE h2.barcode_hskt = $1 OR h2.barcode_hskt_goc = $1
        ORDER BY h2.dang_hoat_dong DESC, h2.phien_ban DESC LIMIT 1)
     ORDER BY lh.tg DESC`, [barcode]);
  return rows;
}

// Đổi phương án in → TẠO PHIÊN BẢN MỚI (giữ bản cũ), relink phần in, ghi lịch sử. Trả về id HSKT mới.
// ĐỔI LUÔN SỐ CUỐI `barcode_hskt` theo phương án in (1 Bàn · 2 Máy · 3 Robot) — xem `utils/hskt.js`.
// Đồng thời: giữ `barcode_hskt_goc` (barcode ERP, để đồng bộ ERP còn tra ra) + bật `pa_in_sua_tay`
// (khóa không cho ERP ghi đè lại phương án in).
// Trả `{ id, barcode_cu, barcode_moi }`, hoặc `{ error: 'BARCODE_TRUNG' }` khi barcode mới đã có chủ.
async function changePhuongAnIn(hsktId, pain, actorId) {
  return withTransaction(async (client) => {
    const { rows: cur } = await client.query(
      `SELECT id, barcode_hskt, barcode_hskt_goc, ma_hskt, phuong_an_in, phien_ban, dang_hoat_dong
       FROM ho_so_ky_thuat WHERE id=$1`, [hsktId]);
    if (!cur.length) return null;
    const h = cur[0];
    if (Number(h.phuong_an_in) === Number(pain)) {
      return { id: h.id, barcode_cu: h.barcode_hskt, barcode_moi: h.barcode_hskt, khong_doi: true };
    }
    const barcodeMoi = applyPainToBarcode(h.barcode_hskt, pain);
    // `barcode_hskt` KHÔNG có UNIQUE (mig 064) ⇒ tự chặn: không để 2 HSKT ACTIVE cùng mã vạch.
    if (barcodeMoi && barcodeMoi !== h.barcode_hskt) {
      const { rows: dup } = await client.query(
        'SELECT id FROM ho_so_ky_thuat WHERE barcode_hskt=$1 AND dang_hoat_dong=true AND id<>$2 LIMIT 1',
        [barcodeMoi, hsktId]);
      if (dup.length) return { error: 'BARCODE_TRUNG', barcode_moi: barcodeMoi };
    }
    // `ma_hskt` được set = barcode lúc tạo ⇒ chỉ đổi theo khi nó đang ĐÚNG BẰNG barcode cũ.
    const maHsktMoi = h.ma_hskt && h.ma_hskt === h.barcode_hskt ? barcodeMoi : h.ma_hskt;
    const goc = h.barcode_hskt_goc || h.barcode_hskt; // lần đầu sửa tay → chốt barcode ERP làm gốc

    await client.query('UPDATE ho_so_ky_thuat SET dang_hoat_dong=false, updated_date=now() WHERE id=$1', [hsktId]);
    const ins = await client.query(
      `INSERT INTO ho_so_ky_thuat (barcode_hskt, barcode_hskt_goc, pa_in_sua_tay, ma_hskt, phuong_an_in,
         inset, phien_ban, ma_don_ready,
         so_luong_vai_pass, so_lan_in, so_pass_bo, thong_so_json, ghi_chu, dang_hoat_dong, created_by, updated_date, updated_by)
       SELECT $5, $6, true, $7, $2, inset, $3, ma_don_ready,
         so_luong_vai_pass, so_lan_in, so_pass_bo, thong_so_json, ghi_chu, true, $4, now(), $4
       FROM ho_so_ky_thuat WHERE id=$1 RETURNING id`,
      [hsktId, pain, (h.phien_ban || 1) + 1, actorId, barcodeMoi, goc, maHsktMoi]);
    const newId = ins.rows[0].id;
    await client.query(
      `INSERT INTO hskt_phan_in (hskt_id, phan_in_id, created_by)
       SELECT $2, phan_in_id, $3 FROM hskt_phan_in WHERE hskt_id=$1 AND dang_hoat_dong
       ON CONFLICT (hskt_id, phan_in_id) DO NOTHING`, [hsktId, newId, actorId]);
    await client.query('UPDATE hskt_phan_in SET dang_hoat_dong=false WHERE hskt_id=$1', [hsktId]);
    const doiMa = barcodeMoi && barcodeMoi !== h.barcode_hskt
      ? ` · mã vạch ${h.barcode_hskt} → ${barcodeMoi}`
      : (h.barcode_hskt ? ' · mã vạch giữ nguyên (không đúng định dạng 11 số + 1..3)' : '');
    await client.query(
      `INSERT INTO lich_su_hskt (hskt_id, hanh_dong, chi_tiet, phien_ban, nguoi_id)
       VALUES ($1,'DOI_PHUONG_AN_IN',$2,$3,$4)`,
      [newId, `Đổi phương án in ${h.phuong_an_in ?? '—'}→${pain}${doiMa}`, (h.phien_ban || 1) + 1, actorId]);
    return { id: newId, barcode_cu: h.barcode_hskt, barcode_moi: barcodeMoi };
  });
}

module.exports = {
  listHskt, getHsktById, phanInOfHskt, activeHsktOfPhanIn, activeHsktByBarcode, historyByBarcode, changePhuongAnIn,
};
