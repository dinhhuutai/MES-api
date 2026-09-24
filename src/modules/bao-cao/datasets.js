'use strict';

// =====================================================================
// NGUỒN DANH SÁCH cho báo cáo tự thiết kế (dataset registry).
// Khác `metrics.js` (1 ô = 1 giá trị vô hướng): mỗi dataset trả về NHIỀU DÒNG × NHIỀU CỘT,
// đổ vào lưới từ 1 ô neo — dựng được các bảng kiểu "Hệ điều hành nhà máy in lụa" / "Test Run" / "Bảng điều phối".
//
// Mỗi def: { ma, ten, mo_ta, don_vi_dong, loc[], cot[{key,ten,kieu}], run({loc, cot, gioi_han}) }
//   loc[]  : mã bộ lọc dataset hỗ trợ — 'ngay' | 'tram' | 'chuyen' | 'khach' | 'tim'
//   kieu   : 'text' | 'so' | 'ngay' — FE dùng để căn lề + định dạng.
// FE chọn cột nào thì CHỈ cột đó được render; SQL vẫn select đủ (bảng nhỏ, đơn giản hơn build động).
//
// ⚠ IPS-safe: gửi SQL 1 dòng (.replace(/\s+/g,' ')), chỉ nối ILIKE khi thực sự có nhập.
// =====================================================================

const { query } = require('../../config/db');
const { slaStatus } = require('../../utils/sla');
const { flowRowsCached } = require('./flowCache');
const { KHUON_OPT_SQL_LIST, KHUON_OPTIONAL_KH, nguoiXacNhanSql, khongReadyTuDongSql, conDotChuaReadySql, dotMucDatSql } = require('../../utils/tech');
const { mauTim } = require('../../utils/timKiem');
const { CP_PHAN_IN } = require('../../utils/siSoTram');

const VN_TODAY = "(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date";
const clean = (v) => (v == null ? '' : String(v).trim());

// Giới hạn số dòng đổ ra lưới (chặn báo cáo phình vô hạn làm treo trình duyệt).
const MAX_ROWS = 500;
const limitOf = (n) => Math.min(Math.max(Number(n) || 100, 1), MAX_ROWS);

// ---- Bộ lọc ngày: '' = không lọc · 'HOM_NAY' = hôm nay · 'YYYY-MM-DD' = ngày cụ thể ----
function ngayCond(col, ngay, isTimestamp) {
  const v = clean(ngay);
  if (!v) return null;
  const left = isTimestamp ? `(${col} AT TIME ZONE 'Asia/Ho_Chi_Minh')::date` : col;
  if (v.toUpperCase() === 'HOM_NAY') return `${left} = ${VN_TODAY}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null; // chỉ nhận YYYY-MM-DD → an toàn khi nội suy
  return `${left} = '${v}'::date`;
}

// ---- 2 CỘT "LOẠI ĐỢT VẢI" + "SL BỔ SUNG" (thêm 2026-09-14) — dùng CHUNG mọi nguồn danh sách ----
// · Loại đợt vải: tên loại (Số lượng / Bổ sung / Mẫu số lượng…); nhiều đợt khác loại ⇒ gộp "A, B".
// · SL bổ sung  : Σ SL vải về của ĐỢT BỔ SUNG (ERP loaikd 5I, mã `BO_SUNG`). Không có đợt bổ sung nào
//   (vd chỉ có 3I) ⇒ "-" (gạch ngang) — `runOne` đổi NULL thành "-" sau khi chạy.
// ⚠ So theo MÃ `loai_dot_vai.ma_loai`, KHÔNG so tên hiển thị.
// · SL thực tính (thêm 21/09/2026): CÓ SL bổ sung > 0 ⇒ Σ SL bổ sung; ngược lại ⇒ Σ SL nhận vải (mọi
//   đợt trong CÙNG phạm vi với "SL bổ sung"). ⚠ LUÔN LÀ SỐ (COALESCE 0) — KHÔNG đổi thành "-" như
//   `sl_bo_sung`, ra chữ là Excel không cộng được (bẫy "ô số phải ghi ra số thật" §6 Báo cáo).
const COT_LOAI_DOT = [
  { key: 'loai_dot_vai', ten: 'Loại đợt vải', kieu: 'text' },
  { key: 'sl_bo_sung', ten: 'SL bổ sung', kieu: 'so' },
  { key: 'sl_thuc_tinh', ten: 'SL thực tính', kieu: 'so' },
];
const LOAI_DOT_LOC = "dvl.trang_thai NOT IN ('DA_GOP','DA_HUY')";
const LOAI_DOT_JOIN = 'LEFT JOIN loai_dot_vai ldl ON ldl.id = dvl.loai_dot_vai_id';
const SUM_BO_SUNG = "sum(dvl.so_luong_vai_ve) FILTER (WHERE ldl.ma_loai = 'BO_SUNG')";
const SL_THUC_TINH_EXPR = `(CASE WHEN COALESCE(${SUM_BO_SUNG},0) > 0 THEN ${SUM_BO_SUNG}
    ELSE COALESCE(sum(dvl.so_luong_vai_ve),0) END)::int`;
// Nguồn đợt vải của 2 phạm vi — dùng CHUNG cho cột + bộ lọc "nhóm bổ sung" để 2 thứ không lệch nhau.
const FROM_DOT_PIN = (pinCol) => `FROM dot_vai_ve dvl ${LOAI_DOT_JOIN}
    WHERE dvl.phan_in_id = ${pinCol} AND ${LOAI_DOT_LOC}`;
const FROM_DOT_LENH = (lenhCol) => `FROM lenh_sx_dot_vai lsl JOIN dot_vai_ve dvl ON dvl.id = lsl.dot_vai_ve_id
    ${LOAI_DOT_JOIN} WHERE lsl.lenh_san_xuat_id = ${lenhCol}`;
const slThucTinhTheoPin = (pinCol) => `(SELECT ${SL_THUC_TINH_EXPR} ${FROM_DOT_PIN(pinCol)})`;
// Theo PHẦN IN (mọi đợt vải còn hiệu lực).
const loaiDotTheoPin = (pinCol) => `
  (SELECT string_agg(DISTINCT ldl.ten_loai, ', ') ${FROM_DOT_PIN(pinCol)}) AS loai_dot_vai,
  (SELECT (${SUM_BO_SUNG})::int ${FROM_DOT_PIN(pinCol)}) AS sl_bo_sung,
  ${slThucTinhTheoPin(pinCol)} AS sl_thuc_tinh`;
// Theo LỆNH SX (các đợt vải gắn vào lệnh qua lenh_sx_dot_vai).
const loaiDotTheoLenh = (lenhCol) => `
  (SELECT string_agg(DISTINCT ldl.ten_loai, ', ') ${FROM_DOT_LENH(lenhCol)}) AS loai_dot_vai,
  (SELECT (${SUM_BO_SUNG})::int ${FROM_DOT_LENH(lenhCol)}) AS sl_bo_sung,
  (SELECT ${SL_THUC_TINH_EXPR} ${FROM_DOT_LENH(lenhCol)}) AS sl_thuc_tinh`;

// BỘ LỌC "Nhóm bổ sung" (21/09/2026): CO = có đợt bổ sung SL > 0 · KHONG = ngược lại. Cùng phạm vi đợt
// với cột ⇒ 2 nhóm PHỦ KÍN, không trùng, và khớp đúng nhánh CASE của `sl_thuc_tinh`.
// ⚠ Phải là EXISTS riêng — `sl_bo_sung` là subquery trong SELECT, KHÔNG dùng được trong WHERE cùng cấp.
const coBoSung = (fromSql) => `EXISTS (SELECT 1 ${fromSql} AND ldl.ma_loai = 'BO_SUNG' AND dvl.so_luong_vai_ve > 0)`;
function dkNhomBoSung(loc, fromSql) {
  const v = clean(loc.nhom_bo_sung).toUpperCase();
  if (v === 'CO') return coBoSung(fromSql);
  if (v === 'KHONG') return `NOT ${coBoSung(fromSql)}`;
  return null;
}

// ============================== 1) PHẦN IN / ĐỢT VẢI ==============================
// 1 dòng = 1 đợt vải của phần in (kèm trạm hiện tại + SLA) → sheet "HỆ ĐIỀU HÀNH NHÀ MÁY IN LỤA".
const COT_PHAN_IN = [
  { key: 'stt', ten: 'STT', kieu: 'so' },
  { key: 'ngay_vai_ve', ten: 'Ngày', kieu: 'ngay' },
  { key: 'ten_khach_hang', ten: 'KH', kieu: 'text' },
  { key: 'ma_don_hang', ten: 'PO', kieu: 'text' },
  { key: 'ma_phan', ten: 'Code phần', kieu: 'text' },
  { key: 'ma_hang', ten: 'Mã hàng', kieu: 'text' },
  { key: 'mau_vai', ten: 'Màu vải', kieu: 'text' },
  { key: 'kich_vai', ten: 'Kích vải', kieu: 'text' },
  { key: 'kich_phim', ten: 'Kích film', kieu: 'text' },
  { key: 'tinh_chat_in', ten: 'TC IN', kieu: 'text' },
  { key: 'so_luong_don_hang', ten: 'SLĐH', kieu: 'so' },
  { key: 'so_luong_vai_ve', ten: 'SL nhận vải', kieu: 'so' },
  { key: 'han_giao_hang', ten: 'Hạn giao', kieu: 'ngay' },
  { key: 'ma_dot_vai', ten: 'Mã đợt vải', kieu: 'text' },
  { key: 'loai_dot_vai', ten: 'Loại đợt vải', kieu: 'text' },
  { key: 'sl_bo_sung', ten: 'SL bổ sung', kieu: 'so' },
  // ⚠ Nguồn này 1 dòng = 1 ĐỢT VẢI; tính ở mức đợt thì SL thực tính luôn = SL của chính đợt (vô nghĩa)
  //   ⇒ người dùng chốt 21/09/2026 tính theo PHẦN IN của dòng — mọi dòng cùng phần in ra CÙNG số.
  { key: 'sl_thuc_tinh', ten: 'SL thực tính (theo phần in)', kieu: 'so' },
  // --- Chuẩn bị kỹ thuật (READY): lựa chọn đã xác nhận từng mục (gia_tri_text của ket_qua_checkpoint DAT) ---
  { key: 'ready_khuon', ten: 'Khuôn (READY)', kieu: 'text' },
  { key: 'ready_film', ten: 'Film (READY)', kieu: 'text' },
  { key: 'ready_muc', ten: 'Mực (READY)', kieu: 'text' },
  { key: 'ready_qc', ten: 'QC READY', kieu: 'text' },
  { key: 'ten_tram', ten: 'Trạm hiện tại', kieu: 'text' },
  { key: 'phut_da_o', ten: 'Số phút đã ở trạm', kieu: 'so' },
  { key: 'sla_status', ten: 'Tình trạng SLA', kieu: 'text' },
];

// Lựa chọn READY đã xác nhận (DAT) của 1 checkpoint theo phần in → gia_tri_text (Khuôn/Film/Mực).
const readyChoiceSub = (maCp) =>
  `(SELECT kq.gia_tri_text FROM ket_qua_checkpoint kq JOIN checkpoint cp ON cp.id = kq.checkpoint_id
     WHERE kq.phan_in_id = pin.id AND cp.ma_checkpoint = '${maCp}' AND kq.trang_thai = 'DAT'
     ORDER BY kq.tg_xac_nhan DESC NULLS LAST LIMIT 1)`;

const SLA_LABEL = { NGHEN: 'Nghẽn', SAP_NGHEN: 'Sắp nghẽn', OK: 'Đúng hạn' };

async function runPhanIn({ loc = {}, gioi_han }) {
  const params = [];
  const conds = ["dv.trang_thai NOT IN ('DA_GOP','DA_HUY')", 'pin.dang_hoat_dong'];
  const nc = ngayCond('dv.ngay_vai_ve', loc.ngay, false);
  if (nc) conds.push(nc);
  const nb = dkNhomBoSung(loc, FROM_DOT_PIN('pin.id'));
  if (nb) conds.push(nb);
  if (clean(loc.khach)) { params.push(mauTim(loc.khach)); conds.push(`kh.ten_khach_hang ~* $${params.length}`); }
  if (clean(loc.tim)) {
    params.push(mauTim(loc.tim));
    const i = params.length;
    conds.push(`(pin.ma_phan ~* $${i} OR mh.ma_hang ~* $${i} OR dh.ma_don_hang ~* $${i} OR pin.mau_vai ~* $${i})`);
  }
  const sql = `
    SELECT dv.id AS dot_vai_ve_id, pin.id AS phan_in_id, dv.ma_dot_vai,
           to_char(dv.ngay_vai_ve, 'DD/MM/YYYY') AS ngay_vai_ve,
           to_char(dv.han_giao_hang, 'DD/MM/YYYY') AS han_giao_hang,
           dv.so_luong_vai_ve, ldv.ten_loai AS loai_dot_vai,
           (CASE WHEN ldv.ma_loai = 'BO_SUNG' THEN dv.so_luong_vai_ve END) AS sl_bo_sung,
           ${slThucTinhTheoPin('pin.id')} AS sl_thuc_tinh,
           pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.tinh_chat_in, pin.so_luong_don_hang,
           mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang,
           ${readyChoiceSub('KHUON')} AS ready_khuon,
           ${readyChoiceSub('FILM')} AS ready_film,
           ${readyChoiceSub('MUC')} AS ready_muc,
           (CASE WHEN EXISTS (SELECT 1 FROM ket_qua_checkpoint kq JOIN checkpoint cp ON cp.id = kq.checkpoint_id
              WHERE kq.phan_in_id = pin.id AND cp.ma_checkpoint = 'QC_XAC_NHAN' AND kq.trang_thai = 'DAT')
              THEN 'Đã QC' ELSE '' END) AS ready_qc
    FROM dot_vai_ve dv
    JOIN phan_in pin ON pin.id = dv.phan_in_id
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    LEFT JOIN loai_dot_vai ldv ON ldv.id = dv.loai_dot_vai_id
    WHERE ${conds.join(' AND ')}
    ORDER BY dv.ngay_vai_ve DESC NULLS LAST, kh.ten_khach_hang, dh.ma_don_hang, pin.ma_phan
    LIMIT ${limitOf(gioi_han)}`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), params);

  // Gắn trạm hiện tại + SLA từ flowRows (đúng nguồn dashboard). Lọc trạm sau khi gắn.
  const flow = await flowRowsCached();
  const byDot = new Map(flow.map((f) => [f.dot_vai_ve_id, f]));
  let out = rows.map((r) => {
    const f = byDot.get(r.dot_vai_ve_id);
    const st = f ? slaStatus(f.phut_da_o, f.sla_phut, f.canh_bao_truoc_phut) : null;
    return {
      ...r,
      ma_tram: f ? f.ma_tram : null,
      ten_tram: f ? f.ten_tram : '—',
      phut_da_o: f ? f.phut_da_o : null,
      sla_status: st ? SLA_LABEL[st] : '—',
    };
  });
  const tram = clean(loc.tram);
  if (tram) out = out.filter((r) => r.ma_tram === tram);
  return out.map((r, i) => ({ ...r, stt: i + 1 }));
}

// ============================== 2) ĐỢT SẢN XUẤT / LỆNH SX ==============================
// 1 dòng = 1 lệnh SX (đợt sản xuất) → sheet "TEST RUN BÀN A/B/MÁY TỰ ĐỘNG".
const COT_DOT_SX = [
  { key: 'stt', ten: 'STT', kieu: 'so' },
  { key: 'ngay_ke_hoach', ten: 'Ngày', kieu: 'ngay' },
  { key: 'ten_chuyen', ten: 'Chuyền', kieu: 'text' },
  { key: 'ten_khach_hang', ten: 'Khách hàng', kieu: 'text' },
  { key: 'ma_don_hang', ten: 'PO', kieu: 'text' },
  { key: 'ma_phan', ten: 'Code phần', kieu: 'text' },
  { key: 'ma_hang', ten: 'Mã hàng', kieu: 'text' },
  { key: 'mau_vai', ten: 'Màu vải', kieu: 'text' },
  { key: 'kich_vai', ten: 'Kích vải', kieu: 'text' },
  { key: 'kich_phim', ten: 'Kích film', kieu: 'text' },
  { key: 'tinh_chat_in', ten: 'TC IN', kieu: 'text' },
  { key: 'ma_lenh_san_xuat', ten: 'Mã lệnh (LSX)', kieu: 'text' },
  { key: 'so_luong_don_hang', ten: 'SLĐH', kieu: 'so' },
  { key: 'so_luong_release', ten: 'SL release', kieu: 'so' },
  ...COT_LOAI_DOT,
  { key: 'gio_bd', ten: 'Giờ bắt đầu', kieu: 'text' },
  { key: 'gio_kt', ten: 'Giờ kết thúc', kieu: 'text' },
  // --- Test Run ---
  { key: 'test_ket_qua', ten: 'Kết quả test', kieu: 'text' },
  { key: 'so_lan_test', ten: 'Số lần test', kieu: 'so' },
  { key: 'nguoi_test', ten: 'Người test', kieu: 'text' },
  { key: 'loai_test', ten: 'Loại test', kieu: 'text' },
  { key: 'test_tg', ten: 'Thời gian test', kieu: 'text' },
  { key: 'test_ghi_chu', ten: 'Ghi chú test', kieu: 'text' },
  { key: 'trang_thai', ten: 'Trạng thái', kieu: 'text' },
  { key: 'han_giao_hang', ten: 'Hạn giao', kieu: 'ngay' },
  { key: 'sl_da_in', ten: 'SL đã in', kieu: 'so' },
];

const LOAI_TEST_LABEL = { TEST_RUN: 'Test Run', DAP_PHAN: 'Đập phần' };

const LSX_TT = {
  RELEASE_1: 'Release 1', RELEASE_2: 'Release 2 (chờ chạy)', SAN_XUAT: 'Đang sản xuất',
  HOAN_TAT: 'Hoàn tất', CHO_IN_XONG: 'Chờ in xong (ép ủi)', HUY: 'Hủy',
};

async function runDotSanXuat({ loc = {}, gioi_han }) {
  const params = [];
  const conds = ["ls.trang_thai <> 'HUY'"];
  const nc = ngayCond('ls.ngay_ke_hoach', loc.ngay, false);
  if (nc) conds.push(nc);
  const nb = dkNhomBoSung(loc, FROM_DOT_LENH('ls.id'));
  if (nb) conds.push(nb);
  if (clean(loc.chuyen)) { params.push(mauTim(loc.chuyen)); conds.push(`cs.ten_chuyen ~* $${params.length}`); }
  if (clean(loc.trang_thai)) { params.push(clean(loc.trang_thai)); conds.push(`ls.trang_thai = $${params.length}`); }
  if (clean(loc.tim)) {
    params.push(mauTim(loc.tim));
    const i = params.length;
    conds.push(`(ls.ma_lenh_san_xuat ~* $${i} OR info.ma_phan ~* $${i} OR info.ma_hang ~* $${i} OR info.mau_vai ~* $${i})`);
  }
  const sql = `
    SELECT ls.id, ls.ma_lenh_san_xuat, ls.so_luong_release, ls.trang_thai AS tt, ${loaiDotTheoLenh('ls.id')},
           to_char(ls.ngay_ke_hoach, 'DD/MM/YYYY') AS ngay_ke_hoach,
           to_char(ls.tg_bd_kh AT TIME ZONE 'Asia/Ho_Chi_Minh', 'HH24:MI') AS gio_bd,
           to_char(ls.tg_kt_kh AT TIME ZONE 'Asia/Ho_Chi_Minh', 'HH24:MI') AS gio_kt,
           (SELECT count(*) FROM test_run tr WHERE tr.lenh_san_xuat_id = ls.id AND tr.ket_qua IS DISTINCT FROM 'HUY')::int AS so_lan_test,
           (SELECT kq.gia_tri_text FROM ket_qua_checkpoint kq JOIN checkpoint cp ON cp.id = kq.checkpoint_id
              WHERE kq.lenh_san_xuat_id = ls.id AND cp.ma_checkpoint = 'TEST_CNSP' AND kq.trang_thai = 'DAT' LIMIT 1) AS nguoi_test,
           (SELECT kq.gia_tri_text FROM ket_qua_checkpoint kq JOIN checkpoint cp ON cp.id = kq.checkpoint_id
              WHERE kq.lenh_san_xuat_id = ls.id AND cp.ma_checkpoint = 'TEST_QA' AND kq.trang_thai = 'DAT' LIMIT 1) AS loai_test_raw,
           (SELECT kq.ghi_chu FROM ket_qua_checkpoint kq JOIN checkpoint cp ON cp.id = kq.checkpoint_id
              WHERE kq.lenh_san_xuat_id = ls.id AND cp.ma_checkpoint = 'TEST_QA' AND kq.trang_thai = 'DAT' LIMIT 1) AS test_ghi_chu,
           (SELECT to_char(kq.tg_xac_nhan AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY HH24:MI') FROM ket_qua_checkpoint kq
              JOIN checkpoint cp ON cp.id = kq.checkpoint_id
              WHERE kq.lenh_san_xuat_id = ls.id AND cp.ma_checkpoint = 'TEST_QA' AND kq.trang_thai = 'DAT' LIMIT 1) AS test_tg,
           cs.ten_chuyen,
           info.ten_khach_hang, info.ma_don_hang, info.ma_hang, info.ma_phan,
           info.mau_vai, info.kich_vai, info.kich_phim, info.tinh_chat_in, info.so_luong_don_hang,
           to_char((SELECT min(dvh.han_giao_hang) FROM lenh_sx_dot_vai lsh JOIN dot_vai_ve dvh ON dvh.id = lsh.dot_vai_ve_id
              WHERE lsh.lenh_san_xuat_id = ls.id), 'DD/MM/YYYY') AS han_giao_hang,
           (SELECT COALESCE(sum(t.so_luong),0)::int FROM phieu_san_xuat ps JOIN tem t ON t.phieu_san_xuat_id = ps.id
              WHERE ps.lenh_san_xuat_id = ls.id AND t.trang_thai <> 'HUY') AS sl_da_in
    FROM lenh_san_xuat ls
    LEFT JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
    LEFT JOIN LATERAL (
      SELECT kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang,
             pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.ma_phan, pin.tinh_chat_in, pin.so_luong_don_hang
      FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
      JOIN phan_in pin ON pin.id = dv.phan_in_id AND pin.dang_hoat_dong
      JOIN ma_hang mh ON mh.id = pin.ma_hang_id
      JOIN don_hang dh ON dh.id = mh.don_hang_id
      JOIN khach_hang kh ON kh.id = dh.khach_hang_id
      WHERE lsd.lenh_san_xuat_id = ls.id ORDER BY pin.ma_phan LIMIT 1
    ) info ON true
    WHERE ${conds.join(' AND ')} AND info.ma_phan IS NOT NULL
    ORDER BY ls.ngay_ke_hoach DESC NULLS LAST, cs.ten_chuyen NULLS LAST, ls.created_date DESC
    LIMIT ${limitOf(gioi_han)}`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), params);
  return rows.map((r, i) => {
    const daTest = !!r.loai_test_raw; // có TEST_QA DAT = đã test đạt
    const boTest = !daTest && ['RELEASE_2', 'SAN_XUAT', 'HOAN_TAT'].includes(r.tt); // vào thẳng R2 = bỏ test run
    return {
      ...r, stt: i + 1, trang_thai: LSX_TT[r.tt] || r.tt,
      loai_test: LOAI_TEST_LABEL[r.loai_test_raw] || r.loai_test_raw || '',
      test_ket_qua: daTest ? 'Đạt' : boTest ? 'Bỏ test run' : (r.tt === 'RELEASE_1' ? 'Chờ test' : ''),
    };
  });
}

// ============================== 2b) TEST RUN HÔM NAY (có mặt / đã test) ==============================
// 1 dòng = 1 lệnh SX liên quan Test Run. Gồm 2 nhóm:
//   - "Có mặt ở Test Run" (đang chờ test): lệnh RELEASE_1 CHƯA có TEST_QA đạt → đang ở Test Run.
//   - "Đã test run": lệnh có TEST_QA đạt (lọc theo NGÀY test) → kèm kết quả + thông tin test của QC.
// Lọc Ngày = Hôm nay ⇒ danh sách "đã test run HÔM NAY"; nhánh "có mặt/chờ test" là snapshot hiện tại (không theo ngày).
const COT_TEST_RUN = [
  { key: 'stt', ten: 'STT', kieu: 'so' },
  { key: 'tinh_trang', ten: 'Tình trạng', kieu: 'text' },
  { key: 'ngay_test', ten: 'Ngày test', kieu: 'text' },
  { key: 'ten_chuyen', ten: 'Chuyền', kieu: 'text' },
  { key: 'ten_khach_hang', ten: 'Khách hàng', kieu: 'text' },
  { key: 'ma_don_hang', ten: 'PO', kieu: 'text' },
  { key: 'ma_phan', ten: 'Code phần', kieu: 'text' },
  { key: 'ma_hang', ten: 'Mã hàng', kieu: 'text' },
  { key: 'mau_vai', ten: 'Màu vải', kieu: 'text' },
  { key: 'kich_vai', ten: 'Kích vải', kieu: 'text' },
  { key: 'kich_phim', ten: 'Kích film', kieu: 'text' },
  { key: 'tinh_chat_in', ten: 'TC IN', kieu: 'text' },
  { key: 'ma_lenh_san_xuat', ten: 'Mã lệnh (LSX)', kieu: 'text' },
  { key: 'so_luong_don_hang', ten: 'SLĐH', kieu: 'so' },
  { key: 'so_luong_release', ten: 'SL release', kieu: 'so' },
  ...COT_LOAI_DOT,
  // --- Kết quả + thông tin test của QC ---
  { key: 'test_ket_qua', ten: 'Kết quả test', kieu: 'text' },
  { key: 'nguoi_test', ten: 'Người test', kieu: 'text' },
  { key: 'loai_test', ten: 'Loại test', kieu: 'text' },
  { key: 'so_lan_test', ten: 'Số lần test', kieu: 'so' },
  { key: 'nguoi_qa', ten: 'QC xác nhận', kieu: 'text' },
  { key: 'test_tg', ten: 'Thời gian test', kieu: 'text' },
  { key: 'test_ghi_chu', ten: 'Ghi chú test', kieu: 'text' },
  { key: 'ngay_ke_hoach', ten: 'Ngày SX kế hoạch', kieu: 'ngay' },
  { key: 'han_giao_hang', ten: 'Hạn giao', kieu: 'ngay' },
];

async function runTestRun({ loc = {}, gioi_han }) {
  const params = [];
  const conds = ["ls.trang_thai <> 'HUY'", 'info.ma_phan IS NOT NULL'];
  const nb = dkNhomBoSung(loc, FROM_DOT_LENH('ls.id'));
  if (nb) conds.push(nb);
  if (clean(loc.chuyen)) { params.push(mauTim(loc.chuyen)); conds.push(`cs.ten_chuyen ~* $${params.length}`); }
  if (clean(loc.tim)) {
    params.push(mauTim(loc.tim));
    const i = params.length;
    conds.push(`(ls.ma_lenh_san_xuat ~* $${i} OR info.ma_phan ~* $${i} OR info.ma_hang ~* $${i} OR info.mau_vai ~* $${i})`);
  }
  // Nhánh "đã test" lọc theo NGÀY xác nhận TEST_QA — MẶC ĐỊNH (để trống) = HÔM NAY (dataset "Test Run hôm nay").
  // Nhánh "có mặt/chờ test" là snapshot HIỆN TẠI (không theo ngày) → luôn hiện lệnh đang chờ test ở Test Run.
  const dayVal = clean(loc.ngay) || 'HOM_NAY';
  const daTestDate = ngayCond('tq.tg', dayVal, true);
  const coMat = `(ls.trang_thai = 'RELEASE_1' AND tq.tg IS NULL)`;
  const daTest = `(tq.tg IS NOT NULL AND ${daTestDate})`;
  const loai = clean(loc.loai_ds).toUpperCase();
  if (loai === 'CO_MAT') conds.push(coMat);
  else if (loai === 'DA_TEST') conds.push(daTest);
  else conds.push(`(${coMat} OR ${daTest})`);

  const sql = `
    SELECT ls.ma_lenh_san_xuat, ls.so_luong_release, ${loaiDotTheoLenh('ls.id')},
           to_char(ls.ngay_ke_hoach, 'DD/MM/YYYY') AS ngay_ke_hoach,
           (CASE WHEN tq.tg IS NULL THEN 'Đang chờ test' ELSE 'Đã test' END) AS tinh_trang,
           (CASE WHEN tq.tg IS NULL THEN 'Chờ test' ELSE 'Đạt' END) AS test_ket_qua,
           to_char(tq.tg AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY HH24:MI') AS test_tg,
           to_char(tq.tg AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY') AS ngay_test,
           tq.loai_raw AS loai_test_raw, tq.ghi_chu AS test_ghi_chu, nqa.ho_ten AS nguoi_qa,
           tc.nguoi AS nguoi_test,
           (SELECT count(*) FROM test_run tr WHERE tr.lenh_san_xuat_id = ls.id AND tr.ket_qua IS DISTINCT FROM 'HUY')::int AS so_lan_test,
           to_char((SELECT min(dvh.han_giao_hang) FROM lenh_sx_dot_vai lsh JOIN dot_vai_ve dvh ON dvh.id = lsh.dot_vai_ve_id
              WHERE lsh.lenh_san_xuat_id = ls.id), 'DD/MM/YYYY') AS han_giao_hang,
           cs.ten_chuyen,
           info.ten_khach_hang, info.ma_don_hang, info.ma_hang, info.ma_phan,
           info.mau_vai, info.kich_vai, info.kich_phim, info.tinh_chat_in, info.so_luong_don_hang
    FROM lenh_san_xuat ls
    LEFT JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
    LEFT JOIN LATERAL (
      SELECT kq.tg_xac_nhan AS tg, kq.gia_tri_text AS loai_raw, kq.ghi_chu, kq.nguoi_xac_nhan_id
      FROM ket_qua_checkpoint kq JOIN checkpoint cp ON cp.id = kq.checkpoint_id
      WHERE kq.lenh_san_xuat_id = ls.id AND cp.ma_checkpoint = 'TEST_QA' AND kq.trang_thai = 'DAT'
      ORDER BY kq.tg_xac_nhan DESC NULLS LAST LIMIT 1
    ) tq ON true
    LEFT JOIN LATERAL (
      SELECT kq.gia_tri_text AS nguoi FROM ket_qua_checkpoint kq JOIN checkpoint cp ON cp.id = kq.checkpoint_id
      WHERE kq.lenh_san_xuat_id = ls.id AND cp.ma_checkpoint = 'TEST_CNSP' AND kq.trang_thai = 'DAT'
      ORDER BY kq.tg_xac_nhan DESC NULLS LAST LIMIT 1
    ) tc ON true
    LEFT JOIN nguoi_dung nqa ON nqa.id = tq.nguoi_xac_nhan_id
    LEFT JOIN LATERAL (
      SELECT kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang,
             pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.ma_phan, pin.tinh_chat_in, pin.so_luong_don_hang
      FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
      JOIN phan_in pin ON pin.id = dv.phan_in_id AND pin.dang_hoat_dong
      JOIN ma_hang mh ON mh.id = pin.ma_hang_id
      JOIN don_hang dh ON dh.id = mh.don_hang_id
      JOIN khach_hang kh ON kh.id = dh.khach_hang_id
      WHERE lsd.lenh_san_xuat_id = ls.id ORDER BY pin.ma_phan LIMIT 1
    ) info ON true
    WHERE ${conds.join(' AND ')}
    ORDER BY tq.tg DESC NULLS LAST, ls.ngay_ke_hoach DESC NULLS LAST, ls.created_date DESC
    LIMIT ${limitOf(gioi_han)}`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), params);
  return rows.map((r, i) => ({
    ...r, stt: i + 1,
    loai_test: LOAI_TEST_LABEL[r.loai_test_raw] || r.loai_test_raw || '',
  }));
}

// ============================== 3) TEM (KCS / Sửa / OQC / Giao) ==============================
const COT_TEM = [
  { key: 'stt', ten: 'STT', kieu: 'so' },
  { key: 'ma_tem', ten: 'Mã tem', kieu: 'text' },
  { key: 'ngay_in_tem', ten: 'Ngày in tem', kieu: 'ngay' },
  { key: 'ten_chuyen', ten: 'Chuyền', kieu: 'text' },
  { key: 'ten_khach_hang', ten: 'Khách hàng', kieu: 'text' },
  { key: 'ma_don_hang', ten: 'PO', kieu: 'text' },
  { key: 'ma_hang', ten: 'Mã hàng', kieu: 'text' },
  { key: 'mau_vai', ten: 'Màu vải', kieu: 'text' },
  { key: 'kich_vai', ten: 'Kích vải', kieu: 'text' },
  { key: 'so_luong_don_hang', ten: 'SLĐH', kieu: 'so' },
  ...COT_LOAI_DOT,
  { key: 'so_luong', ten: 'SL in', kieu: 'so' },
  { key: 'sl_kcs_dat', ten: 'KCS đạt', kieu: 'so' },
  { key: 'sl_kcs_sua', ten: 'Chuyển sửa', kieu: 'so' },
  { key: 'sl_kcs_huy', ten: 'Hủy (KCS)', kieu: 'so' },
  { key: 'sl_sua_dat', ten: 'Sửa đạt', kieu: 'so' },
  { key: 'sl_sua_huy', ten: 'Sửa hủy', kieu: 'so' },
  { key: 'sl_oqc_dat', ten: 'OQC đạt', kieu: 'so' },
  { key: 'sl_da_giao', ten: 'SL đã giao', kieu: 'so' },
  { key: 'trang_thai', ten: 'Trạng thái', kieu: 'text' },
];

const TEM_TT = {
  IN: 'Đã in', DANG_PHOI: 'Đang phơi', DA_KHO: 'Đã khô (chờ kiểm)', CHO_SUA: 'Chờ sửa',
  CHO_OQC: 'Chờ OQC', OQC_DAT: 'OQC đạt (chờ giao)', DA_GIAO: 'Đã giao', LOAI: 'Loại/hủy', HUY: 'Hủy',
};

async function runTem({ loc = {}, gioi_han }) {
  const params = [];
  const conds = ["t.trang_thai <> 'HUY'"];
  const nc = ngayCond('t.created_date', loc.ngay, true);
  if (nc) conds.push(nc);
  const nb = dkNhomBoSung(loc, FROM_DOT_LENH('ls.id'));
  if (nb) conds.push(nb);
  if (clean(loc.trang_thai)) { params.push(clean(loc.trang_thai)); conds.push(`t.trang_thai = $${params.length}`); }
  if (clean(loc.chuyen)) { params.push(mauTim(loc.chuyen)); conds.push(`cs.ten_chuyen ~* $${params.length}`); }
  if (clean(loc.tim)) {
    params.push(mauTim(loc.tim));
    const i = params.length;
    conds.push(`(t.ma_tem ~* $${i} OR info.ma_phan ~* $${i} OR info.ma_hang ~* $${i})`);
  }
  const sql = `
    SELECT t.id, t.ma_tem, t.so_luong, t.trang_thai AS tt, ${loaiDotTheoLenh('ls.id')},
           to_char(t.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY') AS ngay_in_tem,
           t.sl_kcs_dat, t.sl_kcs_sua, t.sl_kcs_huy, t.sl_sua_dat, t.sl_sua_huy, t.sl_oqc_dat, t.sl_da_giao,
           cs.ten_chuyen, info.ten_khach_hang, info.ma_don_hang, info.ma_hang, info.ma_phan, info.mau_vai, info.kich_vai, info.so_luong_don_hang
    FROM tem t
    JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
    JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
    LEFT JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
    LEFT JOIN LATERAL (
      SELECT kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.so_luong_don_hang
      FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
      JOIN phan_in pin ON pin.id = dv.phan_in_id AND pin.dang_hoat_dong
      JOIN ma_hang mh ON mh.id = pin.ma_hang_id
      JOIN don_hang dh ON dh.id = mh.don_hang_id
      JOIN khach_hang kh ON kh.id = dh.khach_hang_id
      WHERE lsd.lenh_san_xuat_id = ls.id ORDER BY pin.ma_phan LIMIT 1
    ) info ON true
    WHERE ${conds.join(' AND ')}
    ORDER BY t.created_date DESC
    LIMIT ${limitOf(gioi_han)}`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), params);
  return rows.map((r, i) => ({ ...r, stt: i + 1, trang_thai: TEM_TT[r.tt] || r.tt }));
}

// ============================== 3b) HOÀN THÀNH / RỜI CHECKPOINT (theo ngày) ==============================
// 1 dòng = 1 lượt PHẦN IN rời (hoàn thành) 1 checkpoint. Nguồn `lich_su_luan_chuyen` (best-effort như metric
// CP_*_ROI_HOM_NAY). Lọc trạm=READY + ngày=Hôm nay ⇒ "danh sách ready đã hoàn thành hôm nay".
// ⚠⚠⚠ NGUỒN MỐC VÀO/RỜI CHECKPOINT — ĐỔI 16/08/2026, KHÔNG CÒN `lich_su_luan_chuyen`.
// Bảng đó là tracking best-effort và thực tế HỎNG (đo prod: READY 2038/2038 thiếu mốc vào, OQC/Giao
// 0 dòng, chỉ 8/14 trạm, ghi cuối 14/08) ⇒ 2 dataset này trả danh sách RỖNG dù xưởng vẫn chạy.
// Nay lấy từ `utils/siSoTram.js` `CP_PHAN_IN` — mốc SỰ KIỆN nghiệp vụ, cùng nguồn với "sĩ số" ở 11
// màn xác nhận và với metric `CP_*` ⇒ Báo cáo không còn đá nhau với màn thao tác. Chi tiết: DATABASE.md §7.
//
// ⚠ Không lọc trạm ⇒ UNION ALL cả 10 trạm (đo prod ~0,8s tổng). Lọc 1 trạm thì chỉ chạy 1 nhánh.
// ⚠ Tên trạm lấy từ bảng `tram` theo `ma_tram` (nhiều workflow version ⇒ LẤY 1 bản, không nhân dòng).
function nguonCpTheoPhanIn(maTramLoc) {
  const ds = maTramLoc ? [maTramLoc] : Object.keys(CP_PHAN_IN);
  const nhanh = ds.filter((t) => CP_PHAN_IN[t]).map(
    (t) => `SELECT '${t}'::text AS ma_tram, q.phan_in_id, q.tg_vao, q.tg_ra FROM (${CP_PHAN_IN[t]}) q`
  );
  return nhanh.length ? nhanh.join(' UNION ALL ') : null;
}

const TEN_TRAM_LAT = `LEFT JOIN LATERAL (SELECT ztr.ten_tram FROM tram ztr
  WHERE ztr.ma_tram = z.ma_tram ORDER BY ztr.thu_tu LIMIT 1) trm ON true`;

const COT_HOAN_THANH = [
  { key: 'stt', ten: 'STT', kieu: 'so' },
  { key: 'ngay_hoan_thanh', ten: 'Ngày hoàn thành', kieu: 'ngay' },
  { key: 'gio_hoan_thanh', ten: 'Giờ hoàn thành', kieu: 'text' },
  { key: 'ten_tram', ten: 'Checkpoint', kieu: 'text' },
  { key: 'ten_khach_hang', ten: 'Khách hàng', kieu: 'text' },
  { key: 'ma_don_hang', ten: 'PO', kieu: 'text' },
  { key: 'ma_phan', ten: 'Code phần', kieu: 'text' },
  { key: 'ma_hang', ten: 'Mã hàng', kieu: 'text' },
  { key: 'mau_vai', ten: 'Màu vải', kieu: 'text' },
  { key: 'kich_vai', ten: 'Kích vải', kieu: 'text' },
  { key: 'kich_phim', ten: 'Kích film', kieu: 'text' },
  { key: 'so_luong_don_hang', ten: 'SLĐH', kieu: 'so' },
  ...COT_LOAI_DOT,
];

// 1 phần in = 1 dòng cho MỖI checkpoint (DISTINCT ON phần in + trạm, lấy lượt hoàn thành muộn nhất trong
// khoảng ngày đã lọc) ⇒ độ dài danh sách KHỚP số đếm distinct của metric CP_*_ROI_HOM_NAY (trước đây đếm
// theo LƯỢT nên phình: 1 phần in rời/mở-lại nhiều lần = nhiều dòng).
// READY: nguồn = QC xác nhận (ket_qua_checkpoint QC_XAC_NHAN=DAT) — mốc READY hoàn tất THẬT, tin cậy.
// Các trạm khác: nguồn = lich_su_luan_chuyen.tg_kt (best-effort, nhưng deduped theo phần in).
const READY_TS = 'COALESCE(kq.tg_xac_nhan, kq.created_date)';
async function runHoanThanhTram({ loc = {}, gioi_han }) {
  const tram = clean(loc.tram);
  const src = nguonCpTheoPhanIn(tram);
  if (!src) return [];
  const params = [];
  const conds = ['z.tg_ra IS NOT NULL'];
  const nc = ngayCond('z.tg_ra', loc.ngay, true);
  if (nc) conds.push(nc);
  const nb = dkNhomBoSung(loc, FROM_DOT_PIN('pin.id'));
  if (nb) conds.push(nb);
  if (clean(loc.tim)) {
    params.push(mauTim(loc.tim));
    const i2 = params.length;
    conds.push(`(pin.ma_phan ~* $${i2} OR mh.ma_hang ~* $${i2} OR dh.ma_don_hang ~* $${i2} OR pin.mau_vai ~* $${i2})`);
  }
  const sql = `
    WITH z AS (${src})
    SELECT to_char(z.tg_ra AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY') AS ngay_hoan_thanh,
           to_char(z.tg_ra AT TIME ZONE 'Asia/Ho_Chi_Minh', 'HH24:MI') AS gio_hoan_thanh,
           COALESCE(trm.ten_tram, z.ma_tram) AS ten_tram, kh.ten_khach_hang, dh.ma_don_hang,
           pin.ma_phan, mh.ma_hang, pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.so_luong_don_hang,
           ${loaiDotTheoPin('pin.id')}
    FROM z
    JOIN phan_in pin ON pin.id = z.phan_in_id
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    ${TEN_TRAM_LAT}
    WHERE ${conds.join(' AND ')}
    ORDER BY z.tg_ra DESC
    LIMIT ${limitOf(gioi_han)}`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), params);
  return rows.map((r, i3) => ({ ...r, stt: i3 + 1 }));
}

// ============================== 3c) ĐANG Ở READY / HOÀN THÀNH READY (khớp màn Chuẩn bị KT / QC) ==============================
// 2 danh sách này CỐ Ý dùng ĐÚNG nguồn của màn "Chuẩn bị kỹ thuật" & "QC READY" để số liệu KHỚP MÀN
// (không lệch như DS_PHAN_IN — cái đó đếm ĐỢT VẢI ở flowRows). Đơn vị = PHẦN IN (1 dòng = 1 phần in).

// Điều kiện "phần in đang ở READY" — PHẢI trích y hệt `technical.repository.listCandidates` (màn Chuẩn bị
// kỹ thuật), 3 nhánh OR:
//   1) còn đợt vải CHƯA release (đã chuyển READY, không thuộc lệnh ≠ HUY nào)
//   2) chưa có đợt vải nào (kỹ thuật làm trước khi vải về)
//   3) đợt vải thuộc lệnh RELEASE_1 CHƯA có phiếu SX
// ⚠⚠ NHÁNH 3 = TEST RUN KHÔNG ĐẠT → QA TRẢ VỀ KỸ THUẬT (và mọi đường hủy xác nhận READY khác khi lệnh
// còn sống): lệnh được GIỮ NGUYÊN để QC xong nhảy THẲNG lại Test Run, nên đợt vải VẪN thuộc lệnh ⇒ 2 nhánh
// đầu đều trượt. Thiếu nhánh này thì khối danh sách "Đang ở READY" TRẢ THIẾU đúng số phần in đang chờ làm
// lại, trong khi metric `CP_READY_DANG_O` và màn READY vẫn đếm đủ ⇒ 2 con số trong CÙNG 1 báo cáo đá nhau
// (đã xảy ra thật 05/08/2026: ô "Phần OPEN" 69 vs danh sách 63 — thiếu đúng 6 phần in bị hủy READY).
// Bất biến nhận diện: release luôn đòi QC xong ⇒ QC bị hủy + chưa in tem = đang làm lại READY.
// ⇒ ĐIỀU KIỆN NÀY NẰM Ở 3 NƠI, đổi luật phải sửa CẢ 3: `technical.listCandidates` ·
//   `utils/stage.js` (dotStageCase nhánh 2) · hằng này.
// ⚠ 15/09/2026: bỏ nhánh "phần in chưa có đợt vải nào" + loại đợt DA_HUY (hệ thống đi theo đợt vải).
const READY_MEMBER = `(EXISTS (SELECT 1 FROM dot_vai_ve dvu WHERE dvu.phan_in_id = pin.id AND dvu.trang_thai NOT IN ('DA_GOP','DA_HUY') AND dvu.tg_chuyen_ready IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai lsu JOIN lenh_san_xuat lu ON lu.id = lsu.lenh_san_xuat_id WHERE lsu.dot_vai_ve_id = dvu.id AND lu.trang_thai <> 'HUY'))
    OR EXISTS (SELECT 1 FROM dot_vai_ve dvt JOIN lenh_sx_dot_vai lst ON lst.dot_vai_ve_id = dvt.id
                 JOIN lenh_san_xuat lt ON lt.id = lst.lenh_san_xuat_id AND lt.trang_thai = 'RELEASE_1'
                WHERE dvt.phan_in_id = pin.id AND dvt.trang_thai NOT IN ('DA_GOP','DA_HUY') AND dvt.tg_chuyen_ready IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM phieu_san_xuat pst WHERE pst.lenh_san_xuat_id = lt.id)))`;
const QC_DONE_EXISTS = `EXISTS (SELECT 1 FROM ket_qua_checkpoint k JOIN checkpoint cp ON cp.id = k.checkpoint_id
    WHERE k.phan_in_id = pin.id AND cp.ma_checkpoint = 'QC_XAC_NHAN' AND k.trang_thai = 'DAT')`;
const readyMark = (maCp) => `(CASE WHEN EXISTS (SELECT 1 FROM ket_qua_checkpoint k JOIN checkpoint cp ON cp.id = k.checkpoint_id
    WHERE k.phan_in_id = pin.id AND cp.ma_checkpoint = '${maCp}' AND k.trang_thai = 'DAT') THEN 'Đã' ELSE '' END)`;

// ── "CÒN CHỜ MỤC KỸ THUẬT NÀO" (Film / Khuôn / Mực) — thêm 23/09/2026 ─────────────────────────
// Dùng cho CẢ HAI: cột "Tình trạng chờ" của danh sách Open, và 3 nguồn "Open chờ <mục>" (`mucCho`).
// ⇒ 1 nguồn luật duy nhất: dòng nằm trong "Open chờ Mực" thì cột Tình trạng chờ CHẮC CHẮN có "Mực".
//
// ⚠⚠ TÍNH THEO **ĐỢT VẢI**, KHÔNG theo dòng tổng `ket_qua_checkpoint` (chốt 16/09/2026 — READY đi
//   theo đợt vải). Phần in có đợt 1 đã xác nhận Film + đợt 2 mới về chưa ai làm thì dòng tổng vẫn
//   'DAT', nhưng màn READY đang hiện nó là CÒN VIỆC ⇒ tính mức phần in sẽ báo THIẾU so với màn thao
//   tác. Đo prod 23/09/2026: tính theo đợt là SIÊU TẬP an toàn của mức phần in — bắt thêm đúng 10
//   phần in mỗi mục, KHÔNG mất dòng nào.
//   ⇒ Hệ quả PHẢI BIẾT: 3 cột `ready_khuon`/`ready_film`/`ready_muc` là trạng thái MỨC PHẦN IN nên có
//   thể hiện "Đã" trong khi "Tình trạng chờ" vẫn ghi đang chờ mục đó. Không phải lỗi — đối chiếu bằng
//   cột "Số đợt vải đang chờ" của 3 nguồn "Open chờ <mục>".
//
// ⚠⚠⚠ FILM VÀ KHUÔN LUÔN CÙNG TRẠNG THÁI ⇒ thực tế chỉ ra 3 nhãn: "Chờ Film, Khuôn, Mực" ·
//   "Chờ Film, Khuôn" · "Chờ Mực" (+ "Chờ QC" khi đã đủ mục). Từ 14/08/2026 xác nhận Khuôn thì hệ
//   thống TỰ ĐẶT Film (`technical.service` `keoTheoFilm`, ghi cả dòng theo đợt ở `xacNhanTheoNhom`).
//   Đo prod 23/09: 181 phần in chờ cả hai, **0 phần in chỉ chờ một bên**. Các tổ hợp còn lại
//   ("Chờ Khuôn, Mực" / "Chờ Film, Mực" / "Chờ Khuôn" / "Chờ Film") vẫn được dựng đúng nếu dữ liệu
//   có — đừng bỏ bớt nhánh vì "thực tế không thấy".
//
// ⚠ Khách GIA CÔNG (II/AD) MIỄN Khuôn + Film ⇒ 2 cờ đó luôn false (họ chỉ có thể "Chờ Mực").
const TEN_MUC_KT = { FILM: 'Film', KHUON: 'Khuôn', MUC: 'Mực' };
// Đợt vải ĐANG CHỜ ở READY (đã lên READY, CHƯA release) — gương `conDotChuaReadySql`, alias riêng.
const DOT_DANG_CHO = (alias, pinCol) => `${alias}.phan_in_id = ${pinCol}
  AND ${alias}.trang_thai NOT IN ('DA_GOP','DA_HUY') AND ${alias}.tg_chuyen_ready IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai zlm JOIN lenh_san_xuat zlsm ON zlsm.id = zlm.lenh_san_xuat_id
                   WHERE zlm.dot_vai_ve_id = ${alias}.id AND zlsm.trang_thai <> 'HUY')`;
const conDotChuaMucSql = (pinCol, ma) => `EXISTS (SELECT 1 FROM dot_vai_ve zdm
  WHERE ${DOT_DANG_CHO('zdm', pinCol)} AND NOT ${dotMucDatSql('zdm', pinCol, ma)})`;
// ⚠ "Số đợt vải đang chờ" (`so_dot_cho`) KHÔNG tính ở đây mà lấy từ `SQL_CHO_MUC` bên dưới — thêm 1
//   subquery nữa vào SELECT chính là đúng thứ vừa gây IPS reset. Đừng khôi phục `soDotChuaMucSql`.
// ⚠⚠⚠ 3 CỜ TÍNH BẰNG **QUERY PHỤ NHẸ THEO PK**, TUYỆT ĐỐI KHÔNG nhét vào `READY_INFO_SELECT`.
// Bản đầu 23/09/2026 đặt 3 EXISTS thẳng trong khối SELECT chính ⇒ **`read ECONNRESET` 3/3 lần, đúng
// 19,2 giây** — và KHÔNG phụ thuộc `LIMIT` (thử 10/50/150/300 dòng đều chết y hệt) ⇒ không phải chậm
// do dữ liệu mà là **IPS reset vì câu SQL quá dài** (§9). Câu chính vốn đã rất dài (READY_MEMBER +
// loaiDotTheoPin + 3 readyMark + so_muc_kt); cộng thêm 3 × `conDotChuaMucSql` là vượt ngưỡng.
// ⇒ Tách ra query riêng gom theo `phan_in_id` (khuôn "suy-ca bằng query nhẹ theo PK" đã dùng ở
//   `confirmInfoByPins` / `prevConfirmerByTems` / `caPartsForTems`). Tốn thêm 1 round-trip (~25ms)
//   nhưng câu chính giữ nguyên hình dạng đã chạy ổn định. **Đừng gộp ngược lại vào SELECT chính.**
// ⚠⚠ NGƯỠNG IPS ĐO ĐƯỢC 23/09/2026: câu chứa **2** biểu thức `dotMucDatSql` (1400 ký tự) chạy tốt,
//   **3** biểu thức (2060 ký tự) là `read ECONNRESET` sau đúng 19,2 giây — mọi lần, không phụ thuộc
//   `LIMIT`. ⇒ `CROSS JOIN (VALUES ...)` để viết biểu thức ĐÚNG MỘT LẦN (cờ `maLaBieuThuc` của
//   `dotMucDatSql`), trả 1 dòng / (phần in × mục) rồi gom ở JS. Câu còn ~1050 ký tự.
//   **Đừng "gộp cho gọn" thành 3 cột bool_or — đó chính là bản đã chết.**
const SQL_CHO_MUC = `SELECT zdm.phan_in_id, zcpm.ma,
    count(*) FILTER (WHERE NOT ${dotMucDatSql('zdm', 'zdm.phan_in_id', 'zcpm.ma', true)})::int AS so_cho
  FROM dot_vai_ve zdm CROSS JOIN (VALUES ('FILM'),('KHUON'),('MUC')) zcpm(ma)
  WHERE zdm.phan_in_id = ANY($1::uuid[])
    AND zdm.trang_thai NOT IN ('DA_GOP','DA_HUY') AND zdm.tg_chuyen_ready IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai zlm JOIN lenh_san_xuat zlsm ON zlsm.id = zlm.lenh_san_xuat_id
                     WHERE zlm.dot_vai_ve_id = zdm.id AND zlsm.trang_thai <> 'HUY')
  GROUP BY zdm.phan_in_id, zcpm.ma`;

// Ghép nhãn cột "Tình trạng chờ" từ 3 cờ — ở JS, KHÔNG ở SQL: dựng chuỗi trong SQL phải lặp cả 3 khối
// EXISTS hai lần (một lần để nối, một lần để kiểm rỗng) ⇒ lại phình đúng chỗ vừa phải gỡ ra.
function nhanChoMuc(r) {
  if (r.tinh_trang === 'Đã READY (QA)') return '—'; // đã xong READY, không còn chờ mục nào
  const ds = ['FILM', 'KHUON', 'MUC'].filter((ma) => r[`cho_${ma.toLowerCase()}`]).map((ma) => TEN_MUC_KT[ma]);
  return ds.length ? `Chờ ${ds.join(', ')}` : 'Chờ QC';
}

// Gắn `cho_film`/`cho_khuon`/`cho_muc` + nhãn `cho_muc_kt` (+ `so_dot_cho` khi ở chế độ "Open chờ <mục>").
// ⚠ Khách gia công (II/AD) MIỄN Khuôn + Film ⇒ ép 2 cờ đó về false Ở ĐÂY (không lọc trong SQL cho câu
//   phụ khỏi phải JOIN thêm 3 bảng để lấy tên khách — hàng đã có sẵn `ten_khach_hang`).
// ⚠ Phần in KHÔNG còn đợt vải đang chờ (vd dòng "Đã READY (QA)") không có dòng nào trong query phụ ⇒
//   cả 3 cờ false ⇒ `nhanChoMuc` trả "—" hoặc "Chờ QC" tùy `tinh_trang`.
async function ganChoMuc(rows, mucCho) {
  if (!rows.length) return rows;
  const ids = [...new Set(rows.map((r) => r.phan_in_id))];
  const { rows: m } = await query(SQL_CHO_MUC.replace(/\s+/g, ' ').trim(), [ids]);
  const so = new Map(m.map((x) => [`${x.phan_in_id}|${x.ma}`, x.so_cho])); // số ĐỢT còn chờ mục đó
  for (const r of rows) {
    const giaCong = KHUON_OPTIONAL_KH.includes(String(r.ten_khach_hang || '').trim());
    const lay = (ma) => so.get(`${r.phan_in_id}|${ma}`) || 0;
    r.cho_film = giaCong ? false : lay('FILM') > 0;
    r.cho_khuon = giaCong ? false : lay('KHUON') > 0;
    r.cho_muc = lay('MUC') > 0;
    r.cho_muc_kt = nhanChoMuc(r);
    if (mucCho) r.so_dot_cho = lay(mucCho);
  }
  return rows;
}

// Khối cột thông tin phần in dùng CHUNG cho 2 nhánh của DS_READY_DANG_O (đang ở READY / đã QA theo ngày).
// Yêu cầu alias sẵn: pin, mh, dh, kh.
const READY_INFO_SELECT = `
  pin.id AS phan_in_id,
  pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.tinh_chat_in, pin.so_luong_don_hang,
  mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang,
  ${loaiDotTheoPin('pin.id')},
  (SELECT COALESCE(sum(dv5.so_luong_vai_ve),0) FROM dot_vai_ve dv5 WHERE dv5.phan_in_id = pin.id AND dv5.trang_thai NOT IN ('DA_GOP','DA_HUY'))::int AS so_luong_vai_ve,
  to_char((SELECT min(dv4.han_giao_hang) FROM dot_vai_ve dv4 WHERE dv4.phan_in_id = pin.id AND dv4.trang_thai NOT IN ('DA_GOP','DA_HUY')), 'DD/MM/YYYY') AS han_giao_hang,
  (CASE WHEN kh.ten_khach_hang IN (${KHUON_OPT_SQL_LIST}) THEN '—' ELSE ${readyMark('KHUON')} END) AS ready_khuon,
  (CASE WHEN kh.ten_khach_hang IN (${KHUON_OPT_SQL_LIST}) THEN '—' ELSE ${readyMark('FILM')} END) AS ready_film,
  ${readyMark('MUC')} AS ready_muc,
  ((SELECT count(*) FROM ket_qua_checkpoint k JOIN checkpoint cp ON cp.id = k.checkpoint_id
     WHERE k.phan_in_id = pin.id AND k.trang_thai = 'DAT'
       AND (cp.ma_checkpoint = 'MUC' OR (cp.ma_checkpoint = 'KHUON' AND kh.ten_khach_hang NOT IN (${KHUON_OPT_SQL_LIST}))))::text
    || '/' || (CASE WHEN kh.ten_khach_hang IN (${KHUON_OPT_SQL_LIST}) THEN '1' ELSE '2' END)) AS so_muc_kt`;

const COT_READY_DANG_O = [
  { key: 'stt', ten: 'STT', kieu: 'so' },
  { key: 'tinh_trang', ten: 'Tình trạng', kieu: 'text' },
  { key: 'ma_phan', ten: 'Code phần', kieu: 'text' },
  { key: 'ma_hang', ten: 'Mã hàng', kieu: 'text' },
  { key: 'ten_khach_hang', ten: 'Khách hàng', kieu: 'text' },
  { key: 'ma_don_hang', ten: 'PO', kieu: 'text' },
  { key: 'mau_vai', ten: 'Màu vải', kieu: 'text' },
  { key: 'kich_vai', ten: 'Kích vải', kieu: 'text' },
  { key: 'kich_phim', ten: 'Kích film', kieu: 'text' },
  { key: 'tinh_chat_in', ten: 'TC IN', kieu: 'text' },
  { key: 'so_luong_don_hang', ten: 'SLĐH', kieu: 'so' },
  { key: 'so_luong_vai_ve', ten: 'SL nhận vải', kieu: 'so' },
  ...COT_LOAI_DOT,
  { key: 'han_giao_hang', ten: 'Hạn giao', kieu: 'ngay' },
  { key: 'ready_khuon', ten: 'Khuôn', kieu: 'text' },
  { key: 'ready_film', ten: 'Film', kieu: 'text' },
  { key: 'ready_muc', ten: 'Mực', kieu: 'text' },
  { key: 'so_muc_kt', ten: 'Mục KT xong', kieu: 'text' },
  // Còn chờ mục KT nào — "Chờ Film, Khuôn, Mực" / "Chờ Mực" / "Chờ QC" (đủ mục, chờ QC duyệt) /
  // "—" (dòng đã READY). ⚠ Tên cột là "Tình trạng CHỜ" để không lẫn với cột "Tình trạng" ngay trên
  // (cột đó phân biệt "Đang ở READY" ↔ "Đã READY (QA)"). Nhãn dựng ở JS bởi `nhanChoMuc`.
  { key: 'cho_muc_kt', ten: 'Tình trạng chờ', kieu: 'text' },
  { key: 'qc_ready', ten: 'QC READY', kieu: 'text' },
  { key: 'ngay_ready', ten: 'Ngày QA READY', kieu: 'text' },
  { key: 'gio_ready', ten: 'Giờ QA READY', kieu: 'text' },
  { key: 'nguoi_ready', ten: 'Người QA', kieu: 'text' },
];

// Bộ cột cho 3 nguồn "Open chờ <mục>" — y hệt "Đang ở READY" nhưng BỎ 4 cột QA (ở đây luôn rỗng vì
// hàng đã QA thì không còn chờ mục nào) và THÊM "Số đợt vải đang chờ".
// ⚠ 3 cột Khuôn/Film/Mực giữ nguyên nghĩa CŨ = trạng thái MỨC PHẦN IN (lần xác nhận gần nhất). Dòng
//   lọt vào đây là do CÒN ĐỢT VẢI chưa xác nhận mục đó ⇒ có thể thấy ô "Đã" mà vẫn nằm trong danh
//   sách chờ — đối chiếu bằng cột "Số đợt vải đang chờ".
const COT_READY_CHO_MUC = [
  ...COT_READY_DANG_O.filter((c) => !['qc_ready', 'ngay_ready', 'gio_ready', 'nguoi_ready'].includes(c.key)),
  { key: 'so_dot_cho', ten: 'Số đợt vải đang chờ', kieu: 'so' },
];

// ── OPEN CHỜ TỪNG MỤC KỸ THUẬT (Film / Khuôn / Mực) — thêm 23/09/2026 ──────────────────────────
// 3 nguồn "Open chờ <mục>" dùng CHUNG `runReadyDangO` (tham số `mucCho`), chỉ thêm 1 điều kiện lọc
// ⇒ không thể lệch tập với "Đang ở READY": mỗi danh sách là TẬP CON của nó.
//
// ⚠⚠ LỌC THEO **ĐỢT VẢI**, KHÔNG theo dòng tổng `ket_qua_checkpoint` (chốt 16/09/2026 — READY đi theo
//   đợt vải). Phần in có đợt 1 đã xác nhận Film + đợt 2 mới về chưa ai làm thì dòng tổng vẫn 'DAT',
//   nhưng màn READY đang hiện nó là CÒN VIỆC ⇒ lọc mức phần in sẽ báo THIẾU so với màn thao tác.
//   Đo prod 23/09/2026: lọc theo đợt là SIÊU TẬP an toàn của lọc mức phần in — bắt thêm đúng 10 phần
//   in mỗi mục, KHÔNG mất dòng nào (0 ca "chưa DAT tổng mà hết đợt chờ").
//
// ⚠⚠⚠ "CHỜ FILM" VÀ "CHỜ KHUÔN" LUÔN RA CÙNG MỘT DANH SÁCH — không phải lỗi: từ 14/08/2026 xác nhận
//   Khuôn thì hệ thống TỰ ĐẶT Film (`technical.service` `keoTheoFilm`, ghi cả dòng theo đợt ở
//   `xacNhanTheoNhom`) ⇒ 2 mục luôn cùng trạng thái. Đo prod 23/09: 181 phần in chờ cả hai,
//   **0 phần in chỉ chờ một bên**. Giữ 2 nguồn riêng vì người dùng cần 2 file riêng.
//
// ⚠ Khách GIA CÔNG (II/AD) được MIỄN Khuôn + Film ⇒ loại khỏi 2 nguồn đó (nếu không, toàn bộ hàng
//   II/AD sẽ lọt vào "chờ khuôn/chờ film" trong khi không ai phải làm gì). "Chờ Mực" thì tính đủ.
// ⚠ Helper `TEN_MUC_KT` · `DOT_DANG_CHO` · `conDotChuaMucSql` · `SQL_CHO_MUC` · `ganChoMuc` khai Ở TRÊN
//   (ngay trước `READY_INFO_SELECT`): `const` KHÔNG hoisted và template literal đánh giá NGAY lúc nạp
//   module ⇒ khai ở đây là ReferenceError.

// DS_READY_DANG_O — 2 chế độ theo bộ lọc NGÀY:
//   - Để trống ngày  → CHỈ "đang ở READY hiện tại" (snapshot, như cũ).
//   - Chọn ngày (Hôm nay/cụ thể) → GỘP: phần in ĐÃ QA xác nhận READY trong ngày đó (throughput)
//     + phần in ĐANG ở READY hiện tại (backlog). Cột "Tình trạng" phân biệt 2 nhóm; nhóm "đã QA" kèm ngày/giờ/người.
// `mucCho` (FILM|KHUON|MUC) → chuyển sang chế độ "Open chờ <mục>": chỉ ảnh chụp HIỆN TẠI, BỎ HẲN
//   nhánh "đã QA theo ngày" (hàng đã QA là hàng XONG READY, không còn chờ mục nào — gộp vào là sai).
async function runReadyDangO({ loc = {}, gioi_han, mucCho = null }) {
  const lim = limitOf(gioi_han);
  // ⚠⚠⚠ ĐỔI 24/09/2026 (người dùng báo "Open đang ở READY đang lấy luôn cái đã READY"): nguồn này nay
  //   CHỈ còn ẢNH CHỤP "đang ở READY" — BỎ HẲN nhánh gộp "đã QA theo ngày". Ca thật: BC0010 *Open Kỹ
  //   Thuật* ô A7 đặt ngày = Hôm nay ⇒ danh sách ra 208 dòng = 92 đang ở + **116 đã READY (QA)**.
  //   Hàng đã QA trong ngày xem ở nguồn RIÊNG `DS_READY_HOAN_THANH`. Báo cáo cũ còn lưu `loc.ngay` thì
  //   bộ lọc đó bị BỎ QUA (không lỗi). Code nhánh "đã QA" giữ lại bên dưới nhưng không bao giờ chạy.
  const ngay = '';
  const JOINS = `
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id`;

  // 1) ĐANG ở READY hiện tại (snapshot) — luôn lấy.
  const pc = [];
  // LOAI phan in do HE THONG tu xac nhan READY (ERP KTCankiemtra=0) - xem utils/tech.js.
  // ⚠⚠ "Còn ở READY" gương y hệt `technical.listCandidates` (16/09/2026): dòng TỔNG đang DAT mà vẫn còn
  //   đợt vải ĐANG CHỜ chưa được QC phủ thì phần in VẪN ở READY. Thiếu vế thứ 2 là dataset này báo ít
  //   hơn màn READY đúng nhóm phần in vừa có đợt vải mới về — 2 con số trong cùng hệ đá nhau.
  const conds = ['pin.dang_hoat_dong', READY_MEMBER,
    `(NOT ${QC_DONE_EXISTS} OR ${conDotChuaReadySql('pin.id')})`, khongReadyTuDongSql('pin.id')];
  if (mucCho) {
    conds.push(conDotChuaMucSql('pin.id', mucCho));
    // Khách gia công miễn Khuôn + Film ⇒ không phải "đang chờ" 2 mục đó.
    if (mucCho !== 'MUC') conds.push(`kh.ten_khach_hang NOT IN (${KHUON_OPT_SQL_LIST})`);
  }
  const nb = dkNhomBoSung(loc, FROM_DOT_PIN('pin.id'));
  if (nb) conds.push(nb);
  if (clean(loc.khach)) { pc.push(mauTim(loc.khach)); conds.push(`kh.ten_khach_hang ~* $${pc.length}`); }
  if (clean(loc.tim)) {
    pc.push(mauTim(loc.tim)); const i = pc.length;
    conds.push(`(pin.ma_phan ~* $${i} OR mh.ma_hang ~* $${i} OR dh.ma_don_hang ~* $${i} OR pin.mau_vai ~* $${i})`);
  }
  const sqlCur = `
    SELECT ${READY_INFO_SELECT},
           ${mucCho ? `'Chờ ${TEN_MUC_KT[mucCho]}'` : `'Đang ở READY'`}::text AS tinh_trang, ''::text AS qc_ready,
           ''::text AS ngay_ready, ''::text AS gio_ready, ''::text AS nguoi_ready
    FROM phan_in pin ${JOINS}
    WHERE ${conds.join(' AND ')}
    ORDER BY kh.ten_khach_hang, dh.ma_don_hang, pin.ma_phan
    LIMIT ${lim}`;
  const cur = (await query(sqlCur.replace(/\s+/g, ' ').trim(), pc)).rows;

  // 2) ĐÃ QA xác nhận READY trong NGÀY đã chọn — chỉ khi có chọn ngày.
  let done = [];
  if (ngay) {
    const dc = [];
    const dconds = ["cp.ma_checkpoint = 'QC_XAC_NHAN'", "kq.trang_thai = 'DAT'", 'pin.dang_hoat_dong', khongReadyTuDongSql('pin.id')];
    const nc = ngayCond(READY_TS, ngay, true);
    if (nc) dconds.push(nc);
    if (nb) dconds.push(nb);
    if (clean(loc.khach)) { dc.push(mauTim(loc.khach)); dconds.push(`kh.ten_khach_hang ~* $${dc.length}`); }
    if (clean(loc.tim)) {
      dc.push(mauTim(loc.tim)); const i = dc.length;
      dconds.push(`(pin.ma_phan ~* $${i} OR mh.ma_hang ~* $${i} OR dh.ma_don_hang ~* $${i} OR pin.mau_vai ~* $${i})`);
    }
    const sqlDone = `
      SELECT DISTINCT ON (pin.id) ${READY_INFO_SELECT},
             'Đã READY (QA)'::text AS tinh_trang, 'Đã QC'::text AS qc_ready,
             to_char(${READY_TS} AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY') AS ngay_ready,
             to_char(${READY_TS} AT TIME ZONE 'Asia/Ho_Chi_Minh', 'HH24:MI') AS gio_ready,
             ${nguoiXacNhanSql('nx', 'kq')} AS nguoi_ready
      FROM ket_qua_checkpoint kq
      JOIN checkpoint cp ON cp.id = kq.checkpoint_id
      JOIN phan_in pin ON pin.id = kq.phan_in_id ${JOINS}
      LEFT JOIN nguoi_dung nx ON nx.id = kq.nguoi_xac_nhan_id
      WHERE ${dconds.join(' AND ')}
      ORDER BY pin.id, ${READY_TS} DESC
      LIMIT ${lim}`;
    done = (await query(sqlDone.replace(/\s+/g, ' ').trim(), dc)).rows;
  }

  // Gộp: "đã READY (QA)" trước (throughput) rồi "đang ở READY" (backlog); dedupe theo phần in.
  const seen = new Set();
  const all = [];
  for (const r of [...done, ...cur]) {
    if (seen.has(r.phan_in_id)) continue;
    seen.add(r.phan_in_id);
    all.push(r);
  }
  return ganChoMuc(all.slice(0, lim).map((r, i) => ({ ...r, stt: i + 1 })), mucCho);
}

const COT_READY_HOAN_THANH = [
  { key: 'stt', ten: 'STT', kieu: 'so' },
  { key: 'ngay_hoan_thanh', ten: 'Ngày hoàn thành', kieu: 'ngay' },
  { key: 'gio_hoan_thanh', ten: 'Giờ hoàn thành', kieu: 'text' },
  { key: 'nguoi_xac_nhan', ten: 'Người xác nhận (QC)', kieu: 'text' },
  { key: 'ma_phan', ten: 'Code phần', kieu: 'text' },
  { key: 'ma_hang', ten: 'Mã hàng', kieu: 'text' },
  { key: 'ten_khach_hang', ten: 'Khách hàng', kieu: 'text' },
  { key: 'ma_don_hang', ten: 'PO', kieu: 'text' },
  { key: 'mau_vai', ten: 'Màu vải', kieu: 'text' },
  { key: 'kich_vai', ten: 'Kích vải', kieu: 'text' },
  { key: 'kich_phim', ten: 'Kích film', kieu: 'text' },
  { key: 'so_luong_don_hang', ten: 'SLĐH', kieu: 'so' },
  { key: 'so_luong_vai_ve', ten: 'SL nhận vải', kieu: 'so' },
  ...COT_LOAI_DOT,
];

// Danh sách phần in đã hoàn thành READY (QC xác nhận) — khớp sidebar "Đã hoàn thành" (scope QC) màn QC READY.
async function runReadyHoanThanh({ loc = {}, gioi_han }) {
  const params = [];
  const conds = ["cp.ma_checkpoint = 'QC_XAC_NHAN'", "kq.trang_thai = 'DAT'", 'pin.dang_hoat_dong', khongReadyTuDongSql('pin.id')];
  const nc = ngayCond(READY_TS, loc.ngay, true);
  if (nc) conds.push(nc);
  const nb = dkNhomBoSung(loc, FROM_DOT_PIN('pin.id'));
  if (nb) conds.push(nb);
  if (clean(loc.tim)) {
    params.push(mauTim(loc.tim));
    const i = params.length;
    conds.push(`(pin.ma_phan ~* $${i} OR mh.ma_hang ~* $${i} OR dh.ma_don_hang ~* $${i} OR pin.mau_vai ~* $${i})`);
  }
  const sql = `
    SELECT to_char(${READY_TS} AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY') AS ngay_hoan_thanh,
           to_char(${READY_TS} AT TIME ZONE 'Asia/Ho_Chi_Minh', 'HH24:MI') AS gio_hoan_thanh,
           ${nguoiXacNhanSql('nx', 'kq')} AS nguoi_xac_nhan,
           pin.ma_phan, mh.ma_hang, kh.ten_khach_hang, dh.ma_don_hang, pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.so_luong_don_hang,
           ${loaiDotTheoPin('pin.id')},
           (SELECT COALESCE(sum(dv5.so_luong_vai_ve),0) FROM dot_vai_ve dv5 WHERE dv5.phan_in_id = pin.id AND dv5.trang_thai NOT IN ('DA_GOP','DA_HUY'))::int AS so_luong_vai_ve
    FROM ket_qua_checkpoint kq
    JOIN checkpoint cp ON cp.id = kq.checkpoint_id
    JOIN phan_in pin ON pin.id = kq.phan_in_id
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    LEFT JOIN nguoi_dung nx ON nx.id = kq.nguoi_xac_nhan_id
    WHERE ${conds.join(' AND ')}
    ORDER BY ${READY_TS} DESC
    LIMIT ${limitOf(gioi_han)}`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), params);
  return rows.map((r, i) => ({ ...r, stt: i + 1 }));
}

// ============================== 3d) PHẦN IN VÀO CHECKPOINT TRONG NGÀY ==============================
// 1 dòng = 1 PHẦN IN có thời gian VÀO 1 checkpoint trong ngày (nguồn lich_su_luan_chuyen.tg_bd + den_tram)
// — khớp ý nghĩa metric CP_<TRAM>_VAO_HOM_NAY. Cột "Hoàn thành trong ngày" = phần in đã RỜI checkpoint đó
// (tg_kt) trong cùng ngày ⇒ vừa thấy "toàn bộ phần in vào trong ngày" vừa thấy "cái nào đã hoàn thành".
// Lọc Trạm = READY + Ngày = Hôm nay ⇒ "phần in vào READY hôm nay + cái nào đã hoàn thành". (best-effort tracking.)
const COT_VAO_TRAM = [
  { key: 'stt', ten: 'STT', kieu: 'so' },
  { key: 'ngay_vao', ten: 'Ngày vào', kieu: 'ngay' },
  { key: 'gio_vao', ten: 'Giờ vào', kieu: 'text' },
  { key: 'ten_tram', ten: 'Checkpoint', kieu: 'text' },
  { key: 'ten_khach_hang', ten: 'Khách hàng', kieu: 'text' },
  { key: 'ma_don_hang', ten: 'PO', kieu: 'text' },
  { key: 'ma_phan', ten: 'Code phần', kieu: 'text' },
  { key: 'ma_hang', ten: 'Mã hàng', kieu: 'text' },
  { key: 'mau_vai', ten: 'Màu vải', kieu: 'text' },
  { key: 'kich_vai', ten: 'Kích vải', kieu: 'text' },
  { key: 'kich_phim', ten: 'Kích film', kieu: 'text' },
  { key: 'so_luong_don_hang', ten: 'SLĐH', kieu: 'so' },
  ...COT_LOAI_DOT,
  { key: 'hoan_thanh', ten: 'Hoàn thành trong ngày', kieu: 'text' },
  { key: 'gio_hoan_thanh', ten: 'Giờ hoàn thành', kieu: 'text' },
];

async function runPhanInVaoTram({ loc = {}, gioi_han }) {
  const tram = clean(loc.tram);
  const src = nguonCpTheoPhanIn(tram);
  if (!src) return [];
  const params = [];
  const conds = ['z.tg_vao IS NOT NULL'];
  const nc = ngayCond('z.tg_vao', loc.ngay, true);
  if (nc) conds.push(nc);
  const nb = dkNhomBoSung(loc, FROM_DOT_PIN('pin.id'));
  if (nb) conds.push(nb);
  if (clean(loc.tim)) {
    params.push(mauTim(loc.tim));
    const i2 = params.length;
    conds.push(`(pin.ma_phan ~* $${i2} OR mh.ma_hang ~* $${i2} OR dh.ma_don_hang ~* $${i2} OR pin.mau_vai ~* $${i2})`);
  }
  // Cờ "Hoàn thành trong ngày" = đã RỜI trạm trong cùng ngày đã lọc (bỏ trống ngày → chỉ cần đã rời).
  const dc = ngayCond('z.tg_ra', loc.ngay, true);
  const dkXong = `z.tg_ra IS NOT NULL${dc ? ` AND ${dc}` : ''}`;
  const sql = `
    WITH z AS (${src})
    SELECT to_char(z.tg_vao AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY') AS ngay_vao,
           to_char(z.tg_vao AT TIME ZONE 'Asia/Ho_Chi_Minh', 'HH24:MI') AS gio_vao,
           COALESCE(trm.ten_tram, z.ma_tram) AS ten_tram, kh.ten_khach_hang, dh.ma_don_hang,
           pin.ma_phan, mh.ma_hang, pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.so_luong_don_hang,
           ${loaiDotTheoPin('pin.id')},
           CASE WHEN ${dkXong} THEN 'Đã hoàn thành' ELSE '' END AS hoan_thanh,
           CASE WHEN ${dkXong}
                THEN to_char(z.tg_ra AT TIME ZONE 'Asia/Ho_Chi_Minh', 'HH24:MI') ELSE '' END AS gio_hoan_thanh
    FROM z
    JOIN phan_in pin ON pin.id = z.phan_in_id
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    ${TEN_TRAM_LAT}
    WHERE ${conds.join(' AND ')}
    ORDER BY z.tg_vao DESC
    LIMIT ${limitOf(gioi_han)}`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), params);
  return rows.map((r, i3) => ({ ...r, stt: i3 + 1 }));
}

// ============================== 4) TỔNG HỢP THEO TRẠM ==============================
// 1 dòng = 1 checkpoint → sheet "KẾT QUẢ PHA MÀU - CHỤP KHUÔN - FILM - CNSP".
const COT_TRAM = [
  { key: 'stt', ten: 'STT', kieu: 'so' },
  { key: 'ten_tram', ten: 'Trạm (checkpoint)', kieu: 'text' },
  { key: 'vao_hom_nay', ten: 'Vào hôm nay', kieu: 'so' },
  { key: 'roi_hom_nay', ten: 'Hoàn tất & qua trạm khác hôm nay', kieu: 'so' },
  { key: 'dang_o', ten: 'Đang ở (đợt vải)', kieu: 'so' },
  { key: 'dung_han', ten: 'Đúng hạn', kieu: 'so' },
  { key: 'sap_nghen', ten: 'Sắp nghẽn', kieu: 'so' },
  { key: 'nghen', ten: 'Nghẽn', kieu: 'so' },
  { key: 'diem_nghen', ten: 'Điểm nghẽn', kieu: 'text' },
  { key: 'sla_phut', ten: 'SLA (phút)', kieu: 'so' },
];

async function runTongHopTram({ loc = {} }) {
  // Vào / rời hôm nay theo trạm — 1 query gộp (IPS-safe).
  // ⚠⚠ ĐỔI NGUỒN 16/08/2026: bỏ `lich_su_luan_chuyen` (hỏng — DATABASE.md §7), dùng `CP_PHAN_IN`
  //   để KHỚP với metric `CP_*_VAO_HOM_NAY` và với "sĩ số" ở 11 màn xác nhận.
  //   READY vẫn ra đúng mốc QC xác nhận vì `CP_PHAN_IN.READY.tg_ra` chính là `QC_XAC_NHAN` DAT
  //   ⇒ không cần câu bù riêng cho READY như bản cũ.
  const { rows: llc } = await query(`
    SELECT z.ma_tram,
           count(DISTINCT z.phan_in_id) FILTER (WHERE z.tg_vao IS NOT NULL
             AND (z.tg_vao AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = ${VN_TODAY})::int AS vao,
           count(DISTINCT z.phan_in_id) FILTER (WHERE z.tg_ra IS NOT NULL
             AND (z.tg_ra AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = ${VN_TODAY})::int AS roi
    FROM (${nguonCpTheoPhanIn(null)}) z GROUP BY z.ma_tram`.replace(/\s+/g, ' ').trim());
  const llcBy = Object.fromEntries(llc.map((r) => [r.ma_tram, r]));

  const flow = await flowRowsCached();
  const agg = {};
  flow.forEach((f) => {
    const a = agg[f.ma_tram] || (agg[f.ma_tram] = { dang_o: 0, nghen: 0, sap_nghen: 0, ten_tram: f.ten_tram, sla_phut: f.sla_phut });
    a.dang_o += 1;
    const st = slaStatus(f.phut_da_o, f.sla_phut, f.canh_bao_truoc_phut);
    if (st === 'NGHEN') a.nghen += 1; else if (st === 'SAP_NGHEN') a.sap_nghen += 1;
  });

  const tramLoc = clean(loc.tram);
  const out = CP_FLOW_TRAM.filter((t) => !tramLoc || t.ma === tramLoc).map((t) => {
    const a = agg[t.ma] || { dang_o: 0, nghen: 0, sap_nghen: 0, sla_phut: null };
    const l = llcBy[t.ma] || { vao: 0, roi: 0 };
    return {
      ma_tram: t.ma, ten_tram: t.ten,
      vao_hom_nay: l.vao, roi_hom_nay: l.roi,
      dang_o: a.dang_o, nghen: a.nghen, sap_nghen: a.sap_nghen,
      dung_han: a.dang_o - a.nghen - a.sap_nghen,
      sla_phut: a.sla_phut,
      diem_nghen: a.nghen > 0 ? `${a.nghen} đợt quá SLA` : 'OK.',
    };
  });
  return out.map((r, i) => ({ ...r, stt: i + 1 }));
}

// Trạm hiển thị ở dataset "Tổng hợp theo trạm" (khớp CP_FLOW của metrics.js).
const CP_FLOW_TRAM = [
  { ma: 'READY', ten: 'READY (chuẩn bị KT)' },
  { ma: 'RELEASE_1', ten: 'Release 1' },
  { ma: 'TEST_RUN', ten: 'Test Run' },
  { ma: 'RELEASE_2', ten: 'Release 2' },
  { ma: 'SAN_XUAT', ten: 'Sản xuất' },
  { ma: 'CHO_KHO', ten: 'Chờ khô' },
  { ma: 'KIEM', ten: 'KCS (kiểm)' },
  { ma: 'SUA', ten: 'Sửa' },
  { ma: 'OQC', ten: 'OQC' },
  { ma: 'FINISH', ten: 'Hoàn tất' },
];

// ============================== BỘ LỌC (mô tả cho FE dựng UI) ==============================
// kieu: 'ngay' = ô chọn ngày (rỗng/HOM_NAY/YYYY-MM-DD) · 'chon' = dropdown (kèm `chon`) · 'chu' = ô nhập chữ.
const TRAM_OPTS = () => CP_FLOW_TRAM.map((t) => ({ v: t.ma, ten: t.ten }));
const LOC_DEF = {
  ngay: { ma: 'ngay', ten: 'Ngày', kieu: 'ngay', mo_ta: 'Để trống = mọi ngày · "Hôm nay" = tự đổi theo ngày xem.' },
  ngay_testrun: { ma: 'ngay', ten: 'Ngày (đã test)', kieu: 'ngay',
    mo_ta: 'Lọc NGÀY cho nhánh "đã test". Để trống = HÔM NAY. Nhánh "chờ test" luôn hiện theo hiện tại.' },
  ngay_ready: { ma: 'ngay', ten: 'Ngày (đã QA READY)', kieu: 'ngay',
    mo_ta: 'Để trống = CHỈ danh sách đang ở READY hiện tại · Chọn ngày (Hôm nay/cụ thể) = THÊM phần in đã QA xác nhận READY ngày đó.' },
  tram: { ma: 'tram', ten: 'Trạm (checkpoint)', kieu: 'chon', chon: TRAM_OPTS },
  chuyen: { ma: 'chuyen', ten: 'Chuyền', kieu: 'chu' },
  khach: { ma: 'khach', ten: 'Khách hàng', kieu: 'chu' },
  tim: { ma: 'tim', ten: 'Tìm kiếm', kieu: 'chu', mo_ta: 'Code phần / mã hàng / PO / màu vải...' },
  trang_thai_lsx: { ma: 'trang_thai', ten: 'Trạng thái lệnh', kieu: 'chon',
    chon: () => Object.entries(LSX_TT).filter(([v]) => v !== 'HUY').map(([v, ten]) => ({ v, ten })) },
  trang_thai_tem: { ma: 'trang_thai', ten: 'Trạng thái tem', kieu: 'chon',
    chon: () => Object.entries(TEM_TT).filter(([v]) => v !== 'HUY').map(([v, ten]) => ({ v, ten })) },
  nhom_bo_sung: { ma: 'nhom_bo_sung', ten: 'Nhóm bổ sung', kieu: 'chon',
    mo_ta: 'Để trống = tất cả. "Có bổ sung" = có đợt vải BỔ SUNG (ERP 5I) SL > 0 — khi đó "SL thực tính" = Σ SL bổ sung.',
    chon: () => [
      { v: 'CO', ten: 'Có bổ sung' },
      { v: 'KHONG', ten: 'Không bổ sung' },
    ] },
  loai_ds_testrun: { ma: 'loai_ds', ten: 'Loại danh sách', kieu: 'chon',
    mo_ta: 'Để trống = cả hai (có mặt + đã test).',
    chon: () => [
      { v: 'CO_MAT', ten: 'Có mặt ở Test Run (chờ test)' },
      { v: 'DA_TEST', ten: 'Đã test run' },
    ] },
};
const locList = (keys) => keys.map((k) => {
  const d = LOC_DEF[k];
  return { ...d, chon: typeof d.chon === 'function' ? d.chon() : undefined };
});

// ============================== REGISTRY ==============================
const DEFS = [
  { ma: 'DS_PHAN_IN', ten: 'Phần in / đợt vải (theo ngày, trạm)', don_vi_dong: 'đợt vải',
    mo_ta: '1 dòng = 1 đợt vải của phần in, kèm trạm hiện tại + SLA. Dựng bảng kiểu "Hệ điều hành nhà máy in lụa".',
    loc: locList(['ngay', 'tram', 'khach', 'nhom_bo_sung', 'tim']), cot: COT_PHAN_IN, run: runPhanIn },
  { ma: 'DS_DOT_SAN_XUAT', ten: 'Đợt sản xuất / lệnh SX (theo ngày, chuyền)', don_vi_dong: 'lệnh SX',
    mo_ta: '1 dòng = 1 đợt sản xuất (lệnh SX) theo ngày kế hoạch. Dựng bảng kiểu "Test Run bàn A/B / máy tự động".',
    loc: locList(['ngay', 'chuyen', 'trang_thai_lsx', 'nhom_bo_sung', 'tim']), cot: COT_DOT_SX, run: runDotSanXuat },
  { ma: 'DS_TEST_RUN', ten: 'Test Run hôm nay (có mặt / đã test)', don_vi_dong: 'lệnh SX',
    mo_ta: '1 dòng = 1 lệnh liên quan Test Run. Mặc định (để trống Ngày) = "đang chờ test ở Test Run hiện tại" + "đã test '
      + 'HÔM NAY" (kèm kết quả + thông tin test của QC: người test, loại, giờ, ghi chú, QC xác nhận). Đặt Ngày cụ thể để xem '
      + 'nhánh "đã test" của ngày khác; chọn "Loại danh sách" để chỉ xem 1 nhóm. Cột "Tình trạng" phân biệt Đang chờ test / Đã test.',
    loc: locList(['ngay_testrun', 'loai_ds_testrun', 'chuyen', 'nhom_bo_sung', 'tim']), cot: COT_TEST_RUN, run: runTestRun },
  { ma: 'DS_TEM', ten: 'Tem (KCS / Sửa / OQC / Giao)', don_vi_dong: 'tem',
    mo_ta: '1 dòng = 1 tem theo ngày in tem, kèm sổ cái số lượng từng công đoạn.',
    loc: locList(['ngay', 'trang_thai_tem', 'chuyen', 'nhom_bo_sung', 'tim']), cot: COT_TEM, run: runTem },
  { ma: 'DS_PHAN_IN_VAO_TRAM', ten: 'Phần in VÀO checkpoint trong ngày (+ cờ hoàn thành)', don_vi_dong: 'phần in',
    mo_ta: '1 dòng = 1 PHẦN IN có thời gian VÀO 1 checkpoint trong ngày (nguồn lịch sử luân chuyển). '
      + 'Cột "Hoàn thành trong ngày" cho biết phần in nào đã rời checkpoint đó trong cùng ngày. '
      + 'Lọc Trạm = READY + Ngày = Hôm nay ⇒ "toàn bộ phần in vào READY hôm nay + cái nào đã hoàn thành". (best-effort tracking.)',
    loc: locList(['ngay', 'tram', 'nhom_bo_sung', 'tim']), cot: COT_VAO_TRAM, run: runPhanInVaoTram },
  { ma: 'DS_HOAN_THANH_TRAM', ten: 'Phần in hoàn thành / rời checkpoint (theo ngày)', don_vi_dong: 'phần in',
    mo_ta: '1 dòng = 1 phần in ĐÃ HOÀN THÀNH / rời 1 checkpoint. Lọc trạm = READY + ngày = Hôm nay '
      + '⇒ "danh sách READY đã hoàn thành hôm nay". (Nguồn lịch sử luân chuyển — best-effort.) '
      + 'Xem "đang ở READY hiện tại" ở nguồn "Phần in / đợt vải" với bộ lọc Trạm = READY.',
    loc: locList(['ngay', 'tram', 'nhom_bo_sung', 'tim']), cot: COT_HOAN_THANH, run: runHoanThanhTram },
  { ma: 'DS_READY_DANG_O', ten: 'Open — đang ở READY (hiện tại)', don_vi_dong: 'phần in',
    mo_ta: '1 dòng = 1 PHẦN IN ĐANG Ở READY hiện tại (còn đợt vải chưa Ready — khớp màn Chuẩn bị KT/QC). '
      + 'KHÔNG gồm phần in đã QA xác nhận READY — xem nguồn "READY đã hoàn thành" (24/09/2026).',
    loc: locList(['khach', 'nhom_bo_sung', 'tim']), cot: COT_READY_DANG_O, run: runReadyDangO },
  { ma: 'DS_READY_CHO_FILM', ten: 'Open chờ Film (đang ở READY, chưa xác nhận Film)', don_vi_dong: 'phần in',
    mo_ta: '1 dòng = 1 PHẦN IN đang ở READY mà CÒN ĐỢT VẢI chưa xác nhận Film. Cùng bộ cột với "Đang ở READY" '
      + '(nguồn Open) — luôn là TẬP CON của nguồn đó. Ảnh chụp HIỆN TẠI (không có bộ lọc ngày). '
      + '⚠ Khách gia công (II/AD) được miễn Film nên không có trong danh sách. '
      + '⚠ Danh sách này LUÔN trùng "Open chờ Khuôn": xác nhận Khuôn thì hệ thống tự đặt Film.',
    loc: locList(['khach', 'nhom_bo_sung', 'tim']), cot: COT_READY_CHO_MUC,
    run: (a) => runReadyDangO({ ...a, mucCho: 'FILM' }) },
  { ma: 'DS_READY_CHO_KHUON', ten: 'Open chờ Khuôn (đang ở READY, chưa xác nhận Khuôn)', don_vi_dong: 'phần in',
    mo_ta: '1 dòng = 1 PHẦN IN đang ở READY mà CÒN ĐỢT VẢI chưa xác nhận Khuôn. Cùng bộ cột với "Đang ở READY" '
      + '(nguồn Open) — luôn là TẬP CON của nguồn đó. Ảnh chụp HIỆN TẠI (không có bộ lọc ngày). '
      + '⚠ Khách gia công (II/AD) được miễn Khuôn nên không có trong danh sách.',
    loc: locList(['khach', 'nhom_bo_sung', 'tim']), cot: COT_READY_CHO_MUC,
    run: (a) => runReadyDangO({ ...a, mucCho: 'KHUON' }) },
  { ma: 'DS_READY_CHO_MUC', ten: 'Open chờ Mực (đang ở READY, chưa xác nhận Mực)', don_vi_dong: 'phần in',
    mo_ta: '1 dòng = 1 PHẦN IN đang ở READY mà CÒN ĐỢT VẢI chưa xác nhận Mực. Cùng bộ cột với "Đang ở READY" '
      + '(nguồn Open) — luôn là TẬP CON của nguồn đó. Ảnh chụp HIỆN TẠI (không có bộ lọc ngày). '
      + 'Mực là mục BẮT BUỘC với mọi khách, kể cả hàng gia công (II/AD).',
    loc: locList(['khach', 'nhom_bo_sung', 'tim']), cot: COT_READY_CHO_MUC,
    run: (a) => runReadyDangO({ ...a, mucCho: 'MUC' }) },
  { ma: 'DS_READY_HOAN_THANH', ten: 'Phần in đã hoàn thành READY (QC xác nhận, theo ngày)', don_vi_dong: 'phần in',
    mo_ta: '1 dòng = 1 PHẦN IN được QC xác nhận READY. Lọc ngày = Hôm nay ⇒ khớp sidebar "Đã hoàn thành" của màn QC READY '
      + '(kèm người xác nhận + giờ).',
    loc: locList(['ngay', 'nhom_bo_sung', 'tim']), cot: COT_READY_HOAN_THANH, run: runReadyHoanThanh },
  { ma: 'DS_TONG_HOP_TRAM', ten: 'Tổng hợp theo trạm (checkpoint)', don_vi_dong: 'trạm',
    mo_ta: '1 dòng = 1 checkpoint: vào/rời hôm nay, đang ở, đúng hạn, sắp nghẽn, nghẽn, điểm nghẽn. '
      + 'Dựng bảng kiểu "Kết quả pha màu - chụp khuôn - film - CNSP".',
    loc: locList(['tram']), cot: COT_TRAM, run: runTongHopTram },
];

const BY_MA = Object.fromEntries(DEFS.map((d) => [d.ma, d]));

// Danh mục cho FE (không kèm run).
const catalog = () => DEFS.map(({ run, ...d }) => d);

// Chạy 1 dataset → { cot: [...], rows: [...] }. `cot` = cột NGƯỜI DÙNG chọn (mặc định: 8 cột đầu).
async function runOne(cfg = {}) {
  const def = BY_MA[cfg.nguon];
  if (!def) return { cot: [], rows: [], loi: `Nguồn "${cfg.nguon}" không tồn tại` };
  try {
    const rows = await def.run({ loc: cfg.loc || {}, gioi_han: cfg.gioi_han });
    // SL bổ sung: không có đợt bổ sung (5I) ⇒ gạch ngang "-" (người dùng chốt 2026-09-14).
    rows.forEach((r) => { if ('sl_bo_sung' in r && r.sl_bo_sung == null) r.sl_bo_sung = '-'; });
    const keys = Array.isArray(cfg.cot) && cfg.cot.length ? cfg.cot : def.cot.slice(0, 8).map((c) => c.key);
    const cot = keys.map((k) => def.cot.find((c) => c.key === k)).filter(Boolean);
    return { cot, rows };
  } catch (e) {
    return { cot: [], rows: [], loi: e.message };
  }
}

// Chạy nhiều khối danh sách trong 1 báo cáo → { [cellKey]: {cot, rows} }.
async function computeBlocks(blocks) {
  const entries = await Promise.all(
    Object.entries(blocks).map(async ([key, cfg]) => [key, await runOne(cfg)])
  );
  return Object.fromEntries(entries);
}

module.exports = { catalog, runOne, computeBlocks, MAX_ROWS };
