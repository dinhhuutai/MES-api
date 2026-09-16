'use strict';

// THỜI GIAN TỪNG TRẠM (Dashboard › Thời gian trạm — 15/09/2026, KHÔNG migration).
//
// ⚠⚠⚠ NGUỒN MỐC = `utils/siSoTram.js` hằng `DV` — ĐÚNG các nguồn mốc vào/ra mà dải "Theo dõi" của 12
//   màn xác nhận đang dùng (đã kiểm thực bất biến 4 ô trên prod). TUYỆT ĐỐI KHÔNG đo bằng
//   `lich_su_luan_chuyen`: bảng tracking đó HỎNG (READY thiếu mốc vào, OQC/Giao 0 dòng — CLAUDE.md §6).
//   Trang *Lịch sử nghẽn* cũ đang đo bằng bảng hỏng đó nên số thời gian KHÔNG đáng tin.
// ⚠ SQL gửi GỘP 1 DÒNG (IPS) ⇒ không viết comment `-- …` bên trong chuỗi SQL.

const { query } = require('../../config/db');
const { mauTim } = require('../../utils/timKiem');
const { DV, VN } = require('../../utils/siSoTram');

// Danh mục trạm đo. `donVi` = đơn vị vận hành THẬT của trạm (khóa gom mốc):
//   pin = phần in · dot_vai = đợt vải · lenh = lệnh SX · tem = tem.
// `sla` = nơi lấy SLA trong workflow hiện hành (trạm hoặc checklist); null = trạm không có SLA.
// ⚠ Thứ tự mảng = thứ tự dòng chảy, FE vẽ theo đúng thứ tự này.
const TRAM_TG = [
  { ma: 'READY_KT', ten: 'READY — Kỹ thuật', nguon: 'READY_KT', donVi: 'pin', sla: { tram: 'READY' },
    moTa: 'Vào = đợt vải lên READY · Ra = kỹ thuật xác nhận đủ mục (hoặc phần in rời READY)' },
  { ma: 'READY_QC', ten: 'READY — QC xác nhận', nguon: 'READY_QC', donVi: 'pin', sla: { checkpoint: 'QC_XAC_NHAN' },
    moTa: 'Vào = kỹ thuật xong hết mục · Ra = QC xác nhận READY' },
  { ma: 'RELEASE_1', ten: 'Release 1', nguon: 'RELEASE_1', donVi: 'dot_vai', sla: { tram: 'RELEASE_1' },
    moTa: 'Vào = đợt vải lên READY · Ra = release hết SL (hoặc sang Kế hoạch tạm)' },
  { ma: 'KE_HOACH_TAM', ten: 'Kế hoạch tạm', nguon: 'KE_HOACH_TAM', donVi: 'dot_vai', sla: null,
    moTa: 'Vào = lưu kế hoạch tạm · Ra = xác nhận Release 1 / xóa' },
  { ma: 'TEST_RUN', ten: 'Test Run', nguon: 'TEST_RUN', donVi: 'lenh', sla: { tram: 'TEST_RUN' },
    moTa: 'Vào = tạo lệnh · Ra = QA đạt (hoặc lệnh rời chặng Release 1)' },
  { ma: 'RELEASE_2', ten: 'Release 2', nguon: 'RELEASE_2', donVi: 'lenh', sla: { tram: 'RELEASE_2' },
    moTa: 'Vào = test xong · Ra = duyệt Release 2' },
  { ma: 'SAN_XUAT', ten: 'Sản xuất (chờ chạy + chạy)', nguon: 'SAN_XUAT', donVi: 'lenh', sla: { tram: 'SAN_XUAT' },
    moTa: 'Vào = duyệt Release 2 · Ra = chạy hoàn tất' },
  { ma: 'GIA_CONG', ten: 'Gia công', nguon: 'GIA_CONG', donVi: 'lenh', sla: null,
    moTa: 'Vào = tạo lệnh gia công · Ra = nhận đủ hàng về' },
  { ma: 'CHO_KHO', ten: 'Chờ khô', nguon: 'CHO_KHO', donVi: 'tem', sla: { tram: 'CHO_KHO' },
    moTa: 'Vào = in tem · Ra = tem khô' },
  { ma: 'KIEM', ten: 'KCS', nguon: 'KIEM', donVi: 'tem', sla: { tram: 'KIEM' },
    moTa: 'Vào = tem khô · Ra = kiểm hết' },
  { ma: 'SUA', ten: 'Sửa', nguon: 'SUA', donVi: 'tem', sla: { tram: 'SUA' },
    moTa: 'Vào = KCS có hàng sửa · Ra = sửa hết' },
  { ma: 'OQC', ten: 'OQC', nguon: 'OQC', donVi: 'tem', sla: { tram: 'OQC' },
    moTa: 'Vào = có hàng đạt · Ra = OQC hết' },
  { ma: 'GIAO', ten: 'Chờ giao', nguon: 'GIAO', donVi: 'tem', sla: { tram: 'FINISH' },
    moTa: 'Vào = OQC cho qua giao · Ra = giao hết' },
];

const KHOA = {
  pin: 'x.phan_in_id::text',
  dot_vai: 'x.ma_dot_vai',
  lenh: 'x.ma_lenh_san_xuat',
  tem: 'x.ma_tem',
};

// Trần dòng MỖI TRẠM — phòng người dùng bỏ trống khoảng ngày trên dữ liệu nhiều năm. Chạm trần thì
// service trả cờ `cat` để FE báo "đang thiếu, hãy thu hẹp".
const TRAN_DONG = 5000;

// SLA hiện hành: trạm (phút) + checklist QC.
async function dsSla() {
  const { rows } = await query(
    `SELECT 'TRAM' AS cap, t.ma_tram AS ma, t.thoi_gian_quy_dinh_phut AS sla
       FROM tram t JOIN workflow_version v ON v.id = t.workflow_version_id AND v.la_hien_hanh
     UNION ALL
     SELECT 'CHECKPOINT', cp.ma_checkpoint, cp.thoi_gian_quy_dinh_phut
       FROM checkpoint cp JOIN tram t ON t.id = cp.tram_id
       JOIN workflow_version v ON v.id = t.workflow_version_id AND v.la_hien_hanh
      WHERE cp.dang_hoat_dong`.replace(/\s+/g, ' '));
  return rows;
}

// Danh sách ĐƠN VỊ ở 1 trạm (mỗi dòng = 1 phần in / đợt vải / lệnh / tem tại trạm đó), đã gom mốc theo
// đúng luật `gomTheo` của sĩ số: vào = mốc SỚM NHẤT, ra = CHỈ KHI MỌI dòng con đã rời.
// ⚠ 1 lệnh gộp nhiều đợt vải cho ra nhiều dòng con giống hệt mốc ⇒ gom lại để KHÔNG đếm đôi thời gian.
async function donViTaiTram(tram, loc = {}) {
  const khoa = KHOA[tram.donVi];
  const coDot = tram.donVi !== 'pin'; // 2 nguồn READY dùng `NHAN_TRONG` — không có cột `ma_dot_vai`
  const params = [];
  const dk = [];
  const them = (val, col) => {
    if (!val) return;
    params.push(mauTim(val));
    dk.push(`${col} ~* $${params.length}`);
  };
  them(loc.timKiem, "concat_ws(' ', kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang, pin.ma_phan, pin.mau_vai, u.don_vi, u.ma_dot_vai, u.ma_lenh_san_xuat, u.ten_chuyen)");
  them(loc.khach, 'kh.ten_khach_hang');
  them(loc.don, 'dh.ma_don_hang');
  them(loc.maHang, 'mh.ma_hang');
  them(loc.codePhan, 'pin.ma_phan');
  them(loc.mauVai, 'pin.mau_vai');
  them(loc.chuyen, 'u.ten_chuyen');

  // Khoảng ngày theo MỐC VÀO hoặc MỐC RA (giờ VN). ⚠ Mốc RA ⇒ tự hiểu là chỉ đơn vị ĐÃ rời.
  const cot = loc.loaiMoc === 'RA' ? 'u.tg_ra' : 'u.tg_vao';
  if (loc.tuNgay) { params.push(loc.tuNgay); dk.push(`(${cot} ${VN})::date >= $${params.length}::date`); }
  if (loc.denNgay) { params.push(loc.denNgay); dk.push(`(${cot} ${VN})::date <= $${params.length}::date`); }
  if (loc.trangThai === 'DA_ROI' || loc.loaiMoc === 'RA') dk.push('u.tg_ra IS NOT NULL');
  if (loc.trangThai === 'DANG_O') dk.push('u.tg_ra IS NULL');

  const sql = `WITH x AS (${DV[tram.nguon]}),
    u AS (SELECT x.phan_in_id, ${khoa} AS don_vi,
        ${coDot ? "string_agg(DISTINCT x.ma_dot_vai, ', ')" : 'NULL::text'} AS ma_dot_vai,
        string_agg(DISTINCT x.ma_lenh_san_xuat, ', ') AS ma_lenh_san_xuat,
        string_agg(DISTINCT x.ten_chuyen, ', ') AS ten_chuyen,
        min(x.tg_vao) AS tg_vao,
        CASE WHEN count(*) FILTER (WHERE x.tg_ra IS NULL) = 0 THEN max(x.tg_ra) END AS tg_ra
      FROM x WHERE x.phan_in_id IS NOT NULL AND x.tg_vao IS NOT NULL AND ${khoa} IS NOT NULL
      GROUP BY 1, 2)
    SELECT u.phan_in_id, u.don_vi, u.ma_dot_vai, u.ma_lenh_san_xuat, u.ten_chuyen, u.tg_vao, u.tg_ra,
      round(EXTRACT(EPOCH FROM (COALESCE(u.tg_ra, now()) - u.tg_vao)) / 60)::int AS phut,
      kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim
    FROM u
    JOIN phan_in pin ON pin.id = u.phan_in_id
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    WHERE (u.tg_ra IS NULL OR u.tg_ra >= u.tg_vao)${dk.length ? ` AND ${dk.join(' AND ')}` : ''}
    ORDER BY u.tg_vao DESC
    LIMIT ${TRAN_DONG + 1}`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), params);
  return rows;
}

module.exports = { TRAM_TG, TRAN_DONG, dsSla, donViTaiTram };
