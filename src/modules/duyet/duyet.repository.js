'use strict';

// HÀNG ĐỢI DUYỆT (mig 086). Luật + danh mục loại ở `utils/duyet.js`.
// ⚠ SQL gửi GỘP 1 DÒNG (IPS — §9) ⇒ KHÔNG viết comment `-- …` bên trong chuỗi SQL.

const { query } = require('../../config/db');
const { mauTim } = require('../../utils/timKiem');

// Cột trả về cho hàng đợi — kèm tên người gửi/người duyệt để FE không phải tra thêm.
const COT = `yc.id, yc.loai, yc.doi_tuong_bang, yc.doi_tuong_id, yc.mo_ta,
  yc.gia_tri_cu, yc.gia_tri_moi, yc.ly_do, yc.trang_thai,
  yc.nguoi_gui, ng.ho_ten AS ten_nguoi_gui, ng.ten_dang_nhap AS user_nguoi_gui, yc.tg_gui,
  yc.nguoi_duyet, nd.ho_ten AS ten_nguoi_duyet, yc.tg_duyet, yc.ghi_chu_duyet`;

const FROM = `FROM yeu_cau_duyet yc
  LEFT JOIN nguoi_dung ng ON ng.id = yc.nguoi_gui
  LEFT JOIN nguoi_dung nd ON nd.id = yc.nguoi_duyet`;

// Danh sách hàng đợi. `chiCuaToi` = chỉ yêu cầu do CHÍNH người này gửi (người không có quyền duyệt).
async function danhSach({ loai, trangThai, timKiem, chiCuaToi, userId, page = 1, limit = 20 }) {
  const dk = ['1=1'];
  const p = [];
  const them = (v, sql) => { p.push(v); dk.push(sql.replace('$n', `$${p.length}`)); };

  if (loai) them(loai, 'yc.loai = $n');
  if (trangThai) them(trangThai, 'yc.trang_thai = $n');
  if (chiCuaToi) them(userId, 'yc.nguoi_gui = $n');
  if (timKiem) them(mauTim(timKiem), "concat_ws(' ', yc.mo_ta, yc.ly_do, ng.ho_ten) ~* $n");

  const where = `WHERE ${dk.join(' AND ')}`;
  const dem = await query(`SELECT count(*)::int AS n ${FROM} ${where}`.replace(/\s+/g, ' '), p);
  const total = dem.rows[0] ? dem.rows[0].n : 0;

  const lim = Math.min(200, Math.max(1, Number(limit) || 20));
  const off = (Math.max(1, Number(page) || 1) - 1) * lim;
  // ⚠ CHỜ DUYỆT luôn lên đầu (bất kể ngày), rồi mới tới lịch sử theo giờ giảm dần — hàng đợi là để
  //   XỬ LÝ, không phải để đọc lịch sử.
  const ds = await query(
    `SELECT ${COT} ${FROM} ${where}
     ORDER BY (yc.trang_thai = 'CHO') DESC, yc.tg_gui DESC
     LIMIT ${lim} OFFSET ${off}`.replace(/\s+/g, ' '),
    p
  );
  return { items: ds.rows, total };
}

// Đếm số yêu cầu ĐANG CHỜ theo từng loại → badge trên menu + số trên chip.
async function demCho(loaiList = []) {
  if (!loaiList.length) return {};
  const { rows } = await query(
    `SELECT loai, count(*)::int AS n FROM yeu_cau_duyet
      WHERE trang_thai = 'CHO' AND loai = ANY($1::text[]) GROUP BY loai`.replace(/\s+/g, ' '),
    [loaiList]
  );
  return Object.fromEntries(rows.map((r) => [r.loai, r.n]));
}

async function timTheoId(id) {
  const { rows } = await query(`SELECT ${COT} ${FROM} WHERE yc.id = $1`.replace(/\s+/g, ' '), [id]);
  return rows[0] || null;
}

// Yêu cầu đang CHỜ của 1 đối tượng (chặn gửi trùng + để FE hiện "đang chờ duyệt").
async function timDangCho(loai, bang, doiTuongId) {
  const { rows } = await query(
    `SELECT ${COT} ${FROM} WHERE yc.loai = $1 AND yc.doi_tuong_bang = $2
       AND yc.doi_tuong_id = $3 AND yc.trang_thai = 'CHO' LIMIT 1`.replace(/\s+/g, ' '),
    [loai, bang, doiTuongId]
  );
  return rows[0] || null;
}

// Map { doi_tuong_id: yeu_cau } các yêu cầu đang CHỜ — để màn READY/QC gắn badge "chờ duyệt"
// mà không phải gọi từng dòng.
async function mapDangCho(loai, ids = []) {
  if (!Array.isArray(ids) || !ids.length) return {};
  try {
    const { rows } = await query(
      `SELECT ${COT} ${FROM} WHERE yc.loai = $1 AND yc.trang_thai = 'CHO'
         AND yc.doi_tuong_id = ANY($2::uuid[])`.replace(/\s+/g, ' '),
      [loai, ids]
    );
    return Object.fromEntries(rows.map((r) => [r.doi_tuong_id, r]));
  } catch (e) {
    // ⚠ FAIL-OPEN: chưa chạy mig 086 ⇒ coi như không có yêu cầu nào đang chờ. Màn READY/QC vẫn
    //   chạy bình thường, chỉ thiếu badge — không được để thiếu migration làm sập màn thao tác.
    return {};
  }
}

async function taoYeuCau(d, client = null) {
  const q = client ? client.query.bind(client) : query;
  const { rows } = await q(
    `INSERT INTO yeu_cau_duyet
       (loai, doi_tuong_bang, doi_tuong_id, mo_ta, gia_tri_cu, gia_tri_moi, ly_do,
        trang_thai, nguoi_gui, nguoi_duyet, tg_duyet, ghi_chu_duyet, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$9) RETURNING id`.replace(/\s+/g, ' '),
    [d.loai, d.bang, d.doiTuongId, d.moTa || null,
      d.giaTriCu == null ? null : JSON.stringify(d.giaTriCu),
      d.giaTriMoi == null ? null : JSON.stringify(d.giaTriMoi),
      d.lyDo, d.trangThai || 'CHO', d.nguoiGui || null,
      d.nguoiDuyet || null, d.tgDuyet || null, d.ghiChuDuyet || null]
  );
  return rows[0] ? rows[0].id : null;
}

// Chốt 1 yêu cầu (DUYET | TU_CHOI | HUY).
// ⚠⚠ `WHERE trang_thai='CHO'` là CHỐT CHỐNG BẤM 2 LẦN: 2 người duyệt cùng lúc thì chỉ 1 lượt ghi
//   được, lượt sau `rowCount = 0` ⇒ service báo "đã xử lý rồi" thay vì áp dụng thay đổi 2 lần.
async function chotYeuCau(id, { trangThai, nguoiDuyet, ghiChu }, client = null) {
  const q = client ? client.query.bind(client) : query;
  const { rowCount } = await q(
    `UPDATE yeu_cau_duyet SET trang_thai = $2, nguoi_duyet = $3, tg_duyet = CURRENT_TIMESTAMP,
       ghi_chu_duyet = $4, updated_date = CURRENT_TIMESTAMP, updated_by = $3
     WHERE id = $1 AND trang_thai = 'CHO'`.replace(/\s+/g, ' '),
    [id, trangThai, nguoiDuyet || null, ghiChu || null]
  );
  return rowCount > 0;
}

// Mở lại yêu cầu về 'CHO' khi bước ÁP DỤNG thất bại sau lúc đã chốt.
// ⚠ Phải là câu riêng, KHÔNG dùng `chotYeuCau`: hàm đó chỉ ghi khi đang 'CHO', mà dòng lúc này
//   vừa bị đặt 'DUYET' nên sẽ không khớp và yêu cầu kẹt vĩnh viễn ở trạng thái sai.
async function moLaiCho(id) {
  await query(
    `UPDATE yeu_cau_duyet SET trang_thai = 'CHO', nguoi_duyet = NULL, tg_duyet = NULL,
       ghi_chu_duyet = NULL, updated_date = CURRENT_TIMESTAMP
     WHERE id = $1`.replace(/\s+/g, ' '),
    [id]
  );
}

module.exports = {
  danhSach, demCho, timTheoId, timDangCho, mapDangCho, taoYeuCau, chotYeuCau, moLaiCho,
};
