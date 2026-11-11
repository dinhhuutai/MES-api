'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// LUỒNG SẢN XUẤT THEO TÍNH CHẤT IN (mig 126, 09/11/2026, người dùng chốt) — NGUỒN LUẬT DUY NHẤT, đừng chép ra chỗ khác.
//
//   · `phan_in.luong_sx`: THUONG (in thường — luồng hiện tại) · IN_KIENG · IN_EP (in + ép ủi) · LOGO · KIENG_KHONG_EP.
//     Phần in mới từ ERP tự nhận theo *Hệ thống › Tính chất in* (`tinh_chat_in.luong`); sửa tay ở Quản trị phần in.
//   · 2 CÔNG ĐOẠN (IN_KIENG · IN_EP): mỗi đợt vải có 2 phần ở Kế hoạch — phần IN (`lenh_san_xuat.giai_doan = 'IN'`) và
//     phần ÉP ỦI (`giai_doan = 'EP_UI'`). Mỗi phần có sức chứa release RIÊNG (= SL vải × số đầu BTP), lập kế hoạch phần
//     nào trước cũng được, 2 lệnh chạy song song. Lệnh IN qua Test Run; lệnh ÉP ỦI vào thẳng Chờ chạy (`boQuaTestRun`).
//   · CÔNG ĐOẠN ĐẦU (mặc định IN; `phan_in.ep_truoc` ⇒ ÉP) — lệnh mang `la_cong_doan_dau`, tem chép sang
//     `tem.cong_doan_dau`: tem không vào KCS (khô ⇒ `CHO_CD_SAU`). Tem công đoạn CUỐI mới đi KCS → OQC → giao.
//   · LOGO: đợt mới từ ERP vào thẳng Kế hoạch (hệ thống tự xác nhận READY), lệnh không qua Test Run / Release 2
//     (Release 1 ⇒ chờ chạy).
//   · Tem công đoạn IN của phần in KIẾNG phải nhập loại kiếng + hệ số kiếng.
//   · BỎ 1 CÔNG ĐOẠN của phần in 2 công đoạn (Quản trị phần in › Luồng sản xuất, `phaninadmin.service boCongDoan` — 11/11/2026,
//     người dùng chốt): bỏ IN (chỉ còn ép ủi) ⇒ luồng LOGO (như hàng chỉ ép EP LUN / EP DECAL…: 1 công đoạn, không qua
//     Test Run); bỏ ÉP ⇒ In kiếng giữ kiếng (`KIENG_KHONG_EP` — 1 công đoạn, tem vẫn nhập kiếng), In + ép ⇒ In thường.
//     Luật DUY NHẤT `luongSauKhiBo`. Lệnh của công đoạn còn lại thành lệnh của luồng 1 công đoạn: lệnh ép đổi
//     `giai_doan` 'EP_UI' → 'IN' (= "phần chính" của đợt ở MỌI câu tính release / giai đoạn / ERP).
//
// ⚠ Lệnh cũ trước mig 126 KHÔNG có junction đợt cho phần ép (khung `EP_UI` + `lenh_lien_ket_id` của Gom đợt vải — prod
//   0 lệnh). Lệnh ÉP mới GẮN đợt vải như lệnh thường ⇒ mọi câu tính "đã release" của đợt PHẢI tách theo công đoạn
//   (`daRelSql`) — không thì phần ép ăn vào sức chứa của phần in.
// ─────────────────────────────────────────────────────────────────────────────
const { query } = require('../config/db');
const { normTcin } = require('./tinhChatIn');

// `KIENG_KHONG_EP` (11/11/2026): in kiếng đã BỎ công đoạn ép ủi — 1 công đoạn như In thường nhưng tem in vẫn nhập kiếng.
//   Chỉ đặt tay ở Quản trị phần in (Tính chất in không phân loại về luồng này).
const LUONG_SX = [
  { ma: 'THUONG', ten: 'In thường' },
  { ma: 'IN_KIENG', ten: 'In kiếng' },
  { ma: 'IN_EP', ten: 'In + ép' },
  { ma: 'LOGO', ten: 'Logo' },
  { ma: 'KIENG_KHONG_EP', ten: 'In kiếng (không ép)' },
];
const MA_LUONG_SX = new Set(LUONG_SX.map((l) => l.ma));
const HAI_CONG_DOAN = new Set(['IN_KIENG', 'IN_EP']);
const LUONG_KIENG = new Set(['IN_KIENG', 'KIENG_KHONG_EP']);
const GD_IN = 'IN';
const GD_EP = 'EP_UI';

const chuanLuong = (v) => (MA_LUONG_SX.has(v) ? v : 'THUONG');
const laHaiCongDoan = (luong) => HAI_CONG_DOAN.has(luong);
const laLogo = (luong) => luong === 'LOGO';
// Phần in kiếng (2 công đoạn hoặc đã bỏ ép) — nguồn của cờ gương `phan_in.la_in_kieng`.
const laKieng = (luong) => LUONG_KIENG.has(luong);
const laKiengSql = (expr) => `(${expr} IN ('IN_KIENG','KIENG_KHONG_EP'))`;
// Công đoạn của 1 lệnh: chỉ 'EP_UI' là ép, còn lại (IN / NULL / '') là in.
const chuanGd = (gd) => (gd === GD_EP ? GD_EP : GD_IN);
// Công đoạn ĐẦU của phần in 2 công đoạn (null nếu 1 công đoạn).
const congDoanDau = (luong, epTruoc) => (laHaiCongDoan(luong) ? (epTruoc ? GD_EP : GD_IN) : null);
const laCongDoanDau = (luong, epTruoc, gd) => congDoanDau(luong, epTruoc) === chuanGd(gd);
// Tem công đoạn IN của phần in kiếng (kể cả kiếng đã bỏ ép) ⇒ bắt buộc loại kiếng + hệ số.
const canNhapKieng = (luong, gd) => laKieng(luong) && chuanGd(gd) === GD_IN;
// LỆNH KHÔNG QUA TEST RUN — vào thẳng Chờ chạy (`RELEASE_2`) ngay lúc tạo: phần in LOGO (mig 126) · công đoạn ÉP ỦI của phần
//   in 2 công đoạn (11/11/2026, người dùng chốt: "in cho qua Test Run, còn ép ủi vào thẳng chờ sản xuất"). Nguồn DUY NHẤT —
//   mọi đường tạo lệnh (Release 1 · Xác nhận kế hoạch tạm · Gom đợt vải · Lập lại KH từ gia công về xưởng) gọi hàm này.
const boQuaTestRun = (luong, gd) => laLogo(luong) || chuanGd(gd) === GD_EP;
// SQL cho lệnh `ls` đã có: lệnh ép ủi, hoặc lệnh mà mọi phần in đều LOGO.
const boQuaTestRunLenhSql = (ls = 'ls') => `(${ls}.giai_doan = '${GD_EP}' OR (EXISTS (SELECT 1 FROM lenh_sx_dot_vai zbq WHERE zbq.lenh_san_xuat_id = ${ls}.id)
  AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai zbq2 JOIN dot_vai_ve zbd ON zbd.id = zbq2.dot_vai_ve_id JOIN phan_in zbp ON zbp.id = zbd.phan_in_id
                   WHERE zbq2.lenh_san_xuat_id = ${ls}.id AND zbp.luong_sx IS DISTINCT FROM 'LOGO')))`;
// Luồng của phần in 2 công đoạn sau khi BỎ công đoạn `bo` ('IN' | 'EP_UI') — null nếu không phải 2 công đoạn.
function luongSauKhiBo(luong, bo) {
  if (!laHaiCongDoan(luong)) return null;
  if (chuanGd(bo) === GD_IN) return 'LOGO';
  return luong === 'IN_KIENG' ? 'KIENG_KHONG_EP' : 'THUONG';
}

// Nhãn công đoạn hiện ở màn hình — null với phần in 1 công đoạn (không vẽ badge).
function nhanCongDoan(luong, gd) {
  if (!laHaiCongDoan(luong)) return null;
  if (chuanGd(gd) === GD_EP) return 'Ép ủi';
  return luong === 'IN_KIENG' ? 'In kiếng' : 'In';
}

// SQL: công đoạn chuẩn của lệnh `ls`.
const gdSql = (ls = 'ls') => `(CASE WHEN ${ls}.giai_doan = '${GD_EP}' THEN '${GD_EP}' ELSE '${GD_IN}' END)`;
// SQL: SL đã release của đợt `dv` cho CÔNG ĐOẠN `gd` (chuỗi literal 'IN' / 'EP_UI' hoặc biểu thức SQL).
//   Mặc định 'IN' = phần IN (mọi lệnh không phải ép) — đúng như "đã release" trước mig 126.
function daRelSql(dv = 'dv', gd = `'${GD_IN}'`) {
  return `COALESCE((SELECT SUM(COALESCE(xlsd.so_luong,0)) FROM lenh_sx_dot_vai xlsd
    JOIN lenh_san_xuat xls ON xls.id = xlsd.lenh_san_xuat_id
    WHERE xlsd.dot_vai_ve_id = ${dv}.id AND xls.trang_thai <> 'HUY' AND ${gdSql('xls')} = ${gd}),0)`;
}
// SQL: điều kiện lệnh `ls` thuộc phần IN (dùng trong câu tổng hợp đã có JOIN lệnh).
const laPhanInSql = (ls = 'ls') => `${ls}.giai_doan IS DISTINCT FROM '${GD_EP}'`;
// SQL: phần in `pin` có 2 công đoạn.
const haiCongDoanSql = (pin = 'pin') => `(${pin}.luong_sx IN ('IN_KIENG','IN_EP'))`;

// PHƯƠNG ÁN IN CỦA CÔNG ĐOẠN: dòng / lệnh công đoạn ÉP ỦI luôn mang PA **Ép** (5 — `utils/hskt.js PHUONG_AN_IN`), không
//   mang PA của HSKT (là PA của phần IN). Áp ở Release 1 (chip lọc, badge, Excel), Kế hoạch tạm, màn mức lệnh (Test Run ·
//   Release 2 · Lập lại KH) và bộ lọc *Hiển thị theo PA in* (`utils/phuongAnIn.js` — Ép thuộc nhóm "Khác"). PA của HSKT giữ
//   ở cột `phuong_an_in_hskt` (ô ↻ đổi PA chỉ ở dòng in). FE đọc thẳng `phuong_an_in` BE trả (không có gương).
const PAIN_EP = 5;
const paCongDoanSql = (paExpr, gdExpr) => `(CASE WHEN ${gdExpr} = '${GD_EP}' THEN ${PAIN_EP} ELSE ${paExpr} END)`;

// KẾ HOẠCH TẠM THEO CÔNG ĐOẠN (mig 128): `ke_hoach_tam.giai_doan` 'IN' | 'EP_UI' — mỗi đợt tối đa 1 dòng / công đoạn
//   (phần ép của đợt chưa Ready cũng lưu kế hoạch tạm được, lập phần nào trước cũng được). Đọc qua `to_jsonb` ⇒ câu chạy
//   được cả khi chưa chạy mig (thiếu cột ⇒ mọi dòng là 'IN'). ⚠ Mọi câu đọc `ke_hoach_tam` theo ĐỢT phải lọc công đoạn
//   (không thì 1 đợt 2 dòng ⇒ nhân đôi / ẩn nhầm dòng của công đoạn kia).
const khtGdSql = (kt = 'kht') => `COALESCE(to_jsonb(${kt})->>'giai_doan', '${GD_IN}')`;
const khtLaGdSql = (kt = 'kht', gd = `'${GD_IN}'`) => `${khtGdSql(kt)} = ${gd}`;
let khtCoGd = false;
async function khtCoCotGd() {
  if (khtCoGd) return true;
  try {
    const { rows } = await query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='ke_hoach_tam' AND column_name='giai_doan' LIMIT 1");
    khtCoGd = rows.length > 0;
  } catch { khtCoGd = false; }
  return khtCoGd;
}

// Luồng của tính chất in theo danh mục *Tính chất in* (nhớ 60 s). Lỗi / thiếu bảng ⇒ THUONG.
let nho = { luc: 0, map: null };
async function bangLuongTinhChat() {
  if (nho.map && Date.now() - nho.luc < 60 * 1000) return nho.map;
  const map = new Map();
  try {
    const { rows } = await query('SELECT ma_chuan, luong FROM tinh_chat_in WHERE dang_hoat_dong');
    rows.forEach((r) => map.set(r.ma_chuan, r.luong));
  } catch (e) { /* thiếu bảng (mig 123) ⇒ mọi phần in luồng thường */ }
  nho = { luc: Date.now(), map };
  return map;
}
const xoaNho = () => { nho = { luc: 0, map: null }; };
// Luồng phần in suy từ phân loại tính chất in (KHAC / CHUA_PHAN_LOAI / không có ⇒ THUONG).
async function luongTheoTinhChat(tinhChatIn) {
  const l = (await bangLuongTinhChat()).get(normTcin(tinhChatIn));
  return HAI_CONG_DOAN.has(l) || l === 'LOGO' ? l : 'THUONG';
}

module.exports = {
  LUONG_SX, MA_LUONG_SX, HAI_CONG_DOAN, GD_IN, GD_EP,
  chuanLuong, laHaiCongDoan, laLogo, laKieng, laKiengSql, luongSauKhiBo, boQuaTestRun, boQuaTestRunLenhSql,
  chuanGd, congDoanDau, laCongDoanDau, canNhapKieng, nhanCongDoan,
  gdSql, daRelSql, laPhanInSql, haiCongDoanSql, khtGdSql, khtLaGdSql, khtCoCotGd, PAIN_EP, paCongDoanSql,
  bangLuongTinhChat, luongTheoTinhChat, xoaNho,
};
