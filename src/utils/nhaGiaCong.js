// NHÀ GIA CÔNG CỦA ĐỢT VẢI (ERP `NGC` → `dot_vai_ve.nha_gia_cong`, mig 072) — khóa so sánh khi GOM số lượng.
// ⚠⚠ 27/10/2026 (người dùng chốt): NGC đi theo ĐỢT VẢI; 1 phần in có 2 đợt của 2 nhà gia công khác nhau thì KHÔNG cộng
//   số lượng lại — mọi chỗ gom đợt / gộp lệnh cùng code phần (Release 1 · Gom đợt vải · Chờ chạy / Đang chạy · gộp lệnh
//   khi chạy / in tem · "Không test run" cộng vào lệnh đang chạy) phải thêm khóa này. Gương FE `utils/nhaGiaCong.js`.
//   Trống (NULL / '') là 1 giá trị riêng — không gom với đợt có NGC.
const khoaNgc = (v) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').toUpperCase();

const khoaNgcSql = (col) => `upper(regexp_replace(btrim(COALESCE(${col}, '')), '[[:space:]]+', ' ', 'g'))`;

// Khóa NGC của CẢ LỆNH = các NGC khác nhau của đợt có SL > 0 trong lệnh, ngăn '|' (lệnh sạch ⇒ 1 giá trị).
const khoaNgcLenhSql = (lenhCol) => `COALESCE((SELECT string_agg(DISTINCT ${khoaNgcSql('dvk.nha_gia_cong')}, '|' ORDER BY ${khoaNgcSql('dvk.nha_gia_cong')})
  FROM lenh_sx_dot_vai lk JOIN dot_vai_ve dvk ON dvk.id = lk.dot_vai_ve_id
  WHERE lk.lenh_san_xuat_id = ${lenhCol} AND COALESCE(lk.so_luong, 0) > 0), '')`.replace(/\s+/g, ' ');

const tenNgc = (k) => (k ? k : '(trống)');

module.exports = { khoaNgc, khoaNgcSql, khoaNgcLenhSql, tenNgc };
