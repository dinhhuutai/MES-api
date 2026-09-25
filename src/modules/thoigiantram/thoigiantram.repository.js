'use strict';

// THỜI GIAN TỪNG TRẠM (Dashboard › Thời gian trạm — 15/09/2026, KHÔNG migration).
//
// ⚠⚠⚠ NGUỒN MỐC = `utils/siSoTram.js` hằng `DV` — ĐÚNG các nguồn mốc vào/ra mà dải "Theo dõi" của 12
//   màn xác nhận đang dùng (đã kiểm thực bất biến 4 ô trên prod). TUYỆT ĐỐI KHÔNG đo bằng
//   `lich_su_luan_chuyen`: bảng tracking đó HỎNG (READY thiếu mốc vào, OQC/Giao 0 dòng — CLAUDE.md §6).
//   Trang *Lịch sử nghẽn* cũ đang đo bằng bảng hỏng đó nên số thời gian KHÔNG đáng tin.
// ⚠ SQL gửi GỘP 1 DÒNG (IPS) ⇒ không viết comment `-- …` bên trong chuỗi SQL.

const { query } = require('../../config/db');
const { gioSxKhSql } = require('../../utils/slaTheoGio');
const { mauTim } = require('../../utils/timKiem');
const { DV, VN } = require('../../utils/siSoTram');
const { mocDotMucSql, khongReadyTuDongSql, KHUON_OPT_SQL_LIST } = require('../../utils/tech');

// ─── 2 NGUỒN READY RIÊNG CỦA TRANG NÀY — ĐO THEO TỪNG ĐỢT VẢI (22/09/2026) ─────
// ⚠⚠ Nguồn `DV.READY_KT/READY_QC` của sĩ số ở MỨC PHẦN IN: vào = đợt vải MỚI NHẤT lên READY, ra = mốc
//   kỹ thuật/QC của dòng TỔNG ⇒ phần in có 2 đợt thì lấy mốc của đợt này trừ mốc của đợt kia (người
//   dùng báo "thời gian tồn sai"). READY đi theo đợt vải từ 16/09/2026 nên ở đây đo 1 dòng / ĐỢT VẢI:
//   · READY_KT: vào = đợt lên READY · ra = đợt đủ mục KT (Mực + Khuôn; khách II/AD chỉ Mực), hoặc
//     rời READY vì đợt đã được release (lệnh ≠ HUY tạo sớm nhất) — mốc nào tới TRƯỚC.
//   · READY_QC: vào = đợt đủ mục KT · ra = QC xác nhận đợt đó, hoặc đợt được release.
//     Đợt release TRƯỚC khi KT xong ⇒ không hề qua hàng đợi QC ⇒ loại (tg_vao NULL).
// ⚠⚠ `GREATEST(a, NULL)` = a (Postgres BỎ QUA NULL) ⇒ mốc ra PHẢI bọc `CASE WHEN … IS NOT NULL`, nếu
//   không đợt CHƯA xong vẫn có mốc ra = mốc vào và KHÔNG đợt nào hiện "đang ở" (đã mắc khi viết).
// ⚠ CỐ Ý KHÔNG sửa `DV` của sĩ số: dải "Theo dõi" các màn READY vẫn đếm theo phần in như cũ.
const NGUON_READY_DOT = (loai) => `SELECT dv.phan_in_id, dv.ma_dot_vai, dv.han_giao_hang,
    ${loai === 'KT' ? 'dv.tg_chuyen_ready' : 'CASE WHEN m.kt IS NOT NULL AND (rl.moc IS NULL OR rl.moc >= m.kt) THEN m.kt END'} AS tg_vao,
    ${loai === 'KT'
    ? 'CASE WHEN LEAST(m.kt, rl.moc) IS NOT NULL THEN GREATEST(dv.tg_chuyen_ready, LEAST(m.kt, rl.moc)) END'
    : 'CASE WHEN LEAST(m.qc, rl.moc) IS NOT NULL THEN GREATEST(m.kt, LEAST(m.qc, rl.moc)) END'} AS tg_ra,
    NULL::text AS ma_lenh_san_xuat, NULL::text AS ten_chuyen
  FROM dot_vai_ve dv
  JOIN phan_in pin ON pin.id = dv.phan_in_id AND pin.dang_hoat_dong
  JOIN ma_hang zmh ON zmh.id = pin.ma_hang_id
  JOIN don_hang zdh ON zdh.id = zmh.don_hang_id
  JOIN khach_hang zkh ON zkh.id = zdh.khach_hang_id
  LEFT JOIN LATERAL (SELECT
      CASE WHEN z.muc IS NOT NULL AND (zkh.ten_khach_hang IN (${KHUON_OPT_SQL_LIST}) OR z.khuon IS NOT NULL)
           THEN GREATEST(z.muc, CASE WHEN zkh.ten_khach_hang IN (${KHUON_OPT_SQL_LIST}) THEN NULL ELSE z.khuon END) END AS kt,
      z.qc
    FROM (SELECT ${mocDotMucSql('dv', 'dv.phan_in_id', 'MUC')} AS muc,
                 ${mocDotMucSql('dv', 'dv.phan_in_id', 'KHUON')} AS khuon,
                 ${loai === 'KT' ? 'NULL::timestamptz' : mocDotMucSql('dv', 'dv.phan_in_id', 'QC_XAC_NHAN')} AS qc) z
  ) m ON true
  LEFT JOIN LATERAL (SELECT min(xls.created_date) AS moc FROM lenh_sx_dot_vai xlsd
      JOIN lenh_san_xuat xls ON xls.id = xlsd.lenh_san_xuat_id AND xls.trang_thai <> 'HUY'
     WHERE xlsd.dot_vai_ve_id = dv.id) rl ON true
  WHERE dv.trang_thai NOT IN ('DA_GOP','DA_HUY') AND dv.tg_chuyen_ready IS NOT NULL
    AND ${khongReadyTuDongSql('pin.id')}`;

const NGUON = {
  ...DV,
  READY_KT_DOT: NGUON_READY_DOT('KT'),
  READY_QC_DOT: NGUON_READY_DOT('QC'),
};

// Danh mục trạm đo. `donVi` = đơn vị vận hành THẬT của trạm (khóa gom mốc):
//   pin = phần in · dot_vai = đợt vải · lenh = lệnh SX · tem = tem.
// `sla` = nơi lấy SLA trong workflow hiện hành (trạm hoặc checklist); null = trạm không có SLA.
// ⚠ Thứ tự mảng = thứ tự dòng chảy, FE vẽ theo đúng thứ tự này.
// `checklist` = các checklist (bảng `checkpoint`) sổ xuống khi bấm mũi tên ở dòng trạm — CÙNG tập đơn
// vị, chỉ đổi MỐC RA thành lúc xác nhận chính checklist đó ⇒ "chờ Khuôn bao lâu / chờ Mực bao lâu".
// ⚠ Chỉ 3 trạm có checklist trên workflow hiện hành (đo prod 20/09/2026: READY có KHUON/FILM/MUC/
//   QC_XAC_NHAN, TEST_RUN có TEST_CNSP/TEST_QA; các trạm khác KHÔNG có mục con nào) — trạm không khai
//   thì FE ẩn mũi tên. Thêm checklist mới vào workflow ⇒ khai thêm mã ở đây là xong, tên + SLA đọc
//   thẳng từ DB nên không phải sửa gì khác.
// ⚠ `QC_XAC_NHAN` thuộc trạm READY trong DB nhưng gắn vào dòng **READY_QC** (hàng đợi của QC) chứ
//   không phải READY_KT — nếu không, mốc "chờ QC" bị trộn vào thời gian của tổ kỹ thuật.
const TRAM_TG = [
  { ma: 'READY_KT', ten: 'READY — Kỹ thuật', nguon: 'READY_KT_DOT', donVi: 'dot_vai', sla: { tram: 'READY' },
    checklist: ['KHUON', 'FILM', 'MUC'],
    moTa: 'Theo đợt vải · Vào = đợt lên READY · Ra = đợt đủ mục kỹ thuật (hoặc đợt được release)' },
  { ma: 'READY_QC', ten: 'READY — QC xác nhận', nguon: 'READY_QC_DOT', donVi: 'dot_vai', sla: { checkpoint: 'QC_XAC_NHAN' },
    checklist: ['QC_XAC_NHAN'],
    moTa: 'Theo đợt vải · Vào = đợt đủ mục kỹ thuật · Ra = QC xác nhận đợt (hoặc đợt được release)' },
  { ma: 'RELEASE_1', ten: 'Release 1', nguon: 'RELEASE_1', donVi: 'dot_vai', sla: { tram: 'RELEASE_1' },
    moTa: 'Vào = đợt vải lên READY · Ra = release hết SL (hoặc sang Kế hoạch tạm)' },
  { ma: 'KE_HOACH_TAM', ten: 'Kế hoạch tạm', nguon: 'KE_HOACH_TAM', donVi: 'dot_vai', sla: null,
    moTa: 'Vào = lưu kế hoạch tạm · Ra = xác nhận Release 1 / xóa' },
  // ⚠ Gia công đứng NGAY SAU Release 1 (22/09/2026): từ Release 1 hàng rẽ 2 nhánh — gia công HOẶC
  //   Test Run → Release 2 → Sản xuất. Đặt sau Sản xuất như trước là sai dòng chảy.
  { ma: 'GIA_CONG', ten: 'Gia công', nguon: 'GIA_CONG', donVi: 'lenh', sla: null,
    moTa: 'Nhánh rẽ từ Release 1 · Vào = tạo lệnh gia công · Ra = nhận đủ hàng về' },
  { ma: 'TEST_RUN', ten: 'Test Run', nguon: 'TEST_RUN', donVi: 'lenh', sla: { tram: 'TEST_RUN' },
    checklist: ['TEST_CNSP', 'TEST_QA'],
    moTa: 'Vào = tạo lệnh · Ra = QA đạt (hoặc lệnh rời chặng Release 1)' },
  { ma: 'RELEASE_2', ten: 'Release 2', nguon: 'RELEASE_2', donVi: 'lenh', sla: { tram: 'RELEASE_2' },
    moTa: 'Vào = test xong · Ra = duyệt Release 2' },
  { ma: 'SAN_XUAT', ten: 'Sản xuất (chờ chạy + chạy)', nguon: 'SAN_XUAT', donVi: 'lenh', sla: { tram: 'SAN_XUAT' },
    moTa: 'Vào = duyệt Release 2 · Ra = chạy hoàn tất' },
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

// Danh mục checklist của workflow HIỆN HÀNH (tên + SLA) — FE dựng dòng sổ xuống từ đây.
// ⚠ Chỉ lấy checklist `dang_hoat_dong`: trạm READY còn 3 mục đã vô hiệu hóa từ mig 014–016/040
//   (HSKT · XAC_NHAN_KT · TEST_UP), hiện ra là người dùng tưởng còn phải xác nhận.
async function dsChecklist() {
  const { rows } = await query(
    `SELECT cp.ma_checkpoint AS ma, cp.ten_checkpoint AS ten, cp.thoi_gian_quy_dinh_phut AS sla,
            t.ma_tram
       FROM checkpoint cp
       JOIN tram t ON t.id = cp.tram_id
       JOIN workflow_version v ON v.id = t.workflow_version_id AND v.la_hien_hanh
      WHERE cp.dang_hoat_dong
      ORDER BY t.thu_tu, cp.thu_tu`.replace(/\s+/g, ' '));
  return rows;
}

// Danh sách ĐƠN VỊ ở 1 trạm (mỗi dòng = 1 phần in / đợt vải / lệnh / tem tại trạm đó), đã gom mốc theo
// đúng luật `gomTheo` của sĩ số: vào = mốc SỚM NHẤT, ra = CHỈ KHI MỌI dòng con đã rời.
// ⚠ 1 lệnh gộp nhiều đợt vải cho ra nhiều dòng con giống hệt mốc ⇒ gom lại để KHÔNG đếm đôi thời gian.
//
// `maChecklist` (tùy chọn) ⇒ đo THỜI GIAN CHỜ MỘT CHECKLIST thay vì cả trạm:
//   · **CÙNG tập đơn vị, CÙNG bộ lọc, CÙNG mốc VÀO** với dòng trạm cha ⇒ số đơn vị của dòng sổ xuống
//     luôn BẰNG dòng cha, người đọc không phải hỏi "sao con nhiều hơn cha".
//   · Chỉ MỐC RA đổi: lúc xác nhận chính checklist đó (`ket_qua_checkpoint.trang_thai='DAT'`).
// ⚠⚠ 3 ca biên của mốc ra checklist, thiếu ca nào là số vô nghĩa:
//   (a) CHƯA xác nhận mà đơn vị đã rời trạm ⇒ lấy mốc rời của trạm (nó chờ checklist đó tới lúc rời);
//       để NULL là dòng "đang ở trạm" VĨNH VIỄN dù hàng đã đi từ lâu.
//   (b) Xác nhận TRƯỚC khi đơn vị vào trạm (khuôn làm từ đợt vải trước — READY đi theo ĐỢT VẢI từ
//       16/09/2026) ⇒ kẹp về chính mốc vào = 0 phút, KHÔNG để ra số ÂM.
//   (c) Chưa xác nhận và đơn vị còn ở trạm ⇒ NULL ⇒ đồng hồ vẫn chạy (đúng như dòng cha).
async function donViTaiTram(tram, loc = {}, maChecklist = null) {
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

  // Mốc xác nhận checklist. Khóa nối theo ĐƠN VỊ của trạm: mức LỆNH đọc `lenh_san_xuat_id`, còn lại
  // đọc `phan_in_id` (`ket_qua_checkpoint` chỉ có 2 khóa này).
  let clJoin = '';
  let tgRa = 'u.tg_ra';
  let daXacNhan = 'true';
  if (maChecklist && tram.donVi === 'dot_vai') {
    // READY đo theo ĐỢT VẢI ⇒ mốc checklist cũng của CHÍNH đợt đó (không lấy mốc dòng tổng của phần in,
    // mốc đó có thể thuộc đợt khác). ⚠ `maChecklist` luôn là mã khai cứng ở `TRAM_TG` (service chỉ
    // nhận mã trong danh sách) nên nội suy thẳng được.
    clJoin = `LEFT JOIN LATERAL (SELECT ${mocDotMucSql('zdv', 'zdv.phan_in_id', maChecklist)} AS moc
        FROM dot_vai_ve zdv WHERE zdv.ma_dot_vai = u.don_vi LIMIT 1) cl ON true`;
    tgRa = 'CASE WHEN cl.moc IS NULL THEN u.tg_ra WHEN cl.moc < u.tg_vao THEN u.tg_vao ELSE cl.moc END';
    daXacNhan = 'cl.moc IS NOT NULL';
  } else if (maChecklist) {
    params.push(maChecklist);
    const n = `$${params.length}`;
    clJoin = tram.donVi === 'lenh'
      ? `LEFT JOIN LATERAL (SELECT max(k.tg_xac_nhan) AS moc FROM ket_qua_checkpoint k
           JOIN checkpoint c ON c.id = k.checkpoint_id AND c.ma_checkpoint = ${n}
           JOIN lenh_san_xuat xls ON xls.id = k.lenh_san_xuat_id
          WHERE k.trang_thai = 'DAT' AND xls.ma_lenh_san_xuat = u.don_vi) cl ON true`
      : `LEFT JOIN LATERAL (SELECT max(k.tg_xac_nhan) AS moc FROM ket_qua_checkpoint k
           JOIN checkpoint c ON c.id = k.checkpoint_id AND c.ma_checkpoint = ${n}
          WHERE k.trang_thai = 'DAT' AND k.phan_in_id = u.phan_in_id) cl ON true`;
    tgRa = 'CASE WHEN cl.moc IS NULL THEN u.tg_ra WHEN cl.moc < u.tg_vao THEN u.tg_vao ELSE cl.moc END';
    daXacNhan = 'cl.moc IS NOT NULL';
  }

  // Hạn giao chỉ có ở 2 nguồn READY theo đợt (luật SLA theo hạn giao — 25/09/2026).
  const coHan = String(tram.nguon).endsWith('_DOT');
  const sql = `WITH x AS (${NGUON[tram.nguon]}),
    u AS (SELECT x.phan_in_id, ${khoa} AS don_vi,
        ${coDot ? "string_agg(DISTINCT x.ma_dot_vai, ', ')" : 'NULL::text'} AS ma_dot_vai,
        string_agg(DISTINCT x.ma_lenh_san_xuat, ', ') AS ma_lenh_san_xuat,
        string_agg(DISTINCT x.ten_chuyen, ', ') AS ten_chuyen,
        ${coHan ? 'min(x.han_giao_hang)' : 'NULL::date'} AS han_giao_hang,
        min(x.tg_vao) AS tg_vao,
        CASE WHEN count(*) FILTER (WHERE x.tg_ra IS NULL) = 0 THEN max(x.tg_ra) END AS tg_ra
      FROM x WHERE x.phan_in_id IS NOT NULL AND x.tg_vao IS NOT NULL AND ${khoa} IS NOT NULL
      GROUP BY 1, 2)
    SELECT u.phan_in_id, u.don_vi, u.ma_dot_vai, u.ma_lenh_san_xuat, u.ten_chuyen, u.han_giao_hang, u.tg_vao,
      (${tgRa}) AS tg_ra, (${daXacNhan}) AS da_xac_nhan,
      round(EXTRACT(EPOCH FROM (COALESCE((${tgRa}), now()) - u.tg_vao)) / 60)::int AS phut,
      kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim
    FROM u
    ${clJoin}
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

// Giờ SX kế hoạch (`tg_bd_kh`) theo mã lệnh — cho SLA Test Run (`utils/slaTheoGio.js`). Query nhẹ theo khóa.
async function gioSxKeHoach(maLenhs = []) {
  if (!maLenhs.length) return new Map();
  const { rows } = await query(
    `SELECT ma_lenh_san_xuat, ${gioSxKhSql('tg_bd_kh', 'ngay_ke_hoach')} AS tg_bd_kh FROM lenh_san_xuat
      WHERE ma_lenh_san_xuat = ANY($1::text[]) AND (tg_bd_kh IS NOT NULL OR ngay_ke_hoach IS NOT NULL)`.replace(/\s+/g, ' '),
    [maLenhs]
  );
  return new Map(rows.map((r) => [r.ma_lenh_san_xuat, r.tg_bd_kh]));
}

module.exports = { TRAM_TG, TRAN_DONG, dsSla, dsChecklist, donViTaiTram, gioSxKeHoach };
