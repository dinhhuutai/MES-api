'use strict';

// ─── TEST RUN TRONG NGÀY — nguồn chung cho danh sách `DS_TEST_RUN` + nhóm metric "Test Run hôm nay" ───────
// (08/10/2026, người dùng hỏi "hôm nay test run bao nhiêu đơn, mã, phần và đã test được phần nào").
// 1 LỆNH thuộc "Test Run hôm nay" khi:
//   · ĐANG CHỜ TEST = đúng hàng đợi màn Test Run - QA (`planning.repository lenhWhere` + `chuaQaDat`): lệnh
//     `RELEASE_1`, chưa có `TEST_QA` DAT, KHÔNG đang ở GN (`LENH_CHO_GN_SQL`), KHÔNG bị trả về Kế hoạch
//     (`LENH_CHO_KH_SQL`), qua cấu hình hiển thị `CL_TEST_RUN` (`dkTrang`). Lệnh test LỖI đang chờ kỹ thuật vẫn
//     nằm trong hàng đợi (màn hiện badge) ⇒ tính "chờ test". Ảnh chụp HIỆN TẠI, không theo ngày.
//   · HOẶC ĐÃ TEST trong ngày = `TEST_QA` DAT xác nhận trong ngày (gồm "In không đạt — owner cho IN", vì lần đó
//     cũng ghi TEST_QA DAT). Lệnh bị hủy (`HUY`) không tính.
// ⚠ "Không test run" (nút skip) KHÔNG ghi TEST_QA — lệnh rời thẳng sang Release 2 nên không có mặt ở đây
//   (đo prod 08/10: 0 lần trong 7 ngày).
// ⚠ ĐẾM PHẦN IN / MÃ / ĐƠN theo MỌI phần in của lệnh (lệnh gom set cũ có nhiều phần in). 1 phần in có 2 lệnh
//   (1 đã test, 1 còn chờ) ⇒ tính "CÒN CHỜ" — "đã test xong" = mọi lệnh hôm nay của nó đều đã test ⇒
//   Tổng = Đã test xong + Còn chờ (cộng khớp, chia % được). Mã hàng / đơn hàng cùng luật (còn ≥1 phần in chờ ⇒ chờ).

const { query } = require('../../config/db');
const { dkTrang } = require('../../utils/phuongAnIn');
const { LENH_CHO_GN_SQL } = require('../../utils/traVeGn');
const { LENH_CHO_KH_SQL } = require('../../utils/traVeKeHoach');

const VN_TODAY = "(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date";
// ⚠ CỐ Ý CHỪA NGOẶC "EXISTS (" CHƯA ĐÓNG — bên gọi nối thêm điều kiện (vd ngày) rồi tự đóng `)`.
const QA_DAT = (l) => `EXISTS (SELECT 1 FROM ket_qua_checkpoint zq JOIN checkpoint zc ON zc.id = zq.checkpoint_id
  WHERE zq.lenh_san_xuat_id = ${l}.id AND zc.ma_checkpoint = 'TEST_QA' AND zq.trang_thai = 'DAT'`;

// Lệnh ĐANG CHỜ TEST (gương hàng đợi màn Test Run). `l` = alias bảng `lenh_san_xuat`.
async function dkChoTestSql(l = 'ls') {
  const dkPain = await dkTrang('CL_TEST_RUN', 'lenh', `${l}.id`);
  return `(${l}.trang_thai = 'RELEASE_1' AND ${dkPain} AND NOT ${LENH_CHO_GN_SQL(`${l}.id`)}`
    + ` AND NOT ${LENH_CHO_KH_SQL(`${l}.id`)} AND NOT ${QA_DAT(l)}))`;
}

// Lệnh ĐÃ TEST trong ngày — `dkNgay(col)` = điều kiện ngày trên cột mốc TEST_QA (mặc định: hôm nay giờ VN).
const dkDaTestSql = (l = 'ls', dkNgay = (c) => `(${c} AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = ${VN_TODAY}`) =>
  `(${l}.trang_thai <> 'HUY' AND ${QA_DAT(l)} AND ${dkNgay('zq.tg_xac_nhan')}))`;

// Đếm hôm nay — 1 câu cho cả 12 metric. Trả { lenh|phan|ma|don: { tong, da, cho } }.
async function demHomNay() {
  const cho = await dkChoTestSql('ls');
  const da = dkDaTestSql('ls');
  // Lọc thô trước (RELEASE_1 hoặc đã QA hôm nay — vài trăm lệnh) rồi mới tính vị từ "chờ test" (GN / trả về KH /
  //   cấu hình hiển thị) ⇒ không chạy subquery nặng trên hàng nghìn lệnh đã qua sản xuất. ⚠ Lệnh QA đạt vẫn ở
  //   `RELEASE_1` tới khi KH duyệt Release 2 ⇒ phải giữ cờ `da` riêng, không suy từ trạng thái.
  const sql = `WITH c AS MATERIALIZED (
      SELECT ls.id, ls.trang_thai, ${da} AS da FROM lenh_san_xuat ls WHERE ls.trang_thai <> 'HUY'),
    l0 AS MATERIALIZED (SELECT ls.id, ls.da, ${cho} AS cho FROM c ls WHERE ls.trang_thai = 'RELEASE_1' OR ls.da),
    l AS (SELECT id, cho FROM l0 WHERE cho OR da),
    p AS (SELECT DISTINCT l.id AS lenh_id, l.cho, pin.id AS pin_id, pin.ma_hang_id, mh.don_hang_id
      FROM l JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = l.id
      JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
      JOIN phan_in pin ON pin.id = dv.phan_in_id AND pin.dang_hoat_dong
      JOIN ma_hang mh ON mh.id = pin.ma_hang_id)
    SELECT (SELECT count(*) FROM l)::int AS lenh_tong, (SELECT count(*) FROM l WHERE cho)::int AS lenh_cho,
      count(DISTINCT pin_id)::int AS phan_tong, count(DISTINCT pin_id) FILTER (WHERE cho)::int AS phan_cho,
      count(DISTINCT ma_hang_id)::int AS ma_tong, count(DISTINCT ma_hang_id) FILTER (WHERE cho)::int AS ma_cho,
      count(DISTINCT don_hang_id)::int AS don_tong, count(DISTINCT don_hang_id) FILTER (WHERE cho)::int AS don_cho
    FROM p`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim());
  const r = rows[0] || {};
  const bo = (k) => {
    const tong = Number(r[`${k}_tong`]) || 0;
    const choN = Number(r[`${k}_cho`]) || 0;
    return { tong, cho: choN, da: tong - choN };
  };
  return { lenh: bo('lenh'), phan: bo('phan'), ma: bo('ma'), don: bo('don') };
}

module.exports = { dkChoTestSql, dkDaTestSql, demHomNay };
