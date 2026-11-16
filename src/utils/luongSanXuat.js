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
const { normTcin, luongSxTheoPhanLoai } = require('./tinhChatIn');

// Luồng = tổ hợp công đoạn: THUONG = In · KIENG_KHONG_EP = In kiếng · LOGO = Logo hoặc Ép (1 công đoạn loại ép) · IN_EP = In +
//   Ép/Logo · IN_KIENG = In kiếng + Ép (kiếng ủi). Tính chất in phân loại theo 4 công tắc In · In kiếng · Logo · Ép
//   (`utils/tinhChatIn.js`, 16/11/2026 tách Logo khỏi Ép) ⇒ phần in mới nhận luồng tương ứng.
const LUONG_SX = [
  { ma: 'THUONG', ten: 'In thường' },
  { ma: 'IN_KIENG', ten: 'In kiếng + Ép (kiếng ủi)' },
  { ma: 'IN_EP', ten: 'In + Ép/Logo' },
  { ma: 'LOGO', ten: 'Ép/Logo' },
  { ma: 'KIENG_KHONG_EP', ten: 'In kiếng' },
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
// GIA CÔNG THEO CÔNG ĐOẠN (14/11/2026, người dùng chốt: "in kiếng, logo/ép thì không có gia công"): chỉ công đoạn IN
//   (in thường) đưa lên chuyền gia công được. Công đoạn ÉP/LOGO, phần in LOGO và công đoạn in của phần in KIẾNG ⇒ không.
//   Nguồn DUY NHẤT — `planning.service kiemKhongGiaCong` gọi ở mọi đường đặt chuyền gia công.
const giaCongDuoc = (luong, gd) => chuanGd(gd) === GD_IN && !laLogo(luong) && !laKieng(luong);
// Luồng của phần in 2 công đoạn sau khi BỎ công đoạn `bo` ('IN' | 'EP_UI') — null nếu không phải 2 công đoạn.
function luongSauKhiBo(luong, bo) {
  if (!laHaiCongDoan(luong)) return null;
  if (chuanGd(bo) === GD_IN) return 'LOGO';
  return luong === 'IN_KIENG' ? 'KIENG_KHONG_EP' : 'THUONG';
}

// Nhãn công đoạn hiện ở màn hình — null với phần in 1 công đoạn (không vẽ badge). Kiếng ủi ⇒ "In kiếng" / "Ép" (16/11/2026).
function nhanCongDoan(luong, gd) {
  if (!laHaiCongDoan(luong)) return null;
  if (chuanGd(gd) === GD_EP) return luong === 'IN_KIENG' ? 'Ép' : 'Ép/Logo';
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

// ⚠⚠ ĐỢT VẢI THEO CÔNG ĐOẠN (16/11/2026, người dùng chốt) — phần in KIẾNG ỦI (luồng IN_KIENG = In kiếng + Ép) được ERP gửi
//   lên 2 LẦN, mỗi lần (= 1 đợt vải) là MỘT công đoạn, nhìn `loaikd`: **4I (loại đợt `IN_KIENG`) ⇒ công đoạn In kiếng ('IN')**;
//   đợt khác (3I số lượng · 5I bổ sung · 6I mẫu SL · 2I) ⇒ **công đoạn Ép ('EP_UI')**. Đợt CHỈ có sức chứa ở công đoạn của
//   nó ⇒ Release 1 / Kế hoạch tạm / Gom đợt vải ra 1 dòng / đợt; ở READY đợt nằm ở dòng của công đoạn nó; "đã release" của
//   đợt = lệnh của chính công đoạn đó. Phần in có mấy công đoạn vẫn theo *Tính chất in* (`phan_in.luong_sx`). Phần in 2 công
//   đoạn khác (In + Ép/Logo — ERP chỉ gửi 1 lần) GIỮ luật cũ: 1 đợt ra cả 2 công đoạn (`dotGd` = null).
const LUONG_THEO_DOT = new Set(['IN_KIENG']);
const LOAI_DOT_KIENG = 'IN_KIENG'; // loại đợt của loaikd 4I (`erpsync.service LOAIKD_MAP`)
const theoDot = (luong) => LUONG_THEO_DOT.has(luong);
// Công đoạn của 1 đợt: 'IN' | 'EP_UI' — null = đợt có cả 2 công đoạn (hoặc phần in 1 công đoạn).
function dotGd(luong, maLoaiDot) {
  if (!theoDot(luong)) return null;
  return maLoaiDot === LOAI_DOT_KIENG ? GD_IN : GD_EP;
}
const dotThuocGd = (luong, maLoaiDot, gd) => { const g = dotGd(luong, maLoaiDot); return !g || g === chuanGd(gd); };
// SQL: công đoạn của đợt `dv` ('IN' | 'EP_UI' | NULL). `luongExpr` = luồng phần in nếu câu đã JOIN phần in (vd 'pin.luong_sx'),
//   bỏ trống ⇒ tự tra phần in của đợt.
function dotGdSql(dv = 'dv', luongExpr = null) {
  const l = luongExpr || `(SELECT zgp.luong_sx FROM phan_in zgp WHERE zgp.id = ${dv}.phan_in_id)`;
  return `(CASE WHEN ${l} IN (${[...LUONG_THEO_DOT].map((x) => `'${x}'`).join(',')}) THEN (CASE WHEN ${dv}.loai_dot_vai_id = (SELECT zgl.id FROM loai_dot_vai zgl WHERE zgl.ma_loai = '${LOAI_DOT_KIENG}' LIMIT 1) THEN '${GD_IN}' ELSE '${GD_EP}' END) END)`;
}
// SQL: đợt `dv` có phần của công đoạn `gd` (literal 'IN' / 'EP_UI' hoặc biểu thức).
const dotThuocGdSql = (dv, gd, luongExpr = null) => `(COALESCE(${dotGdSql(dv, luongExpr)}, ${gd}) = ${gd})`;
// SQL: công đoạn "CHÍNH" của đợt — đợt 1 công đoạn ⇒ công đoạn đó; còn lại ⇒ IN (phần in, như trước). "Đã release / đã rời
//   Release 1" của ĐỢT đi theo lệnh của công đoạn này.
const gdChinhDotSql = (dv, luongExpr = null) => `COALESCE(${dotGdSql(dv, luongExpr)}, '${GD_IN}')`;
// SQL: lệnh `ls` là lệnh CHÍNH của đợt `dv`.
const lenhChinhCuaDotSql = (ls, dv, luongExpr = null) => `(${gdSql(ls)} = ${gdChinhDotSql(dv, luongExpr)})`;

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
// Luồng phần in suy từ phân loại tính chất in (chưa phân loại / không có ⇒ THUONG — luật ở `tinhChatIn.luongSxTheoPhanLoai`).
async function luongTheoTinhChat(tinhChatIn) {
  return luongSxTheoPhanLoai((await bangLuongTinhChat()).get(normTcin(tinhChatIn)));
}

module.exports = {
  LUONG_SX, MA_LUONG_SX, HAI_CONG_DOAN, GD_IN, GD_EP,
  chuanLuong, laHaiCongDoan, laLogo, laKieng, laKiengSql, luongSauKhiBo, boQuaTestRun, boQuaTestRunLenhSql, giaCongDuoc,
  chuanGd, congDoanDau, laCongDoanDau, canNhapKieng, nhanCongDoan,
  gdSql, daRelSql, laPhanInSql, haiCongDoanSql, khtGdSql, khtLaGdSql, khtCoCotGd, PAIN_EP, paCongDoanSql,
  bangLuongTinhChat, luongTheoTinhChat, xoaNho,
  LUONG_THEO_DOT, LOAI_DOT_KIENG, theoDot, dotGd, dotThuocGd, dotGdSql, dotThuocGdSql, gdChinhDotSql, lenhChinhCuaDotSql,
};
