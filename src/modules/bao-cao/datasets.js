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
  if (clean(loc.khach)) { params.push(clean(loc.khach)); conds.push(`kh.ten_khach_hang ILIKE '%'||$${params.length}||'%'`); }
  if (clean(loc.tim)) {
    params.push(clean(loc.tim));
    const i = params.length;
    conds.push(`(pin.ma_phan ILIKE '%'||$${i}||'%' OR mh.ma_hang ILIKE '%'||$${i}||'%' OR dh.ma_don_hang ILIKE '%'||$${i}||'%' OR pin.mau_vai ILIKE '%'||$${i}||'%')`);
  }
  const sql = `
    SELECT dv.id AS dot_vai_ve_id, pin.id AS phan_in_id, dv.ma_dot_vai,
           to_char(dv.ngay_vai_ve, 'DD/MM/YYYY') AS ngay_vai_ve,
           to_char(dv.han_giao_hang, 'DD/MM/YYYY') AS han_giao_hang,
           dv.so_luong_vai_ve, ldv.ten_loai AS loai_dot_vai,
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
  { key: 'so_luong_release', ten: 'SL release', kieu: 'so' },
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
  if (clean(loc.chuyen)) { params.push(clean(loc.chuyen)); conds.push(`cs.ten_chuyen ILIKE '%'||$${params.length}||'%'`); }
  if (clean(loc.trang_thai)) { params.push(clean(loc.trang_thai)); conds.push(`ls.trang_thai = $${params.length}`); }
  if (clean(loc.tim)) {
    params.push(clean(loc.tim));
    const i = params.length;
    conds.push(`(ls.ma_lenh_san_xuat ILIKE '%'||$${i}||'%' OR info.ma_phan ILIKE '%'||$${i}||'%' OR info.ma_hang ILIKE '%'||$${i}||'%' OR info.mau_vai ILIKE '%'||$${i}||'%')`);
  }
  const sql = `
    SELECT ls.id, ls.ma_lenh_san_xuat, ls.so_luong_release, ls.trang_thai AS tt,
           to_char(ls.ngay_ke_hoach, 'DD/MM/YYYY') AS ngay_ke_hoach,
           to_char(ls.tg_bd_kh AT TIME ZONE 'Asia/Ho_Chi_Minh', 'HH24:MI') AS gio_bd,
           to_char(ls.tg_kt_kh AT TIME ZONE 'Asia/Ho_Chi_Minh', 'HH24:MI') AS gio_kt,
           (SELECT count(*) FROM test_run tr WHERE tr.lenh_san_xuat_id = ls.id)::int AS so_lan_test,
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
           info.mau_vai, info.kich_vai, info.kich_phim, info.tinh_chat_in,
           to_char((SELECT min(dvh.han_giao_hang) FROM lenh_sx_dot_vai lsh JOIN dot_vai_ve dvh ON dvh.id = lsh.dot_vai_ve_id
              WHERE lsh.lenh_san_xuat_id = ls.id), 'DD/MM/YYYY') AS han_giao_hang,
           (SELECT COALESCE(sum(t.so_luong),0)::int FROM phieu_san_xuat ps JOIN tem t ON t.phieu_san_xuat_id = ps.id
              WHERE ps.lenh_san_xuat_id = ls.id AND t.trang_thai <> 'HUY') AS sl_da_in
    FROM lenh_san_xuat ls
    LEFT JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
    LEFT JOIN LATERAL (
      SELECT kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang,
             pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.ma_phan, pin.tinh_chat_in
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
  if (clean(loc.trang_thai)) { params.push(clean(loc.trang_thai)); conds.push(`t.trang_thai = $${params.length}`); }
  if (clean(loc.chuyen)) { params.push(clean(loc.chuyen)); conds.push(`cs.ten_chuyen ILIKE '%'||$${params.length}||'%'`); }
  if (clean(loc.tim)) {
    params.push(clean(loc.tim));
    const i = params.length;
    conds.push(`(t.ma_tem ILIKE '%'||$${i}||'%' OR info.ma_phan ILIKE '%'||$${i}||'%' OR info.ma_hang ILIKE '%'||$${i}||'%')`);
  }
  const sql = `
    SELECT t.id, t.ma_tem, t.so_luong, t.trang_thai AS tt,
           to_char(t.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY') AS ngay_in_tem,
           t.sl_kcs_dat, t.sl_kcs_sua, t.sl_kcs_huy, t.sl_sua_dat, t.sl_sua_huy, t.sl_oqc_dat, t.sl_da_giao,
           cs.ten_chuyen, info.ten_khach_hang, info.ma_don_hang, info.ma_hang, info.ma_phan, info.mau_vai, info.kich_vai
    FROM tem t
    JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
    JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
    LEFT JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
    LEFT JOIN LATERAL (
      SELECT kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang, pin.ma_phan, pin.mau_vai, pin.kich_vai
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
];

// 1 phần in = 1 dòng cho MỖI checkpoint (DISTINCT ON phần in + trạm, lấy lượt hoàn thành muộn nhất trong
// khoảng ngày đã lọc) ⇒ độ dài danh sách KHỚP số đếm distinct của metric CP_*_ROI_HOM_NAY (trước đây đếm
// theo LƯỢT nên phình: 1 phần in rời/mở-lại nhiều lần = nhiều dòng).
// READY: nguồn = QC xác nhận (ket_qua_checkpoint QC_XAC_NHAN=DAT) — mốc READY hoàn tất THẬT, tin cậy.
// Các trạm khác: nguồn = lich_su_luan_chuyen.tg_kt (best-effort, nhưng deduped theo phần in).
const READY_TS = 'COALESCE(kq.tg_xac_nhan, kq.created_date)';
async function runHoanThanhTram({ loc = {}, gioi_han }) {
  const tram = clean(loc.tram);
  const params = [];
  let includeReady = true;
  let includeOther = true;
  if (tram === 'READY') includeOther = false;
  else if (tram) includeReady = false;

  const branches = [];
  if (includeReady) {
    const rConds = ["cp.ma_checkpoint = 'QC_XAC_NHAN'", "kq.trang_thai = 'DAT'", 'pin.dang_hoat_dong'];
    const rnc = ngayCond(READY_TS, loc.ngay, true);
    if (rnc) rConds.push(rnc);
    branches.push(`SELECT pin.id AS phan_in_id, 'READY'::text AS ma_tram, 'READY (chuẩn bị KT)'::text AS ten_tram, ${READY_TS} AS tg_done
      FROM ket_qua_checkpoint kq JOIN checkpoint cp ON cp.id = kq.checkpoint_id JOIN phan_in pin ON pin.id = kq.phan_in_id
      WHERE ${rConds.join(' AND ')}`);
  }
  if (includeOther) {
    const oConds = ["tr.ma_tram <> 'READY'", 'l.tg_kt IS NOT NULL', 'pin.dang_hoat_dong'];
    const onc = ngayCond('l.tg_kt', loc.ngay, true);
    if (onc) oConds.push(onc);
    if (tram) { params.push(tram); oConds.push(`tr.ma_tram = $${params.length}`); }
    branches.push(`SELECT l.phan_in_id, tr.ma_tram, tr.ten_tram, l.tg_kt AS tg_done
      FROM lich_su_luan_chuyen l JOIN tram tr ON tr.id = l.den_tram_id JOIN phan_in pin ON pin.id = l.phan_in_id
      WHERE ${oConds.join(' AND ')}`);
  }

  const outer = [];
  if (clean(loc.tim)) {
    params.push(clean(loc.tim));
    const i = params.length;
    outer.push(`(pin.ma_phan ILIKE '%'||$${i}||'%' OR mh.ma_hang ILIKE '%'||$${i}||'%' OR dh.ma_don_hang ILIKE '%'||$${i}||'%' OR pin.mau_vai ILIKE '%'||$${i}||'%')`);
  }
  const sql = `
    WITH done AS (${branches.join(' UNION ALL ')}),
    dedup AS (
      SELECT DISTINCT ON (phan_in_id, ma_tram) phan_in_id, ma_tram, ten_tram, tg_done
      FROM done ORDER BY phan_in_id, ma_tram, tg_done DESC
    )
    SELECT to_char(d.tg_done AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY') AS ngay_hoan_thanh,
           to_char(d.tg_done AT TIME ZONE 'Asia/Ho_Chi_Minh', 'HH24:MI') AS gio_hoan_thanh,
           d.ten_tram, kh.ten_khach_hang, dh.ma_don_hang,
           pin.ma_phan, mh.ma_hang, pin.mau_vai, pin.kich_vai, pin.kich_phim
    FROM dedup d
    JOIN phan_in pin ON pin.id = d.phan_in_id
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    ${outer.length ? 'WHERE ' + outer.join(' AND ') : ''}
    ORDER BY d.tg_done DESC
    LIMIT ${limitOf(gioi_han)}`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), params);
  return rows.map((r, i) => ({ ...r, stt: i + 1 }));
}

// ============================== 3c) ĐANG Ở READY / HOÀN THÀNH READY (khớp màn Chuẩn bị KT / QC) ==============================
// 2 danh sách này CỐ Ý dùng ĐÚNG nguồn của màn "Chuẩn bị kỹ thuật" & "QC READY" để số liệu KHỚP MÀN
// (không lệch như DS_PHAN_IN — cái đó đếm ĐỢT VẢI ở flowRows). Đơn vị = PHẦN IN (1 dòng = 1 phần in).

// Điều kiện "phần in đang ở READY" — trích y hệt technical.listCandidates: còn đợt vải CHƯA release
// (đã chuyển READY) HOẶC chưa có đợt vải nào, và phần in đang hoạt động.
const READY_MEMBER = `(EXISTS (SELECT 1 FROM dot_vai_ve dvu WHERE dvu.phan_in_id = pin.id AND dvu.trang_thai <> 'DA_GOP' AND dvu.tg_chuyen_ready IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai lsu JOIN lenh_san_xuat lu ON lu.id = lsu.lenh_san_xuat_id WHERE lsu.dot_vai_ve_id = dvu.id AND lu.trang_thai <> 'HUY'))
    OR NOT EXISTS (SELECT 1 FROM dot_vai_ve dvz WHERE dvz.phan_in_id = pin.id AND dvz.trang_thai <> 'DA_GOP'))`;
const QC_DONE_EXISTS = `EXISTS (SELECT 1 FROM ket_qua_checkpoint k JOIN checkpoint cp ON cp.id = k.checkpoint_id
    WHERE k.phan_in_id = pin.id AND cp.ma_checkpoint = 'QC_XAC_NHAN' AND k.trang_thai = 'DAT')`;
const readyMark = (maCp) => `(CASE WHEN EXISTS (SELECT 1 FROM ket_qua_checkpoint k JOIN checkpoint cp ON cp.id = k.checkpoint_id
    WHERE k.phan_in_id = pin.id AND cp.ma_checkpoint = '${maCp}' AND k.trang_thai = 'DAT') THEN 'Đã' ELSE '' END)`;

const COT_READY_DANG_O = [
  { key: 'stt', ten: 'STT', kieu: 'so' },
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
  { key: 'han_giao_hang', ten: 'Hạn giao', kieu: 'ngay' },
  { key: 'ready_khuon', ten: 'Khuôn', kieu: 'text' },
  { key: 'ready_film', ten: 'Film', kieu: 'text' },
  { key: 'ready_muc', ten: 'Mực', kieu: 'text' },
  { key: 'so_muc_kt', ten: 'Mục KT xong', kieu: 'text' },
  { key: 'qc_ready', ten: 'QC READY', kieu: 'text' },
];

async function runReadyDangO({ loc = {}, gioi_han }) {
  const params = [];
  const conds = ['pin.dang_hoat_dong', READY_MEMBER, `NOT ${QC_DONE_EXISTS}`];
  if (clean(loc.khach)) { params.push(clean(loc.khach)); conds.push(`kh.ten_khach_hang ILIKE '%'||$${params.length}||'%'`); }
  if (clean(loc.tim)) {
    params.push(clean(loc.tim));
    const i = params.length;
    conds.push(`(pin.ma_phan ILIKE '%'||$${i}||'%' OR mh.ma_hang ILIKE '%'||$${i}||'%' OR dh.ma_don_hang ILIKE '%'||$${i}||'%' OR pin.mau_vai ILIKE '%'||$${i}||'%')`);
  }
  const sql = `
    SELECT pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.tinh_chat_in, pin.so_luong_don_hang,
           mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang,
           (SELECT COALESCE(sum(dv5.so_luong_vai_ve),0) FROM dot_vai_ve dv5 WHERE dv5.phan_in_id = pin.id AND dv5.trang_thai NOT IN ('DA_GOP','DA_HUY'))::int AS so_luong_vai_ve,
           to_char((SELECT min(dv4.han_giao_hang) FROM dot_vai_ve dv4 WHERE dv4.phan_in_id = pin.id AND dv4.trang_thai NOT IN ('DA_GOP','DA_HUY')), 'DD/MM/YYYY') AS han_giao_hang,
           ${readyMark('KHUON')} AS ready_khuon, ${readyMark('FILM')} AS ready_film, ${readyMark('MUC')} AS ready_muc,
           ((SELECT count(*) FROM ket_qua_checkpoint k JOIN checkpoint cp ON cp.id = k.checkpoint_id
              WHERE k.phan_in_id = pin.id AND cp.ma_checkpoint IN ('KHUON','FILM','MUC') AND k.trang_thai = 'DAT')::text || '/3') AS so_muc_kt,
           '' AS qc_ready
    FROM phan_in pin
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    WHERE ${conds.join(' AND ')}
    ORDER BY kh.ten_khach_hang, dh.ma_don_hang, pin.ma_phan
    LIMIT ${limitOf(gioi_han)}`;
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim(), params);
  return rows.map((r, i) => ({ ...r, stt: i + 1 }));
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
  { key: 'so_luong_vai_ve', ten: 'SL nhận vải', kieu: 'so' },
];

// Danh sách phần in đã hoàn thành READY (QC xác nhận) — khớp sidebar "Đã hoàn thành" (scope QC) màn QC READY.
async function runReadyHoanThanh({ loc = {}, gioi_han }) {
  const params = [];
  const conds = ["cp.ma_checkpoint = 'QC_XAC_NHAN'", "kq.trang_thai = 'DAT'", 'pin.dang_hoat_dong'];
  const nc = ngayCond(READY_TS, loc.ngay, true);
  if (nc) conds.push(nc);
  if (clean(loc.tim)) {
    params.push(clean(loc.tim));
    const i = params.length;
    conds.push(`(pin.ma_phan ILIKE '%'||$${i}||'%' OR mh.ma_hang ILIKE '%'||$${i}||'%' OR dh.ma_don_hang ILIKE '%'||$${i}||'%' OR pin.mau_vai ILIKE '%'||$${i}||'%')`);
  }
  const sql = `
    SELECT to_char(${READY_TS} AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY') AS ngay_hoan_thanh,
           to_char(${READY_TS} AT TIME ZONE 'Asia/Ho_Chi_Minh', 'HH24:MI') AS gio_hoan_thanh,
           nx.ho_ten AS nguoi_xac_nhan,
           pin.ma_phan, mh.ma_hang, kh.ten_khach_hang, dh.ma_don_hang, pin.mau_vai, pin.kich_vai, pin.kich_phim,
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
  const { rows: llc } = await query(`
    SELECT tr.ma_tram,
           count(DISTINCT l.phan_in_id) FILTER (WHERE (l.tg_bd AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = ${VN_TODAY})::int AS vao,
           count(DISTINCT l.phan_in_id) FILTER (WHERE l.tg_kt IS NOT NULL AND (l.tg_kt AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = ${VN_TODAY})::int AS roi
    FROM lich_su_luan_chuyen l JOIN tram tr ON tr.id = l.den_tram_id GROUP BY tr.ma_tram`.replace(/\s+/g, ' ').trim());
  const llcBy = Object.fromEntries(llc.map((r) => [r.ma_tram, r]));

  // READY "rời/hoàn thành hôm nay" = QC xác nhận (tin cậy), KHÔNG dùng lich_su_luan_chuyen (over-count).
  const { rows: qcRoi } = await query(`SELECT count(DISTINCT kq.phan_in_id)::int AS roi
    FROM ket_qua_checkpoint kq JOIN checkpoint cp ON cp.id = kq.checkpoint_id JOIN phan_in pin ON pin.id = kq.phan_in_id
    WHERE cp.ma_checkpoint = 'QC_XAC_NHAN' AND kq.trang_thai = 'DAT' AND pin.dang_hoat_dong
      AND (COALESCE(kq.tg_xac_nhan, kq.created_date) AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = ${VN_TODAY}`.replace(/\s+/g, ' ').trim());
  const readyRoi = qcRoi[0] ? qcRoi[0].roi : 0;
  if (llcBy.READY) llcBy.READY.roi = readyRoi; else llcBy.READY = { vao: 0, roi: readyRoi };

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
  tram: { ma: 'tram', ten: 'Trạm (checkpoint)', kieu: 'chon', chon: TRAM_OPTS },
  chuyen: { ma: 'chuyen', ten: 'Chuyền', kieu: 'chu' },
  khach: { ma: 'khach', ten: 'Khách hàng', kieu: 'chu' },
  tim: { ma: 'tim', ten: 'Tìm kiếm', kieu: 'chu', mo_ta: 'Code phần / mã hàng / PO / màu vải...' },
  trang_thai_lsx: { ma: 'trang_thai', ten: 'Trạng thái lệnh', kieu: 'chon',
    chon: () => Object.entries(LSX_TT).filter(([v]) => v !== 'HUY').map(([v, ten]) => ({ v, ten })) },
  trang_thai_tem: { ma: 'trang_thai', ten: 'Trạng thái tem', kieu: 'chon',
    chon: () => Object.entries(TEM_TT).filter(([v]) => v !== 'HUY').map(([v, ten]) => ({ v, ten })) },
};
const locList = (keys) => keys.map((k) => {
  const d = LOC_DEF[k];
  return { ...d, chon: typeof d.chon === 'function' ? d.chon() : undefined };
});

// ============================== REGISTRY ==============================
const DEFS = [
  { ma: 'DS_PHAN_IN', ten: 'Phần in / đợt vải (theo ngày, trạm)', don_vi_dong: 'đợt vải',
    mo_ta: '1 dòng = 1 đợt vải của phần in, kèm trạm hiện tại + SLA. Dựng bảng kiểu "Hệ điều hành nhà máy in lụa".',
    loc: locList(['ngay', 'tram', 'khach', 'tim']), cot: COT_PHAN_IN, run: runPhanIn },
  { ma: 'DS_DOT_SAN_XUAT', ten: 'Đợt sản xuất / lệnh SX (theo ngày, chuyền)', don_vi_dong: 'lệnh SX',
    mo_ta: '1 dòng = 1 đợt sản xuất (lệnh SX) theo ngày kế hoạch. Dựng bảng kiểu "Test Run bàn A/B / máy tự động".',
    loc: locList(['ngay', 'chuyen', 'trang_thai_lsx', 'tim']), cot: COT_DOT_SX, run: runDotSanXuat },
  { ma: 'DS_TEM', ten: 'Tem (KCS / Sửa / OQC / Giao)', don_vi_dong: 'tem',
    mo_ta: '1 dòng = 1 tem theo ngày in tem, kèm sổ cái số lượng từng công đoạn.',
    loc: locList(['ngay', 'trang_thai_tem', 'chuyen', 'tim']), cot: COT_TEM, run: runTem },
  { ma: 'DS_HOAN_THANH_TRAM', ten: 'Phần in hoàn thành / rời checkpoint (theo ngày)', don_vi_dong: 'phần in',
    mo_ta: '1 dòng = 1 phần in ĐÃ HOÀN THÀNH / rời 1 checkpoint. Lọc trạm = READY + ngày = Hôm nay '
      + '⇒ "danh sách READY đã hoàn thành hôm nay". (Nguồn lịch sử luân chuyển — best-effort.) '
      + 'Xem "đang ở READY hiện tại" ở nguồn "Phần in / đợt vải" với bộ lọc Trạm = READY.',
    loc: locList(['ngay', 'tram', 'tim']), cot: COT_HOAN_THANH, run: runHoanThanhTram },
  { ma: 'DS_READY_DANG_O', ten: 'Đang ở READY hiện tại (khớp màn Chuẩn bị KT / QC)', don_vi_dong: 'phần in',
    mo_ta: '1 dòng = 1 PHẦN IN đang ở READY hiện tại (chưa QC xác nhận, còn đợt vải chưa release). '
      + 'Dùng ĐÚNG nguồn của màn "Chuẩn bị kỹ thuật" / "QC READY" ⇒ số liệu KHỚP MÀN (đơn vị phần in, không phải đợt vải).',
    loc: locList(['khach', 'tim']), cot: COT_READY_DANG_O, run: runReadyDangO },
  { ma: 'DS_READY_HOAN_THANH', ten: 'Phần in đã hoàn thành READY (QC xác nhận, theo ngày)', don_vi_dong: 'phần in',
    mo_ta: '1 dòng = 1 PHẦN IN được QC xác nhận READY. Lọc ngày = Hôm nay ⇒ khớp sidebar "Đã hoàn thành" của màn QC READY '
      + '(kèm người xác nhận + giờ).',
    loc: locList(['ngay', 'tim']), cot: COT_READY_HOAN_THANH, run: runReadyHoanThanh },
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
