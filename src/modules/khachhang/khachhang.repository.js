'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// KHÁCH HÀNG — đọc/sửa thông tin liên hệ (mig 099).
//
// ⚠ Bảng `khach_hang` do **ERP đẩy sang** (`erpsync.upsertKhachHang` khớp theo `ma_khach_hang`) ⇒
//   `ma_khach_hang` / `ten_khach_hang` là của ERP, MES **KHÔNG sửa** 2 trường đó: sync sau sẽ ghi đè
//   và mọi nơi tra cứu theo tên khách (vd `utils/tech.js KHUON_OPTIONAL_KH = ['II','AD']`) sẽ lệch.
//   Trang này chỉ sửa 3 trường MES tự quản: `dia_chi`, `dia_chi_giao`, `ghi_chu`.
//
// ⚠⚠ DÒ CỘT TRƯỚC (khuôn `temCoCot` mig 066): 2 cột địa chỉ thêm SAU khi bảng đã lên production.
//   TUYỆT ĐỐI KHÔNG try/catch quanh câu SQL — `42703` trong transaction làm ABORT cả transaction.
//   Thiếu migration ⇒ vẫn đọc/sửa được ghi chú, FE hiện banner nhắc chạy migration.
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../../config/db');
const { mauTim } = require('../../utils/timKiem');

let _coCot = null;
async function coCotDiaChi() {
  if (_coCot) return true;             // chỉ cache khi ĐÃ có ⇒ chạy migration xong nhận ngay, khỏi restart
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'khach_hang' AND column_name IN ('dia_chi','dia_chi_giao')`.replace(/\s+/g, ' ')
  );
  _coCot = rows[0].n === 2;
  return _coCot;
}

// ⚠ Cột `ten_day_du` (mig 101) dò RIÊNG — KHÔNG gộp vào `coCotDiaChi` (bài học mig 077 ↔ 079: gộp
//   1 cờ thì môi trường chỉ chạy 1 trong 2 migration sẽ chết nhánh kia).
let _coTen = null;
async function coCotTenDayDu() {
  if (_coTen) return true;
  const { rows } = await query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'khach_hang' AND column_name = 'ten_day_du' LIMIT 1`.replace(/\s+/g, ' ')
  );
  _coTen = rows.length > 0;
  return _coTen;
}

// Danh sách + tìm kiếm (không dấu, `~*` theo luật §8) + phân trang SERVER.
// `so_don_hang` để biết khách nào đang thực sự có việc — khách ERP đẩy sang rất nhiều, phần lớn không
// còn đơn nào; thiếu cột này thì không biết nên nhập địa chỉ cho khách nào trước.
async function list({ search = '', offset = 0, limit = 20 }) {
  const [co, coTen] = await Promise.all([coCotDiaChi(), coCotTenDayDu()]);
  const cotDiaChi = co ? 'kh.dia_chi, kh.dia_chi_giao' : 'NULL::text AS dia_chi, NULL::text AS dia_chi_giao';
  const cotTen = coTen ? 'kh.ten_day_du' : 'NULL::text AS ten_day_du';
  // ⚠ Ô tìm soi CẢ địa chỉ + tên đầy đủ (khi có cột) — người dùng hay tra "khách nào ở khu công nghiệp X".
  const tim = [`kh.ma_khach_hang ~* $1`, `kh.ten_khach_hang ~* $1`];
  if (coTen) tim.push(`COALESCE(kh.ten_day_du,'') ~* $1`);
  if (co) tim.push(`COALESCE(kh.dia_chi,'') ~* $1`, `COALESCE(kh.dia_chi_giao,'') ~* $1`);
  const dkTim = `($1 = '' OR ${tim.join(' OR ')})`;
  const FROM = `FROM khach_hang kh WHERE kh.dang_hoat_dong AND ${dkTim}`;
  const args = [mauTim(search)];

  const dataSql = `
    SELECT kh.id, kh.ma_khach_hang, kh.ten_khach_hang, ${cotTen}, ${cotDiaChi}, kh.ghi_chu,
           kh.updated_date, nd.ho_ten AS nguoi_sua,
           (SELECT count(*)::int FROM don_hang dh WHERE dh.khach_hang_id = kh.id) AS so_don_hang
      ${FROM.replace('FROM khach_hang kh', 'FROM khach_hang kh LEFT JOIN nguoi_dung nd ON nd.id = kh.updated_by')}
     ORDER BY kh.ma_khach_hang
     LIMIT $2 OFFSET $3`;
  const countSql = `SELECT count(*)::int AS total ${FROM}`;

  const [data, count] = await Promise.all([
    query(dataSql.replace(/\s+/g, ' '), [...args, limit, offset]),
    query(countSql.replace(/\s+/g, ' '), args),
  ]);
  return { rows: data.rows, total: count.rows[0].total, co_cot: co, co_cot_ten: coTen };
}

async function getById(id) {
  const [co, coTen] = await Promise.all([coCotDiaChi(), coCotTenDayDu()]);
  const cot = co ? 'dia_chi, dia_chi_giao' : "NULL::text AS dia_chi, NULL::text AS dia_chi_giao";
  const cotTen = coTen ? 'ten_day_du' : 'NULL::text AS ten_day_du';
  const { rows } = await query(
    `SELECT id, ma_khach_hang, ten_khach_hang, ${cotTen}, ${cot}, ghi_chu FROM khach_hang WHERE id = $1`.replace(/\s+/g, ' '),
    [id]
  );
  return rows[0] || null;
}

// ⚠ WHITELIST CỘT CỨNG — không nhận tên cột từ client (cùng luật `phaninadmin.repository`).
//   `undefined` = không gửi lên ⇒ GIỮ NGUYÊN; chuỗi rỗng ⇒ xóa trắng (ghi NULL).
async function update(id, { tenDayDu, diaChi, diaChiGiao, ghiChu }, actorId) {
  const [co, coTen] = await Promise.all([coCotDiaChi(), coCotTenDayDu()]);
  const set = [];
  const val = [];
  const them = (cot, v) => { val.push(v === '' ? null : v); set.push(`${cot} = $${val.length}`); };

  if (coTen && tenDayDu !== undefined) them('ten_day_du', tenDayDu);
  if (co && diaChi !== undefined) them('dia_chi', diaChi);
  if (co && diaChiGiao !== undefined) them('dia_chi_giao', diaChiGiao);
  if (ghiChu !== undefined) them('ghi_chu', ghiChu);
  if (!set.length) return null;

  val.push(actorId || null);
  const iBy = val.length;
  val.push(id);
  const { rows } = await query(
    `UPDATE khach_hang SET ${set.join(', ')}, updated_by = $${iBy}, updated_date = CURRENT_TIMESTAMP
      WHERE id = $${val.length} RETURNING id`.replace(/\s+/g, ' '),
    val
  );
  return rows[0] || null;
}

module.exports = { list, getById, update, coCotDiaChi, coCotTenDayDu };
