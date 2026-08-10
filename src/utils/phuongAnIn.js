'use strict';

// ─── HIỂN THỊ THEO PHƯƠNG ÁN IN — CẤU HÌNH ĐỘNG (mig 067) ────────────────────
// Mỗi TRANG có dòng chảy phần in/tem bật/tắt độc lập 4 nhóm: Máy (2) · Bàn (1) · Robot (3) ·
// Khác (0/NULL/không có HSKT active). Cấu hình ở **Hệ thống > Hiển thị theo phương án in**.
//
// ⚠ MẶC ĐỊNH BẬT HẾT ⇒ điều kiện SQL trả `TRUE` (không sinh EXISTS) — hệ thống chạy y như khi chưa
//   có tính năng này, không tốn thêm chi phí truy vấn. Chỉ khi người dùng TẮT bớt nhóm mới lọc thật.
// ⚠ Thay cho bộ lọc CỨNG "chỉ hiện hàng in Máy" (chốt rồi gỡ trong cùng ngày 2026-08-04).
const { query } = require('../config/db');

const PAIN_MAY = 2;
const PAIN_BAN = 1;
const PAIN_ROBOT = 3;

// Danh mục TRANG có dòng chảy phần in — nguồn duy nhất cho cả API lẫn giao diện cấu hình.
// Thêm trang mới: khai ở đây + truyền `maTrang` vào query tương ứng (không cần migration).
// Danh mục TRANG có dòng chảy phần in — **GOM ĐÚNG THEO MODULE THẬT của app**
// (`frontend/src/constants/modules.js`), KHÔNG tự đặt nhóm: KCS/Sửa nằm ở **Sản xuất**,
// QC chuẩn bị kỹ thuật + Test Run QA nằm ở **Chất lượng**, READY/Gom set ở **Chuẩn bị kỹ thuật**.
// Thứ tự dòng = thứ tự dòng chảy. Thêm trang mới: khai ở đây + truyền `maTrang` vào query (KHÔNG cần migration).
// `muc` = mức đối tượng câu truy vấn của trang đó (`pin` | `lenh` | `phieu`) — PHẢI KHỚP tham số `muc`
// mà repository truyền vào `dkTrang`. Chỉ dùng để GIAO DIỆN biết trang nào áp được lọc theo LOẠI CHUYỀN:
// loại chuyền là thuộc tính của LỆNH (`lenh_san_xuat.chuyen_id`) nên các trang TRƯỚC release
// (`muc='pin'`: READY, Gom set, Release 1, Kế hoạch tạm, Đơn hàng, Dashboard) chưa có chuyền ⇒ bỏ qua.
const TRANG_PAIN = [
  { ma: 'DH_PHAN_IN', module: 'Đơn hàng', ten: 'Danh sách phần in vải về', muc: 'pin' },

  { ma: 'KT_READY', module: 'Chuẩn bị kỹ thuật', ten: 'Xác nhận READY', muc: 'pin' },
  { ma: 'KT_GOM_SET', module: 'Chuẩn bị kỹ thuật', ten: 'Gom set', muc: 'pin' },

  { ma: 'KH_TAO_DOT_SX', module: 'Kế hoạch', ten: 'Tạo đợt sản xuất', muc: 'pin' },
  { ma: 'KH_RELEASE1', module: 'Kế hoạch', ten: 'Release 1', muc: 'pin' },
  { ma: 'KH_RELEASE2', module: 'Kế hoạch', ten: 'Release 2', muc: 'lenh' },
  { ma: 'KH_GIA_CONG', module: 'Kế hoạch', ten: 'Gia công', muc: 'lenh' },
  { ma: 'KH_TAM', module: 'Kế hoạch', ten: 'Kế hoạch tạm', muc: 'pin' },
  { ma: 'KH_REPLAN', module: 'Kế hoạch', ten: 'Lập kế hoạch lại', muc: 'lenh' },

  { ma: 'SX_CHO_CHAY', module: 'Sản xuất', ten: 'Xác nhận chạy — Chờ chạy', muc: 'lenh' },
  { ma: 'SX_DANG_CHAY', module: 'Sản xuất', ten: 'Xác nhận chạy — Đang chạy', muc: 'lenh' },
  { ma: 'SX_THEO_DOI', module: 'Sản xuất', ten: 'Theo dõi chuyền', muc: 'lenh' },
  { ma: 'SX_KCS', module: 'Sản xuất', ten: 'KCS', muc: 'phieu' },
  { ma: 'SX_SUA', module: 'Sản xuất', ten: 'Sửa', muc: 'phieu' },
  { ma: 'SX_PHAN_LOAI_LOI', module: 'Sản xuất', ten: 'Phân loại lỗi', muc: 'phieu' },

  { ma: 'CL_QC_READY', module: 'Chất lượng', ten: 'QC chuẩn bị kỹ thuật', muc: 'pin' },
  { ma: 'CL_TEST_RUN', module: 'Chất lượng', ten: 'Test Run - QA', muc: 'lenh' },
  { ma: 'CL_OQC', module: 'Chất lượng', ten: 'OQC', muc: 'phieu' },

  { ma: 'GH_TEM', module: 'Giao hàng', ten: 'Phiếu giao — tem chờ giao', muc: 'phieu' },

  { ma: 'DB_TONG_QUAN', module: 'Dashboard', ten: 'Tổng quan (ô giai đoạn / biểu đồ)', muc: 'pin' },
  { ma: 'DB_NGHEN', module: 'Dashboard', ten: 'Bản đồ nghẽn / Điều phối', muc: 'pin' },
];
const MA_TRANG = TRANG_PAIN.map((t) => t.ma);
const BAT_HET = { may: true, ban: true, robot: true, khac: true };
// Nhóm "chưa xác định" của chiều LOẠI CHUYỀN: lệnh chưa gán chuyền / chuyền không có loại.
const LC_KHAC = 'KHAC';

// Cache toàn cục (cấu hình đổi rất hiếm; `xoaCache()` gọi ngay sau khi lưu).
let cache = null;
let cacheLoai = null;   // danh mục loại chuyền (đọc từ DB, đổi rất hiếm)
let coCotLoaiChuyen = null; // null = chưa dò; true/false = kết quả dò mig 069
function xoaCache() { cache = null; cacheLoai = null; }

// Dò cột `loai_chuyen` (mig 069). Chỉ CACHE khi ĐÃ có ⇒ chạy migration xong là nhận ngay, khỏi restart BE.
async function dbCoCotLoaiChuyen() {
  if (coCotLoaiChuyen) return true;
  try {
    const { rows } = await query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema='public'
        AND table_name='cai_dat_hien_pain' AND column_name='loai_chuyen' LIMIT 1`.replace(/\s+/g, ' ')
    );
    coCotLoaiChuyen = rows.length > 0;
  } catch (e) { coCotLoaiChuyen = false; }
  return coCotLoaiChuyen;
}

// Danh mục LOẠI CHUYỀN đang hoạt động + nhóm "Khác" ở cuối. Thiếu bảng → chỉ còn "Khác".
async function loadLoaiChuyen() {
  if (cacheLoai) return cacheLoai;
  let ds = [];
  try {
    const { rows } = await query(
      `SELECT ma_loai AS key, ten_loai AS label FROM loai_chuyen
        WHERE dang_hoat_dong ORDER BY ten_loai`.replace(/\s+/g, ' ')
    );
    ds = rows;
  } catch (e) { /* best-effort */ }
  cacheLoai = [...ds, { key: LC_KHAC, label: 'Khác (chưa gán chuyền)' }];
  return cacheLoai;
}

// Đọc cấu hình mọi trang. Thiếu bảng (chưa chạy mig 067) hoặc thiếu dòng → BẬT HẾT.
// `loai_chuyen` (mig 069) là JSONB `{ma_loai: bool}`; THIẾU KHÓA = BẬT ⇒ thêm loại chuyền mới không
// cần migration/seed và cũng không tự dưng bị ẩn.
async function loadCauHinhPain() {
  if (cache) return cache;
  const coLC = await dbCoCotLoaiChuyen();
  const out = {};
  MA_TRANG.forEach((ma) => { out[ma] = { ...BAT_HET, loai_chuyen: {} }; });
  try {
    const { rows } = await query(
      `SELECT ma_trang, may, ban, robot, khac${coLC ? ', loai_chuyen' : ''} FROM cai_dat_hien_pain`
    );
    rows.forEach((r) => {
      if (out[r.ma_trang]) {
        out[r.ma_trang] = {
          may: r.may, ban: r.ban, robot: r.robot, khac: r.khac,
          loai_chuyen: (r.loai_chuyen && typeof r.loai_chuyen === 'object') ? r.loai_chuyen : {},
        };
      }
    });
  } catch (e) { /* chưa có bảng → giữ mặc định bật hết */ }
  cache = out;
  return out;
}

async function luuCauHinhPain(rows, actorId) {
  const coLC = await dbCoCotLoaiChuyen();
  for (const r of rows || []) {
    if (!MA_TRANG.includes(r.ma_trang)) continue;
    const lc = (r.loai_chuyen && typeof r.loai_chuyen === 'object') ? r.loai_chuyen : {};
    await query(
      `INSERT INTO cai_dat_hien_pain (ma_trang, may, ban, robot, khac, created_by${coLC ? ', loai_chuyen' : ''})
       VALUES ($1,$2,$3,$4,$5,$6${coLC ? ',$7::jsonb' : ''})
       ON CONFLICT (ma_trang) DO UPDATE SET may=EXCLUDED.may, ban=EXCLUDED.ban, robot=EXCLUDED.robot,
         khac=EXCLUDED.khac${coLC ? ', loai_chuyen=EXCLUDED.loai_chuyen' : ''},
         updated_by=EXCLUDED.created_by, updated_date=now()`,
      [r.ma_trang, !!r.may, !!r.ban, !!r.robot, !!r.khac, actorId || null,
        ...(coLC ? [JSON.stringify(lc)] : [])]
    );
  }
  xoaCache();
}

// Danh sách giá trị `phuong_an_in` được HIỆN + có hiện nhóm "Khác" hay không.
function nhomDuocHien(cf) {
  const vals = [];
  if (cf.may) vals.push(PAIN_MAY);
  if (cf.ban) vals.push(PAIN_BAN);
  if (cf.robot) vals.push(PAIN_ROBOT);
  return { vals, khac: !!cf.khac };
}

// Dựng điều kiện SQL cho 1 trang. `pinExpr` = biểu thức id phần in trong câu gọi (vd 'pin.id').
// Trả 'TRUE' khi bật hết (không lọc) và 'FALSE' khi tắt hết (ẩn sạch — đúng ý người cấu hình).
function dieuKienPain(cf, pinExpr) {
  const { vals, khac } = nhomDuocHien(cf || BAT_HET);
  if (vals.length === 3 && khac) return 'TRUE';
  if (vals.length === 0 && !khac) return 'FALSE';
  // `pa` = phương án in của HSKT đang hoạt động (NULL nếu phần in không có HSKT).
  const pa = `(SELECT h_m.phuong_an_in FROM hskt_phan_in hp_m
                 JOIN ho_so_ky_thuat h_m ON h_m.id = hp_m.hskt_id AND h_m.dang_hoat_dong
                WHERE hp_m.phan_in_id = ${pinExpr} AND hp_m.dang_hoat_dong LIMIT 1)`;
  const ve = [];
  if (vals.length) ve.push(`${pa} = ANY(ARRAY[${vals.join(',')}])`);
  // "Khác" = chưa xác định (0) hoặc phần in không có HSKT active (NULL).
  if (khac) ve.push(`COALESCE(${pa}, 0) = 0`);
  return `(${ve.join(' OR ')})`.replace(/\s+/g, ' ');
}

// 3 biến thể theo mức đối tượng của câu truy vấn gọi.
const theoPhanIn = (cf, pinCol) => dieuKienPain(cf, pinCol);

const theoLenh = (cf, lenhCol) => {
  const dk = dieuKienPain(cf, 'dv_m.phan_in_id');
  if (dk === 'TRUE') return 'TRUE';
  if (dk === 'FALSE') return 'FALSE';
  return `EXISTS (SELECT 1 FROM lenh_sx_dot_vai lsd_m JOIN dot_vai_ve dv_m ON dv_m.id = lsd_m.dot_vai_ve_id
            WHERE lsd_m.lenh_san_xuat_id = ${lenhCol} AND ${dk})`.replace(/\s+/g, ' ');
};

// Tem/KCS/Sửa/OQC/Giao: nối tem → phiếu → lệnh → đợt vải → phần in.
const theoPhieu = (cf, phieuCol) => {
  const dk = dieuKienPain(cf, 'dv_m.phan_in_id');
  if (dk === 'TRUE') return 'TRUE';
  if (dk === 'FALSE') return 'FALSE';
  return `EXISTS (SELECT 1 FROM phieu_san_xuat ps_m
            JOIN lenh_sx_dot_vai lsd_m ON lsd_m.lenh_san_xuat_id = ps_m.lenh_san_xuat_id
            JOIN dot_vai_ve dv_m ON dv_m.id = lsd_m.dot_vai_ve_id
           WHERE ps_m.id = ${phieuCol} AND ${dk})`.replace(/\s+/g, ' ');
};

// ─── LỌC THEO LOẠI CHUYỀN (mig 069) ──────────────────────────────────────────
// Loại chuyền thuộc về LỆNH (`lenh_san_xuat.chuyen_id` → `chuyen_san_xuat.loai_chuyen_id`), khác hẳn
// phương án in (thuộc PHẦN IN qua HSKT) ⇒ chỉ áp cho truy vấn mức `lenh`/`phieu`.
// `cfLC` = { ma_loai: bool }, THIẾU KHÓA = BẬT. Bật hết → 'TRUE' (không sinh subquery), tắt hết → 'FALSE'.
function dieuKienLoaiChuyen(cfLC, danhMuc, maLoaiExpr) {
  const tat = danhMuc.filter((x) => cfLC[x.key] === false);
  if (!tat.length) return 'TRUE';                       // không tắt cái nào → không lọc
  if (tat.length === danhMuc.length) return 'FALSE';    // tắt sạch → ẩn hết
  const bat = danhMuc.filter((x) => cfLC[x.key] !== false);
  const codes = bat.filter((x) => x.key !== LC_KHAC).map((x) => `'${x.key}'`);
  const coKhac = bat.some((x) => x.key === LC_KHAC);
  const ve = [];
  if (codes.length) ve.push(`${maLoaiExpr} = ANY(ARRAY[${codes.join(',')}])`);
  if (coKhac) ve.push(`${maLoaiExpr} IS NULL`);
  return `(${ve.join(' OR ')})`;
}

// Mã loại chuyền của 1 LỆNH / 1 PHIẾU (NULL = chưa gán chuyền hoặc chuyền không có loại → nhóm "Khác").
const maLoaiTheoLenh = (lenhCol) => `(SELECT lc_m.ma_loai FROM lenh_san_xuat ls_m
    LEFT JOIN chuyen_san_xuat cs_m ON cs_m.id = ls_m.chuyen_id
    LEFT JOIN loai_chuyen lc_m ON lc_m.id = cs_m.loai_chuyen_id
   WHERE ls_m.id = ${lenhCol})`.replace(/\s+/g, ' ');

const maLoaiTheoPhieu = (phieuCol) => `(SELECT lc_m.ma_loai FROM phieu_san_xuat ps_m
    JOIN lenh_san_xuat ls_m ON ls_m.id = ps_m.lenh_san_xuat_id
    LEFT JOIN chuyen_san_xuat cs_m ON cs_m.id = ls_m.chuyen_id
    LEFT JOIN loai_chuyen lc_m ON lc_m.id = cs_m.loai_chuyen_id
   WHERE ps_m.id = ${phieuCol})`.replace(/\s+/g, ' ');

// Ghép 2 điều kiện (phương án in AND loại chuyền), rút gọn TRUE/FALSE để không phình câu SQL.
function vaDieuKien(a, b) {
  if (a === 'FALSE' || b === 'FALSE') return 'FALSE';
  if (a === 'TRUE') return b;
  if (b === 'TRUE') return a;
  return `(${a} AND ${b})`;
}

// Lấy điều kiện cho 1 trang trong 1 lần gọi (dùng ở repository).
async function dkTrang(maTrang, muc, col) {
  const cf = (await loadCauHinhPain())[maTrang] || BAT_HET;
  const dkPain = muc === 'lenh' ? theoLenh(cf, col)
    : muc === 'phieu' ? theoPhieu(cf, col)
      : theoPhanIn(cf, col);
  if (muc !== 'lenh' && muc !== 'phieu') return dkPain; // mức phần in: chưa có chuyền → bỏ qua loại chuyền
  const danhMuc = await loadLoaiChuyen();
  const dkLoai = dieuKienLoaiChuyen(cf.loai_chuyen || {}, danhMuc,
    muc === 'lenh' ? maLoaiTheoLenh(col) : maLoaiTheoPhieu(col));
  return vaDieuKien(dkPain, dkLoai);
}

module.exports = {
  PAIN_MAY, PAIN_BAN, PAIN_ROBOT, TRANG_PAIN, MA_TRANG, BAT_HET, LC_KHAC,
  loadCauHinhPain, luuCauHinhPain, loadLoaiChuyen, xoaCache, dkTrang,
};
