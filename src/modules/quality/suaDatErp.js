'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// GỬI SỬA ĐẠT (TEM 17) SANG ERP — proc `MES_spr_MES2SK6` (21/09/2026).
//
// ⚠⚠ Proc RIÊNG, KHÔNG phải `ghi-in-tem`: tem 17 không in thêm mét vải nào, gửi qua `ghi-in-tem` là
//   ERP cộng vào SẢN LƯỢNG IN ⇒ đếm đôi (lý do tem 17 từng bị cấm gửi — §B #13 phiên 04–06/09).
//   Tham số giống hệt `ghi-in-tem` (người dùng chốt) ⇒ tái dùng `duLieuGhiInTem` + `taoPayload` +
//   `ghiInTem({ maApi })`, KHÔNG chép luồng.
//
// ⚠⚠ GỬI ĐÚNG 1 LẦN MỖI LƯỢT SỬA (người dùng chốt): khóa chống trùng = `sua.id` (id_ban_ghi của
//   `audit_log`, `ten_bang='sua'`). KHÔNG khóa theo tem con — API mã tem 17 tắt thì nhiều lượt cộng
//   dồn vào CÙNG 1 tem con, khóa theo tem là mất lượt thứ hai. In lại tem 17 KHÔNG gọi hàm này.
//   `Soluong` = SL SỬA ĐẠT CỦA LƯỢT · `Soluongloi` = SL SỬA HỦY CỦA LƯỢT (không lấy `sl_kcs_dat` của
//   tem con — ở chế độ cộng dồn đó là tổng mọi lượt).
//
// ⚠ KHÔNG BAO GIỜ NÉM LỖI khi chạy ngầm (bên gọi không `await`); `tuDong=false` (nút "Gửi lại ERP")
//   thì trả kết quả cho người bấm.
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../../config/db');
const env = require('../../config/env');
const { ghiInTem, taoPayload } = require('../../utils/erpGhiInTem');
const { ghiLog } = require('../../utils/erpApiLog');
const { capIdMes } = require('../../utils/idMes');
const prodRepo = require('../production/production.repository');
const repo = require('./quality.repository');

const MA_API = 'ERP_GUI_SUA_DAT';

// Lượt sửa này đã gửi ERP THÀNH CÔNG chưa.
async function daGuiThanhCong(suaId) {
  const { rows } = await query(
    `SELECT 1 FROM audit_log WHERE ten_bang = 'sua' AND id_ban_ghi = $1 AND hanh_dong = $2 LIMIT 1`,
    [String(suaId), MA_API]
  );
  return rows.length > 0;
}

// Trạng thái gửi ERP của nhiều lượt sửa — cho sidebar "Đã hoàn thành" màn Sửa.
// Trả { [suaId]: 'OK' | 'LOI' } (lượt chưa từng gửi không có khóa).
async function trangThaiGui(suaIds = []) {
  const ids = [...new Set(suaIds.filter(Boolean).map(String))];
  if (!ids.length) return {};
  const { rows } = await query(
    `SELECT id_ban_ghi, bool_or(hanh_dong = $2) AS ok FROM audit_log
      WHERE ten_bang = 'sua' AND id_ban_ghi = ANY($1::text[]) AND hanh_dong IN ($2, $3)
      GROUP BY id_ban_ghi`.replace(/\s+/g, ' '),
    [ids, MA_API, `${MA_API}_LOI`]
  );
  return Object.fromEntries(rows.map((r) => [r.id_ban_ghi, r.ok ? 'OK' : 'LOI']));
}

/**
 * Gửi 1 lượt sửa. Trả { ok, bo_qua?, ly_do?, error? }.
 * @param {string} suaId
 * @param {string} actorId
 */
async function guiSuaDat(suaId, actorId) {
  const s = await repo.getCancelSuaRow(suaId);
  if (!s) return { ok: false, bo_qua: true, ly_do: 'NOT_FOUND' };
  if (s.da_huy) return { ok: false, bo_qua: true, ly_do: 'DA_HUY' };
  const dat = Number(s.so_luong_sua_dat) || 0;
  if (dat <= 0) return { ok: false, bo_qua: true, ly_do: 'KHONG_SUA_DAT' };
  if (await daGuiThanhCong(suaId)) return { ok: true, bo_qua: true, ly_do: 'DA_GUI' };

  // Tem con của lượt (mig 100); lượt cũ chưa neo ⇒ lùi về tem con mới nhất của tem gốc.
  let temConId = s.tem_con_id;
  if (!temConId) {
    const con = await repo.getTemConCuaGoc(s.tem_id);
    temConId = con ? con.id : null;
  }
  if (!temConId) return { ok: false, bo_qua: true, ly_do: 'KHONG_TEM_17' };

  const [r] = await prodRepo.duLieuGhiInTem([{ temId: temConId, dotVaiId: null }]);
  if (!r) return { ok: false, bo_qua: true, ly_do: 'KHONG_DU_LIEU' };

  // ⚠ Cấp IDMES SAU mọi guard — mỗi lần cấp là tiêu 1 số của dãy dùng chung.
  const idMes = await capIdMes('gui-erp-sua-dat');
  if (idMes == null) return { ok: false, error: 'Không cấp được IDMES' };

  const payload = taoPayload(r, { idMes, soLuong: dat, soLuongHuy: Number(s.so_luong_sua_huy) || 0 });
  const kq = await ghiInTem(payload, { maApi: MA_API });
  if (kq.bo_qua) return { ok: false, bo_qua: true, ly_do: 'API_DANG_TAT' };

  const p = kq.data && typeof kq.data === 'object' ? kq.data : null;
  await ghiLog(MA_API, {
    thanhCong: kq.ok,
    idBanGhi: suaId,
    idMes,
    maTem: payload.BarcodeIn,
    url: env.erp.guiSuaDatUrl,
    gui: kq.body,
    nhan: kq.data,
    erpMessage: p ? (p.message ?? null) : null,
    erpError: p ? (p.error ?? null) : null,
    erpReturnValue: p && p.returnValue != null ? p.returnValue : null,
    loi: kq.error || null,
    actorId,
  });
  return kq.ok ? { ok: true } : { ok: false, error: kq.error };
}

// Bắn NGẦM sau khi xác nhận sửa — không bao giờ ném.
function guiNgam(suaId, actorId) {
  guiSuaDat(suaId, actorId).catch((e) => {
    console.error(`[gui-sua-dat] ✗ Lỗi ngoài dự kiến (lượt sửa ${suaId}): ${e.message}`);
  });
}

module.exports = { guiSuaDat, guiNgam, trangThaiGui, daGuiThanhCong, MA_API };
