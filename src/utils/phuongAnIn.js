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
const TRANG_PAIN = [
  { ma: 'DH_PHAN_IN', module: 'Đơn hàng', ten: 'Danh sách phần in vải về' },

  { ma: 'KT_READY', module: 'Chuẩn bị kỹ thuật', ten: 'Xác nhận READY' },
  { ma: 'KT_GOM_SET', module: 'Chuẩn bị kỹ thuật', ten: 'Gom set' },

  { ma: 'KH_TAO_DOT_SX', module: 'Kế hoạch', ten: 'Tạo đợt sản xuất' },
  { ma: 'KH_RELEASE1', module: 'Kế hoạch', ten: 'Release 1' },
  { ma: 'KH_RELEASE2', module: 'Kế hoạch', ten: 'Release 2' },
  { ma: 'KH_GIA_CONG', module: 'Kế hoạch', ten: 'Gia công' },
  { ma: 'KH_TAM', module: 'Kế hoạch', ten: 'Kế hoạch tạm' },
  { ma: 'KH_REPLAN', module: 'Kế hoạch', ten: 'Lập kế hoạch lại' },

  { ma: 'SX_CHO_CHAY', module: 'Sản xuất', ten: 'Xác nhận chạy — Chờ chạy' },
  { ma: 'SX_DANG_CHAY', module: 'Sản xuất', ten: 'Xác nhận chạy — Đang chạy' },
  { ma: 'SX_THEO_DOI', module: 'Sản xuất', ten: 'Theo dõi chuyền' },
  { ma: 'SX_KCS', module: 'Sản xuất', ten: 'KCS' },
  { ma: 'SX_SUA', module: 'Sản xuất', ten: 'Sửa' },

  { ma: 'CL_QC_READY', module: 'Chất lượng', ten: 'QC chuẩn bị kỹ thuật' },
  { ma: 'CL_TEST_RUN', module: 'Chất lượng', ten: 'Test Run - QA' },
  { ma: 'CL_OQC', module: 'Chất lượng', ten: 'OQC' },

  { ma: 'GH_TEM', module: 'Giao hàng', ten: 'Phiếu giao — tem chờ giao' },

  { ma: 'DB_TONG_QUAN', module: 'Dashboard', ten: 'Tổng quan (ô giai đoạn / biểu đồ)' },
  { ma: 'DB_NGHEN', module: 'Dashboard', ten: 'Bản đồ nghẽn / Điều phối' },
];
const MA_TRANG = TRANG_PAIN.map((t) => t.ma);
const BAT_HET = { may: true, ban: true, robot: true, khac: true };

// Cache toàn cục (cấu hình đổi rất hiếm; `xoaCache()` gọi ngay sau khi lưu).
let cache = null;
function xoaCache() { cache = null; }

// Đọc cấu hình mọi trang. Thiếu bảng (chưa chạy mig 067) hoặc thiếu dòng → BẬT HẾT.
async function loadCauHinhPain() {
  if (cache) return cache;
  const out = {};
  MA_TRANG.forEach((ma) => { out[ma] = { ...BAT_HET }; });
  try {
    const { rows } = await query('SELECT ma_trang, may, ban, robot, khac FROM cai_dat_hien_pain');
    rows.forEach((r) => {
      if (out[r.ma_trang]) {
        out[r.ma_trang] = { may: r.may, ban: r.ban, robot: r.robot, khac: r.khac };
      }
    });
  } catch (e) { /* chưa có bảng → giữ mặc định bật hết */ }
  cache = out;
  return out;
}

async function luuCauHinhPain(rows, actorId) {
  for (const r of rows || []) {
    if (!MA_TRANG.includes(r.ma_trang)) continue;
    await query(
      `INSERT INTO cai_dat_hien_pain (ma_trang, may, ban, robot, khac, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (ma_trang) DO UPDATE SET may=EXCLUDED.may, ban=EXCLUDED.ban, robot=EXCLUDED.robot,
         khac=EXCLUDED.khac, updated_by=EXCLUDED.created_by, updated_date=now()`,
      [r.ma_trang, !!r.may, !!r.ban, !!r.robot, !!r.khac, actorId || null]
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

// Lấy điều kiện cho 1 trang trong 1 lần gọi (dùng ở repository).
async function dkTrang(maTrang, muc, col) {
  const cf = (await loadCauHinhPain())[maTrang] || BAT_HET;
  if (muc === 'lenh') return theoLenh(cf, col);
  if (muc === 'phieu') return theoPhieu(cf, col);
  return theoPhanIn(cf, col);
}

module.exports = {
  PAIN_MAY, PAIN_BAN, PAIN_ROBOT, TRANG_PAIN, MA_TRANG, BAT_HET,
  loadCauHinhPain, luuCauHinhPain, xoaCache, dkTrang,
};
