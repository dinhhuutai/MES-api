'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// GỬI KẾT QUẢ KIỂM KCS (KIỂM PHẨM) SANG ERP — POST /gui-erp-kiem-pham (24/09/2026).
//
// ⚠⚠ CHƯA CÓ HỢP ĐỒNG THAM SỐ RIÊNG của proc bên ERP ⇒ dùng CÙNG 20 trường với `ghi-in-tem` (khuôn
//   sửa đạt `suaDatErp.js`, người dùng từng chốt "tham số giống tem 15"): tái dùng `duLieuGhiInTem`
//   + `taoPayload` + `ghiInTem({ maApi })`. ERP đòi tham số khác thì lỗi của proc sẽ hiện nguyên văn
//   ở Hệ thống › Cài đặt API › Lịch sử ("expects parameter '@pXxx'") — sửa đúng chỗ `taoPayload` dưới.
//   · `BarcodeIn` = mã tem 15 được kiểm · `Soluong` = SL ĐẠT · `Soluongloi` = SL HƯ · `SOLUONGTHIEU` = SL thiếu.
//
// ⚠ GỬI ĐÚNG 1 LẦN MỖI LƯỢT KIỂM — khóa chống trùng = `kcs.id` (`audit_log ten_bang='kcs'`).
// ⚠ KHÔNG BAO GIỜ NÉM LỖI (bên gọi không `await`) — hỏng chiều đẩy không được chặn việc xác nhận KCS.
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../../config/db');
const env = require('../../config/env');
const { ghiInTem, taoPayload } = require('../../utils/erpGhiInTem');
const { ghiLog } = require('../../utils/erpApiLog');
const { capIdMes } = require('../../utils/idMes');
const prodRepo = require('../production/production.repository');
const { maNgayCaHomNay } = require('./suaDatErp');

const MA_API = 'ERP_GUI_KIEM_PHAM';

async function daGuiThanhCong(kcsId) {
  const { rows } = await query(
    `SELECT 1 FROM audit_log WHERE ten_bang = 'kcs' AND id_ban_ghi = $1 AND hanh_dong = $2 LIMIT 1`,
    [String(kcsId), MA_API]
  );
  return rows.length > 0;
}

// Mốc nhập lượt kiểm theo giờ VN, đúng định dạng các trường ngày của `ghi-in-tem` ('YYYY/MM/DD HH24:MI:SS').
//   Không đọc được ⇒ lùi về BÂY GIỜ (giờ VN) — thà có ngày hôm nay còn hơn gửi NULL.
async function mocNhapKcs(kcsId) {
  try {
    const { rows } = await query(
      `SELECT to_char(COALESCE((SELECT created_date FROM kcs WHERE id = $1), now()) AT TIME ZONE 'Asia/Ho_Chi_Minh',
              'YYYY/MM/DD HH24:MI:SS') AS moc`, [kcsId]);
    return rows[0] ? rows[0].moc : null;
  } catch { return null; }
}

/**
 * Gửi 1 lượt kiểm. Trả { ok, bo_qua?, ly_do?, error? }.
 * @param {string} kcsId
 * @param {string} temId  tem 15 được kiểm
 * @param {{dat:number, hu:number, thieu:number}} sl
 */
// `opts.guiLai` (nút "Gửi lại ERP" ở Cài đặt API › Lịch sử, 26/09/2026): bỏ qua chặn "đã gửi thành công"
//   và DÙNG LẠI `opts.idMes` cũ ⇒ proc `MES2SK6` xóa phiếu SK6 cùng `Soctcu` rồi tạo lại (không đẻ phiếu trùng).
async function guiKiemPham(kcsId, temId, { dat = 0, hu = 0, thieu = 0 } = {}, actorId = null, opts = {}) {
  if (!kcsId || !temId) return { ok: false, bo_qua: true, ly_do: 'THIEU_DU_LIEU' };
  if (!opts.guiLai && await daGuiThanhCong(kcsId)) return { ok: true, bo_qua: true, ly_do: 'DA_GUI' };

  const [r] = await prodRepo.duLieuGhiInTem([{ temId, dotVaiId: null }]);
  if (!r) return { ok: false, bo_qua: true, ly_do: 'KHONG_DU_LIEU' };

  // ⚠ Cấp IDMES SAU mọi guard — mỗi lần cấp là tiêu 1 số của dãy dùng chung.
  const idMes = opts.idMes != null ? opts.idMes : await capIdMes('gui-erp-kiem-pham');
  if (idMes == null) return { ok: false, error: 'Không cấp được IDMES' };

  const payload = taoPayload(r, { idMes, soLuong: Number(dat) || 0, soLuongHuy: Number(hu) || 0, soLuongThieu: Number(thieu) || 0 });
  // Cùng bài học `@pNgayca` của sửa đạt (23/09/2026): tem thiếu mã ngày ca ⇒ lấy NGÀY HÔM NAY.
  if (!payload.Ngayca) payload.Ngayca = await maNgayCaHomNay();
  // Trường NGÀY GIỜ thiếu ⇒ lấy MỐC NHẬP KCS (người dùng chốt 26/09/2026: "ngày thì để hôm nay, có dữ
  //   liệu lúc nhập"). Proc dùng `@pDengio` làm Ngày/Giờ của phiếu chuyển giao SK6 ⇒ NULL là phiếu mất ngày.
  //   Tem có nhập giờ SX (Từ giờ/Đến giờ) thì GIỮ nguyên; `Ngayct` vốn đã là ngày gửi = hôm nay.
  const moc = await mocNhapKcs(kcsId);
  if (!payload.Tugio) payload.Tugio = moc;
  if (!payload.Dengio) payload.Dengio = moc;
  if (!payload.Ngayct) payload.Ngayct = moc ? moc.slice(0, 10) : null;

  const kq = await ghiInTem(payload, { maApi: MA_API });
  if (kq.bo_qua) return { ok: false, bo_qua: true, ly_do: 'API_DANG_TAT' };

  const p = kq.data && typeof kq.data === 'object' ? kq.data : null;
  await ghiLog(MA_API, {
    thanhCong: kq.ok,
    idBanGhi: kcsId,
    idMes,
    maTem: payload.BarcodeIn,
    url: env.erp.guiKiemPhamUrl,
    gui: kq.body,
    nhan: kq.data,
    erpMessage: p ? (p.message ?? null) : null,
    erpError: p ? (p.error ?? null) : null,
    erpReturnValue: p && p.returnValue != null ? p.returnValue : null,
    loi: kq.error || null,
    actorId,
  });
  return kq.ok ? { ok: true, id_mes: idMes } : { ok: false, error: kq.error };
}

function guiNgam(kcsId, temId, sl, actorId) {
  guiKiemPham(kcsId, temId, sl, actorId).catch((e) => {
    console.error(`[gui-kiem-pham] ✗ Lỗi ngoài dự kiến (lượt kiểm ${kcsId}): ${e.message}`);
  });
}

module.exports = { guiKiemPham, guiNgam, daGuiThanhCong, MA_API };
