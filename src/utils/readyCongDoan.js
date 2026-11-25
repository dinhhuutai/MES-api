'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// ⚠⚠⚠ 17/11/2026: BỘ CHECKLIST RIÊNG CỦA ÉP/LOGO ĐÃ BỎ — READY dùng chung 1 bộ, `coBoEp()` luôn false (xem cuối file).
//   Phần mô tả bên dưới là thiết kế cũ, giữ để hiểu các hàm còn được gọi.
// READY THEO CÔNG ĐOẠN (14/11/2026, người dùng chốt) — NGUỒN LUẬT DUY NHẤT.
//   Phần in 2 công đoạn (IN_KIENG · IN_EP — `utils/luongSanXuat.js`) ra 2 DÒNG từ READY: dòng công đoạn in (giai_doan 'IN')
//   và dòng công đoạn Ép/Logo ('EP_UI'). Mỗi dòng qua Kỹ thuật (Khuôn + Mực, Film theo Khuôn; II/AD chỉ Mực) rồi QA, và
//   Release 1 dòng nào chỉ cần CHÍNH công đoạn đó Ready. Trả về Kỹ thuật từ lệnh ép chỉ làm lại READY của công đoạn ép.
//
//   ⚠⚠ CÔNG ĐOẠN ÉP DÙNG BỘ CHECKLIST RIÊNG trong trạm READY (mig 131): KHUON_EP · FILM_EP · MUC_EP · QC_XAC_NHAN_EP
//   (`maCd`). Bộ gốc KHUON/FILM/MUC/QC_XAC_NHAN GIỮ NGUYÊN là READY của công đoạn in / phần in 1 công đoạn ⇒ mọi câu cũ
//   đọc mã gốc (QC READY của phần in, dashboard, sĩ số, báo cáo…) vẫn đúng nghĩa "phần in" như trước.
//   ⚠ Mọi chỗ liệt kê MỌI checkpoint của trạm READY phải lọc mã `_EP` nếu chỉ muốn bộ gốc (`laMaEp`).
//
//   CHẾ ĐỘ READY theo tính chất in (`tinh_chat_in.ready_che_do`, mig 131 — người dùng sẽ gửi danh sách):
//     RIENG (mặc định)  — mỗi công đoạn Ready riêng.
//     MOT_LAN           — "nhiều công đoạn nhưng chỉ Ready 1 lần": mọi công đoạn dùng READY của công đoạn in (1 dòng).
//     SAU_THEO_DAU      — "công đoạn sau không Ready": công đoạn sau theo READY của công đoạn đầu (`phan_in.ep_truoc`).
//   ⇒ `gdReady(pin, gd)` = bộ checklist mà công đoạn `gd` đọc ('IN' | 'EP_UI').
// ─────────────────────────────────────────────────────────────────────────────
const { dotGdSql, gdSql, dotCaHaiSql } = require('./luongSanXuat');

const GD_IN = 'IN';
const GD_EP = 'EP_UI';
const HAU_TO = '_EP';
// 'HSKT' (16/11/2026, mig 134): mục "Xác nhận HSKT" của công đoạn Ép/Logo — bộ gốc 'HSKT' (phần in Logo), bộ ép 'HSKT_EP'.
const MA_GOC = ['KHUON', 'FILM', 'MUC', 'QC_XAC_NHAN', 'HSKT'];
const CHE_DO = ['RIENG', 'MOT_LAN', 'SAU_THEO_DAU'];

const chuanGd = (gd) => (gd === GD_EP ? GD_EP : GD_IN);
// Mã checklist thật của mục `ma` (mã gốc) cho bộ công đoạn `gd`.
const maCd = (ma, gd) => (chuanGd(gd) === GD_EP && MA_GOC.includes(ma) ? `${ma}${HAU_TO}` : ma);
// Mã gốc của 1 mã thật (KHUON_EP ⇒ KHUON) — mã lạ giữ nguyên.
const maGocCua = (ma) => {
  const s = String(ma || '');
  return s.endsWith(HAU_TO) && MA_GOC.includes(s.slice(0, -HAU_TO.length)) ? s.slice(0, -HAU_TO.length) : s;
};
const laMaEp = (ma) => maGocCua(ma) !== String(ma || '');
const gdCuaMa = (ma) => (laMaEp(ma) ? GD_EP : GD_IN);
const chuanCheDo = (v) => (CHE_DO.includes(v) ? v : 'RIENG');

const HAI_CD = ['IN_KIENG', 'IN_EP'];
// ⚠ Chưa có bộ checklist ép (chưa chạy mig 131) ⇒ mọi công đoạn đọc bộ gốc (như trước bản 14/11) — `gdReady`/`gdReadySql`
//   đọc cờ này ĐỒNG BỘ; cờ nạp lúc khởi động (cuối file) và mỗi lần `coBoEp()`.
const _coBoEp = false; // 17/11/2026: bỏ bộ ép — xem `coBoEp` cuối file
// Bộ checklist mà công đoạn `gd` của phần in đọc (JS). `pin` = { luong_sx, ep_truoc, ready_che_do }.
function gdReady(pin, gd) {
  if (!_coBoEp || !pin || !HAI_CD.includes(pin.luong_sx)) return GD_IN;
  const cd = chuanCheDo(pin.ready_che_do);
  if (cd === 'MOT_LAN') return GD_IN;
  if (cd === 'SAU_THEO_DAU') return pin.ep_truoc ? GD_EP : GD_IN;
  return chuanGd(gd);
}

// SQL: chế độ READY của phần in `pin` (đọc tính chất in qua `to_jsonb` ⇒ chạy cả khi chưa có cột mig 131).
const cheDoSql = (pin = 'pin') => `COALESCE((SELECT to_jsonb(zt)->>'ready_che_do' FROM tinh_chat_in zt
  WHERE zt.dang_hoat_dong AND zt.ma_chuan = upper(regexp_replace(${pin}.tinh_chat_in, '\\s+', '', 'g')) LIMIT 1), 'RIENG')`;
// SQL: bộ checklist ('IN' | 'EP_UI') công đoạn `gdExpr` (literal hoặc biểu thức SQL) của phần in `pin` đọc.
const gdReadySql = (pin, gdExpr) => (!_coBoEp ? `'${GD_IN}'` : `(CASE WHEN ${pin}.luong_sx IS NULL OR ${pin}.luong_sx NOT IN ('IN_KIENG','IN_EP') THEN '${GD_IN}'
  ELSE (CASE ${cheDoSql(pin)} WHEN 'MOT_LAN' THEN '${GD_IN}'
             WHEN 'SAU_THEO_DAU' THEN (CASE WHEN ${pin}.ep_truoc THEN '${GD_EP}' ELSE '${GD_IN}' END)
             ELSE (CASE WHEN ${gdExpr} = '${GD_EP}' THEN '${GD_EP}' ELSE '${GD_IN}' END) END) END)`);
// SQL: mã QC thật mà công đoạn `gdExpr` của phần in `pin` cần (dùng với `tech.dotMucDatSql(…, true)`).
const maQcGdSql = (pin, gdExpr) => `(CASE WHEN ${gdReadySql(pin, gdExpr)} = '${GD_EP}' THEN 'QC_XAC_NHAN${HAU_TO}' ELSE 'QC_XAC_NHAN' END)`;
// SQL: phần in `pin` có DÒNG READY cho bộ `gd` (bộ IN: mọi phần in trừ ca "sau theo đầu" + ép trước; bộ EP: phần in 2 công
//   đoạn có ép Ready riêng / ép là công đoạn đầu được "sau theo đầu").
const coDongReadySql = (pin, gd) => (chuanGd(gd) === GD_EP
  ? `(${gdReadySql(pin, `'${GD_EP}'`)} = '${GD_EP}' OR ${gdReadySql(pin, `'${GD_IN}'`)} = '${GD_EP}')`
  : `(${gdReadySql(pin, `'${GD_IN}'`)} = '${GD_IN}' OR ${gdReadySql(pin, `'${GD_EP}'`)} = '${GD_IN}')`);
// SQL: lệnh `ls` thuộc công đoạn `gd` (in = mọi lệnh không phải EP_UI — như `luongSanXuat.daRelSql`).
const lenhGdDk = (ls, gd) => (chuanGd(gd) === GD_EP ? `${ls}.giai_doan = '${GD_EP}'` : `${ls}.giai_doan IS DISTINCT FROM '${GD_EP}'`);

// ⚠⚠ ĐỢT THEO CÔNG ĐOẠN (16/11/2026 — `luongSanXuat.dotGdSql`): đợt của phần in kiếng ủi chỉ thuộc 1 công đoạn (4I ⇒ In kiếng,
//   đợt khác ⇒ Ép) ⇒ ở READY đợt chỉ nằm ở dòng của bộ mà CÔNG ĐOẠN ĐỢT đọc (`gdReadySql`), và "đã release" của đợt = có lệnh
//   của CHÍNH công đoạn đợt (đợt Ép không bao giờ có lệnh in). Đợt 2 công đoạn (NULL) giữ luật cũ.
//   `pin` = alias phần in nếu câu có sẵn (cần `luong_sx`, `ep_truoc`, `tinh_chat_in`); bỏ trống ⇒ tự tra phần in của đợt.
function dotOBoSql(dv, gd, pin = null) {
  if (!_coBoEp) return 'TRUE'; // chưa có bộ ép (mig 131) ⇒ mọi đợt ở dòng READY bộ gốc
  const dk = (p) => {
    const g = dotGdSql(dv, `${p}.luong_sx`);
    return `(${g} IS NULL OR ${gdReadySql(p, g)} = '${chuanGd(gd)}')`;
  };
  return pin ? dk(pin) : `EXISTS (SELECT 1 FROM phan_in zbp WHERE zbp.id = ${dv}.phan_in_id AND ${dk('zbp')})`;
}
// Lệnh `ls` "release" đợt `dv` ở dòng READY bộ `gd`: đợt 1 công đoạn ⇒ lệnh của chính công đoạn đợt; còn lại ⇒ `lenhGdDk`.
function lenhDotGdDk(ls, dv, gd, pin = null) {
  const g = dotGdSql(dv, pin ? `${pin}.luong_sx` : null);
  return `(CASE WHEN ${g} IS NULL THEN ${lenhGdDk(ls, gd)} ELSE ${gdSql(ls)} = ${g} END)`;
}
// Bản dùng cho câu "ĐỢT CÒN CHỜ Ở READY" (`NOT EXISTS (lệnh sống AND …)`) — 23/11/2026, trả về KT theo công đoạn
//   (`utils/giuReadyCongDoan.js`): phần in In + Ép/Logo (`IN_EP`, 1 đợt mang 2 công đoạn) ⇒ lệnh In chỉ "đưa đợt rời READY"
//   khi đợt CŨNG có lệnh Ép/Logo sống. Trước đây chỉ xét lệnh In ⇒ trả về KT công đoạn Ép/Logo lúc In đã có lệnh thì đợt
//   không hiện ở READY ⇒ KT/QC không xác nhận lại được, dòng Ép kẹt "Chờ Ready". Đợt đã QC không đổi gì (màn READY còn lọc
//   `NOT qcDotSql`). ⚠ Guard (bỏ tích, phần in đã release, lệnh chờ KT…) GIỮ `lenhDotGdDk`.
// ⚠ 25/11/2026 (mig 139): "đợt mang 2 công đoạn" không còn = luồng `IN_EP` — đợt kiếng ủi đánh dấu / ERP đặt 'CA_HAI' cũng
//   vậy, đợt In + Logo đánh dấu 1 công đoạn thì không ⇒ xét theo ĐỢT (`luongSanXuat.dotCaHaiSql`).
function lenhRoiReadyDk(ls, dv, gd, pin = null) {
  if (chuanGd(gd) === GD_EP) return lenhDotGdDk(ls, dv, gd, pin);
  return `(${lenhDotGdDk(ls, dv, gd, pin)} AND (NOT ${dotCaHaiSql(dv, pin ? `${pin}.luong_sx` : null)}
    OR EXISTS (SELECT 1 FROM lenh_sx_dot_vai zre JOIN lenh_san_xuat zrl ON zrl.id = zre.lenh_san_xuat_id
               WHERE zre.dot_vai_ve_id = ${dv}.id AND zrl.trang_thai <> 'HUY' AND zrl.giai_doan = '${GD_EP}')))`;
}

// ⚠⚠ BỘ CHECKLIST RIÊNG CỦA CÔNG ĐOẠN ÉP/LOGO ĐÃ BỎ (17/11/2026, người dùng chốt "chỗ này dùng chung như bình thường"):
//   mỗi đợt vải chỉ thuộc 1 công đoạn (kiếng ủi: 4I In kiếng / đợt khác Ép — `luongSanXuat.dotGd`; không có In rồi Ép) ⇒ đợt
//   Ép/Logo xác nhận ở CHÍNH các mục Khuôn / Film / Mực / HSKT / QC chung, theo đợt (`ready_xac_nhan_dot`). Luật KT riêng của
//   Ép/Logo (không Film, Khuôn/Mực theo tính chất, HSKT) nay theo ĐỢT — `utils/tech.js dotEpSql`, `technical.service laEpNhom`.
//   Checkpoint KHUON_EP · FILM_EP · MUC_EP · QC_XAC_NHAN_EP · HSKT_EP (mig 131/134) còn trong DB nhưng KHÔNG ai đọc — tắt bằng
//   `database/scripts/bo_bo_checklist_ep_1711.sql`. ⇒ `coBoEp()` LUÔN false: mọi hàm ở file này trả nhánh "bộ gốc"
//   (`gdReady` = IN, `dotOBoSql` = TRUE, `maQcGdSql` = QC_XAC_NHAN, không có dòng READY công đoạn Ép).
//   Giữ các hàm (nhiều nơi gọi) để mở lại được nếu người dùng đổi ý — đừng nối lại tự dò DB.
async function coBoEp() {
  return false;
}

module.exports = {
  GD_IN, GD_EP, HAU_TO, MA_GOC, CHE_DO, chuanGd, chuanCheDo, maCd, maGocCua, laMaEp, gdCuaMa, gdReady,
  cheDoSql, gdReadySql, maQcGdSql, coDongReadySql, lenhGdDk, coBoEp, dotOBoSql, lenhDotGdDk, lenhRoiReadyDk,
};
