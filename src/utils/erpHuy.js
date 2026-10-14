'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// BÁO ERP HỦY CHỨNG TỪ THEO IDMES (14/10/2026, người dùng yêu cầu).
//
// Trước đây hủy ở MES (hủy in tem, hủy xác nhận KCS / Sửa / OQC, hủy phiếu giao…) KHÔNG báo gì cho ERP ⇒
// MES đã hủy mà chứng từ bên ERP vẫn còn (ca thật 13/10: phiếu SF0 của tem đã hủy phải dò tay bằng SQL).
// Nay: hủy xong ở MES thì gửi IDMES của lượt đó sang ERP để ERP hủy chứng từ tương ứng.
//
// Router ERP `/gui-idmes-huy` (soạn sẵn: `docs/erp-router/gui-idmes-huy.js`) → proc
//   MES_spr_MES2SF0_Huy(@pIDMES int, @pNgayHuy datetime, @pNguoiHuy nvarchar(20), @pLydohuy nvarchar(20))
// Body: { IDMES, NgayHuy, NguoiHuy, Lydohuy, Nguon } — `Nguon` chỉ để truy vết (router bỏ qua).
//
// LUẬT:
//   · IDMES lấy từ các dòng lịch sử gửi ERP **THÀNH CÔNG** của chính bản ghi bị hủy (`audit_log`, cùng nguồn
//     với *Cài đặt API › Lịch sử*). Chưa từng gửi được (API tắt · tem mang mã MES · ERP lỗi) ⇒ ERP không có
//     chứng từ ⇒ KHÔNG gọi.
//   · 1 bản ghi có thể có nhiều IDMES (phân loại lỗi lưu lại nhiều lần — mỗi lần 1 IDMES) ⇒ gửi hủy TỪNG số.
//   · CHẠY NGẦM, KHÔNG NÉM LỖI: việc hủy ở MES đã xong, ERP chỉ là bên nhận tin. Lỗi ⇒ có dòng
//     `ERP_GUI_HUY_IDMES_LOI` ở Lịch sử, bấm "Gửi lại".
//   · `Lydohuy` cắt đúng độ dài tham số proc (`LY_DO_TOI_DA`) — tedious KHÔNG tự cắt, chuỗi dài hơn là proc
//     báo lỗi. Lý do ĐẦY ĐỦ vẫn nằm ở vết hủy của MES. ERP nới `@pLydohuy` thì đổi 1 hằng này (+ router).
// ─────────────────────────────────────────────────────────────────────────────

const env = require('../config/env');
const { query } = require('../config/db');
const { goiErp, tenDangNhap, catChuoi, ngayGio } = require('./erpApiChung');

const MA_API = 'ERP_GUI_HUY_IDMES';
const LY_DO_TOI_DA = 20;      // = @pLydohuy nvarchar(20)
const IDMES_TOI_DA = 2147483647; // @pIDMES int

// Kênh đẩy của từng loại bản ghi: `ma` = `hanh_dong` của dòng lịch sử gửi THÀNH CÔNG, `bang` = `ten_bang`
// (đúng `erpApiLog.TEN_BANG`), `id_ban_ghi` = id bản ghi (tem.id · kcs.id · sua.id · oqc.id · giao_hang.id).
// ⚠ `chiGui`: phiếu giao trước 30/09/2026 ghi `id_mes` = MÃ PHIẾU (không phải IDMES) ⇒ chỉ tin `gui.IDMES`.
const KENH = {
  IN_TEM: { ma: 'ERP_GHI_IN_TEM', bang: 'tem', ten: 'in tem' },
  TEM_GIA_CONG: { ma: 'ERP_GUI_TEM_GIA_CONG', bang: 'tem', ten: 'tem gia công' },
  KCS: { ma: 'ERP_GUI_KIEM_PHAM', bang: 'kcs', ten: 'kiểm KCS' },
  SUA: { ma: 'ERP_GUI_SUA_DAT', bang: 'sua', ten: 'sửa đạt' },
  OQC: { ma: 'ERP_GUI_OQC', bang: 'oqc', ten: 'OQC' },
  PHAN_LOAI_LOI: { ma: 'ERP_GUI_PHAN_LOAI_LOI', bang: 'tem', ten: 'phân loại lỗi' },
  PHIEU_GIAO: { ma: 'ERP_GUI_PHIEU_GIAO', bang: 'giao_hang', ten: 'phiếu giao', chiGui: true },
};

const laIdMes = (v) => /^\d{6,10}$/.test(String(v || '')) && Number(v) <= IDMES_TOI_DA;

// Các IDMES đã gửi ERP THÀNH CÔNG của 1 bản ghi (cũ → mới). `tu` (tùy chọn) = chỉ lấy lượt gửi SAU mốc này.
async function idMesDaGui(tenKenh, idBanGhi, { tu = null } = {}) {
  const k = KENH[tenKenh];
  if (!k || !idBanGhi) return [];
  const cot = k.chiGui
    ? `gia_tri_moi->'gui'->>'IDMES'`
    : `COALESCE(gia_tri_moi->'gui'->>'IDMES', gia_tri_moi->'gui'->>'IDMes', gia_tri_moi->'payload'->>'IDMES', gia_tri_moi->>'id_mes')`;
  const p = [k.bang, String(idBanGhi), k.ma];
  let dk = '';
  if (tu) { p.push(tu); dk = ` AND thoi_gian > $${p.length}`; }
  const { rows } = await query(
    `SELECT ${cot} AS id_mes, min(thoi_gian) AS tg FROM audit_log
      WHERE ten_bang = $1 AND id_ban_ghi = $2 AND hanh_dong = $3${dk}
      GROUP BY 1 ORDER BY 2`.replace(/\s+/g, ' '), p);
  return rows.map((r) => r.id_mes).filter(laIdMes).map(Number);
}

// 1 lượt gọi /gui-idmes-huy. KHÔNG ném lỗi (đi qua `goiErp`: đọc công tắc · retry · ghi Lịch sử).
// `idBanGhi` = bản ghi bị hủy · `maHien` = mã hiện ở cột "Mã" của Lịch sử (mã tem / số phiếu).
async function guiHuyIdMes(payload, { idBanGhi = null, maHien = null, actorId = null } = {}) {
  const body = {
    IDMES: Number(payload.IDMES),
    NgayHuy: ngayGio(payload.NgayHuy || new Date()),
    NguoiHuy: catChuoi(payload.NguoiHuy, 20),
    Lydohuy: catChuoi(payload.Lydohuy, LY_DO_TOI_DA),
    Nguon: catChuoi(payload.Nguon, 30),
  };
  if (!laIdMes(body.IDMES)) return { ok: false, bo_qua: true, ly_do: 'THIEU_DU_LIEU' };
  return goiErp(MA_API, {
    nhan: 'gui-idmes-huy',
    url: env.erp.guiHuyIdMesUrl,
    method: 'POST',
    body,
    timeoutMs: env.erp.guiHuyIdMesTimeoutMs,
    retry: env.erp.guiHuyIdMesRetry,
    idBanGhi,
    maTem: maHien,
    moTa: `IDMES ${body.IDMES}${body.Nguon ? ` (${body.Nguon})` : ''}`,
    actorId,
  });
}

// Báo ERP hủy MỌI IDMES đã gửi của 1 bản ghi. KHÔNG ném lỗi.
// Trả { ok, so_idmes, id_mes[], bo_qua?, ly_do?, error? } — `so_idmes = 0` ⇒ chưa từng gửi ERP, không gọi.
async function baoHuy(tenKenh, idBanGhi, { lyDo = '', actorId = null, maHien = null, tu = null } = {}) {
  const k = KENH[tenKenh];
  if (!k || !idBanGhi) return { ok: false, bo_qua: true, ly_do: 'THIEU_DU_LIEU', so_idmes: 0 };
  let ds;
  try {
    ds = await idMesDaGui(tenKenh, idBanGhi, { tu });
  } catch (e) {
    console.error(`[gui-idmes-huy] ✗ Không đọc được IDMES đã gửi của ${k.ten} ${maHien || idBanGhi}: ${e.message}`);
    return { ok: false, error: e.message, so_idmes: 0 };
  }
  if (!ds.length) {
    console.log(`[gui-idmes-huy] ⏭ ${k.ten} ${maHien || idBanGhi}: chưa từng gửi ERP thành công — không có IDMES để hủy`);
    return { ok: true, bo_qua: true, ly_do: 'CHUA_GUI_ERP', so_idmes: 0, id_mes: [] };
  }
  const NguoiHuy = await tenDangNhap(actorId);
  const NgayHuy = new Date();
  const kq = [];
  for (const IDMES of ds) {
    // eslint-disable-next-line no-await-in-loop
    const r = await guiHuyIdMes({ IDMES, NgayHuy, NguoiHuy, Lydohuy: lyDo, Nguon: tenKenh }, { idBanGhi, maHien, actorId });
    kq.push(r);
    if (r.bo_qua) break; // API đang tắt — các số sau cũng vậy
  }
  const loi = kq.filter((x) => !x.ok && !x.bo_qua);
  return {
    ok: kq.every((x) => x.ok),
    bo_qua: kq.some((x) => x.bo_qua),
    ly_do: kq.some((x) => x.bo_qua) ? 'API_DANG_TAT' : undefined,
    so_idmes: ds.length,
    id_mes: ds,
    error: loi.length ? loi.map((x) => x.error).join(' | ') : undefined,
  };
}

// Bản KHÔNG `await` cho các hàm hủy nghiệp vụ: hủy ở MES đã xong thì trả lời người dùng ngay, ERP chạy ngầm
// (timeout 10 s × 3 lần ⇒ xấu nhất ~33 s — không thể bắt người hủy đứng chờ từng ấy).
function baoHuyNgam(tenKenh, idBanGhi, o = {}) {
  baoHuy(tenKenh, idBanGhi, o).catch((e) => console.error(`[gui-idmes-huy] ✗ ${tenKenh} ${idBanGhi}: ${e.message}`));
}

module.exports = { MA_API, KENH, LY_DO_TOI_DA, idMesDaGui, guiHuyIdMes, baoHuy, baoHuyNgam };
