'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// TRẢ VỀ KỸ THUẬT THEO CÔNG ĐOẠN — GIỮ "ĐÃ READY" CỦA CÔNG ĐOẠN CÒN LẠI (23/11/2026, người dùng chốt:
//   "1 code phần 2 công đoạn, trả về công đoạn này thì công đoạn kia bị trả về theo — 2 cái đó như 2 đợt vải khác
//   nhau, tách ra độc lập").
//
// Vì sao cần: phần in In + Ép/Logo (`luong_sx = 'IN_EP'`) — 1 đợt vải mang CẢ 2 công đoạn, READY dùng chung 1 bộ
//   checklist theo ĐỢT (CLAUDE.md §5.6). Mọi đường "Trả về Kỹ thuật" (Release 1 · Test Run · Release 2 · Xác nhận
//   chạy · Hủy lệnh về READY) hủy QC ⇒ đợt hết "Đã Ready" ⇒ công đoạn KIA của chính đợt đó cũng rớt (dòng Release 1
//   thành "Chờ Ready", lệnh in đang ở Test Run bị khóa "chờ kỹ thuật"…).
//
// Cách làm (KHÔNG migration): trả về công đoạn X của đợt d ⇒ QC của đợt vẫn bị hủy như cũ (đợt quay lại READY để KT/QC
//   làm lại cho X), NHƯNG ghi 1 DẤU "giữ Ready" cho công đoạn còn lại Y của d (`audit_log`, ten_bang `ready_giu_cong_doan`,
//   id_ban_ghi `<đợt>|<công đoạn>`, hanh_dong `GIU_READY_CONG_DOAN` / `BO_GIU_READY_CONG_DOAN`). Mọi chỗ hỏi "đợt đã Ready
//   CHO CÔNG ĐOẠN g chưa" (Release 1 · Kế hoạch tạm · tạo lệnh · Test Run "chờ kỹ thuật" · giai đoạn lệnh) đọc
//   `qcDotGdSql` = QC của đợt HOẶC dấu giữ của (đợt, g).
//
// ⚠⚠ DẤU TỰ HẾT HIỆU LỰC (không phải dọn): còn hiệu lực khi là dòng MỚI NHẤT của khóa VÀ sau mốc của nó KHÔNG có
//   (a) dòng QC theo đợt (`ready_xac_nhan_dot` QC_XAC_NHAN) của đợt đổi trạng thái — QC xác nhận lại / hủy theo đợt;
//   (b) dòng QC TỔNG của phần in bị hủy (`ket_qua_checkpoint` QC_XAC_NHAN ≠ DAT) — mọi lần trả về / hủy xác nhận / đặt lại
//       READY sau đó. Mốc dấu = `clock_timestamp()` lúc ghi, SAU các câu hủy QC trong cùng lượt ⇒ lượt hủy của chính nó
//       không làm dấu mất hiệu lực.
// ⚠ Chỉ ghi dấu khi đợt ĐANG Ready cho công đoạn Y trước lúc trả về (QC đợt, hoặc dấu cũ của Y còn hiệu lực).
//   Trả về CHÍNH công đoạn đang được giữ ⇒ ghi `BO_…` để bỏ dấu.
// ⚠ Phạm vi: chỉ phần in `IN_EP` (đợt mang 2 công đoạn). Kiếng ủi (`IN_KIENG`) mỗi đợt đã chỉ 1 công đoạn (`dotGd`) ⇒
//   không cần. Đổi phương án in (Test Run `DOI_PA_IN`) CỐ Ý không ghi dấu — đổi PA là làm lại cả phần in.
// ⚠ Vẫn còn ràng buộc GIỮA CÁC ĐỢT (hủy QC tổng của phần in kéo theo đợt khác chưa release) — luật cũ, chưa đổi.
// ─────────────────────────────────────────────────────────────────────────────
const { qcDotSql } = require('./tech');

const TEN_BANG = 'ready_giu_cong_doan';
const HD_GIU = 'GIU_READY_CONG_DOAN';
const HD_BO = 'BO_GIU_READY_CONG_DOAN';
const GD_IN = 'IN';
const GD_EP = 'EP_UI';
const chuanGd = (gd) => (gd === GD_EP ? GD_EP : GD_IN);
const gdKia = (gd) => (chuanGd(gd) === GD_EP ? GD_IN : GD_EP);
const chuanGdSql = (gdExpr) => `(CASE WHEN (${gdExpr}) = '${GD_EP}' THEN '${GD_EP}' ELSE '${GD_IN}' END)`;

// SQL boolean: dấu "giữ Ready" của (đợt `dv`, công đoạn `gdExpr` — literal hoặc biểu thức SQL, NULL = IN) còn hiệu lực.
//   Alias `zgr*` hiếm để không đụng câu bọc ngoài. Không có `-- …` (repository gộp 1 dòng).
const giuReadyGdSql = (dv, gdExpr) => `EXISTS (SELECT 1 FROM audit_log zgr
  WHERE zgr.ten_bang = '${TEN_BANG}' AND zgr.id_ban_ghi = (${dv}.id::text || '|' || ${chuanGdSql(gdExpr)})
    AND zgr.hanh_dong = '${HD_GIU}'
    AND NOT EXISTS (SELECT 1 FROM audit_log zgrb WHERE zgrb.ten_bang = '${TEN_BANG}' AND zgrb.id_ban_ghi = zgr.id_ban_ghi
                    AND zgrb.thoi_gian > zgr.thoi_gian)
    AND NOT EXISTS (SELECT 1 FROM ready_xac_nhan_dot zgrx JOIN checkpoint zgrc ON zgrc.id = zgrx.checkpoint_id
                     AND zgrc.ma_checkpoint = 'QC_XAC_NHAN'
                    WHERE zgrx.dot_vai_ve_id = ${dv}.id AND zgrx.updated_date > zgr.thoi_gian)
    AND NOT EXISTS (SELECT 1 FROM ket_qua_checkpoint zgrk JOIN checkpoint zgrkc ON zgrkc.id = zgrk.checkpoint_id
                     AND zgrkc.ma_checkpoint = 'QC_XAC_NHAN'
                    WHERE zgrk.phan_in_id = ${dv}.phan_in_id AND zgrk.trang_thai <> 'DAT' AND zgrk.updated_date > zgr.thoi_gian))`;

// SQL boolean: đợt `dv` ĐÃ READY CHO CÔNG ĐOẠN `gdExpr` = QC của đợt (`qcDotSql`, luật theo đợt) HOẶC dấu giữ Ready.
//   `qcMa`/`maLaBieuThuc` chuyển nguyên cho `qcDotSql` (call-site cũ truyền `maQcGdSql(...)`, true).
const qcDotGdSql = (dv, pinCol, gdExpr, qcMa = 'QC_XAC_NHAN', maLaBieuThuc = false) =>
  `(${qcDotSql(dv, pinCol, qcMa, maLaBieuThuc)} OR ${giuReadyGdSql(dv, gdExpr)})`;

// Đọc TRƯỚC khi hủy QC (cùng client/transaction): với từng đợt của phần in IN_EP trong `dotVaiIds`,
//   · `giu_kia` = đợt đang Ready cho công đoạn còn lại ⇒ sau khi hủy phải ghi dấu giữ;
//   · `bo_x` = đang có dấu giữ của CHÍNH công đoạn bị trả về ⇒ phải bỏ.
// `db` = client transaction hoặc module `config/db` (có `.query`).
async function docTruoc(db, dotVaiIds, gdTraVe) {
  const ids = [...new Set((dotVaiIds || []).filter(Boolean).map(String))];
  if (!ids.length) return [];
  const x = chuanGd(gdTraVe);
  const y = gdKia(x);
  const { rows } = await db.query(
    `SELECT dv.id::text AS dot_vai_id, dv.phan_in_id::text AS phan_in_id,
            (${qcDotGdSql('dv', 'dv.phan_in_id', `'${y}'`)}) AS giu_kia,
            (${giuReadyGdSql('dv', `'${x}'`)}) AS bo_x
       FROM dot_vai_ve dv JOIN phan_in pin ON pin.id = dv.phan_in_id
      WHERE dv.id = ANY($1::uuid[]) AND pin.luong_sx = 'IN_EP'
        AND dv.trang_thai NOT IN ('DA_GOP','DA_HUY')`.replace(/\s+/g, ' '),
    [ids]);
  return rows.map((r) => ({ ...r, gd_tra_ve: x, gd_kia: y }));
}

// Ghi SAU khi đã hủy QC (cùng client/transaction): dấu giữ cho công đoạn còn lại + bỏ dấu của công đoạn bị trả về.
//   `meta` = { nguon, ly_do, lenh_id } ghi vào `gia_tri_moi` để tra vết. Trả số dấu đã ghi.
async function ghiSau(db, truoc, actorId, meta = {}) {
  let n = 0;
  for (const r of truoc || []) {
    if (r.bo_x) {
      await db.query(
        `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5, clock_timestamp(), $5)`,
        [TEN_BANG, `${r.dot_vai_id}|${r.gd_tra_ve}`, HD_BO,
          JSON.stringify({ dot_vai_id: r.dot_vai_id, phan_in_id: r.phan_in_id, giai_doan: r.gd_tra_ve, ...meta }), actorId || null]);
      n += 1;
    }
    if (r.giu_kia) {
      await db.query(
        `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5, clock_timestamp(), $5)`,
        [TEN_BANG, `${r.dot_vai_id}|${r.gd_kia}`, HD_GIU,
          JSON.stringify({ dot_vai_id: r.dot_vai_id, phan_in_id: r.phan_in_id, giai_doan: r.gd_kia,
            tra_ve_cong_doan: r.gd_tra_ve, ...meta }), actorId || null]);
      n += 1;
    }
  }
  return n;
}

// Hủy dòng QC THEO ĐỢT (`ready_xac_nhan_dot`) đang DAT của các đợt bị trả về. Cần vì các đường hủy cũ chỉ hủy dòng TỔNG
//   ở trạng thái DAT: dòng tổng đã HỦY từ lần trước mà đợt được QC lại theo đợt ⇒ lần trả về sau không hủy được gì, đợt
//   vẫn "Đã Ready". `updated_date = now()` (đầu transaction) < mốc dấu giữ ghi sau ⇒ không làm dấu mất hiệu lực.
async function huyQcTheoDot(db, dotVaiIds, actorId) {
  const ids = [...new Set((dotVaiIds || []).filter(Boolean).map(String))];
  if (!ids.length) return 0;
  const { rowCount } = await db.query(
    `UPDATE ready_xac_nhan_dot x SET trang_thai = 'HUY', nguoi_xac_nhan_id = NULL, tg_xac_nhan = NULL,
            updated_by = $2, updated_date = now()
      WHERE x.dot_vai_ve_id = ANY($1::uuid[]) AND x.trang_thai = 'DAT'
        AND x.checkpoint_id IN (SELECT id FROM checkpoint WHERE ma_checkpoint = 'QC_XAC_NHAN')`.replace(/\s+/g, ' '),
    [ids, actorId || null]);
  return rowCount;
}

// Bọc trọn 1 lượt: đọc trước → `huy(db)` (đường hủy QC sẵn có của caller) → hủy QC theo đợt → ghi dấu.
async function traVeCongDoan(db, { dotVaiIds, gd, actorId, meta, giuCongDoanKia = true }, huy) {
  const truoc = giuCongDoanKia ? await docTruoc(db, dotVaiIds, gd) : [];
  if (typeof huy === 'function') await huy(db);
  await huyQcTheoDot(db, dotVaiIds, actorId);
  const soDau = await ghiSau(db, truoc, actorId, meta);
  return { so_dau: soDau, giu: truoc.filter((r) => r.giu_kia).map((r) => ({ dot_vai_id: r.dot_vai_id, giai_doan: r.gd_kia })) };
}

module.exports = {
  TEN_BANG, HD_GIU, HD_BO, giuReadyGdSql, qcDotGdSql, docTruoc, ghiSau, huyQcTheoDot, traVeCongDoan,
};
