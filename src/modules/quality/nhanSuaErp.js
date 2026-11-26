'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// GỬI NHẬN SỬA SANG ERP — proc `MES_spr_MES2JH0` (26/11/2026, người dùng chốt: "khi nhận sửa gọi đến câu này; thiết bị, thợ
//   cũng lấy từ tem in qua").
//
// 1 LƯỢT NHẬN SỬA (`nhan_sua`, loại `NHAN`) = 1 lần gọi, khóa chống trùng = `nhan_sua.id` (`audit_log` `ten_bang='nhan_sua'`).
// Thân = bộ 20 trường của ghi-in-tem dựng từ TEM 15 (`duLieuGhiInTem` + `taoPayload`, KHÔNG chép luồng), rồi:
//   · Soluong      = SL NHẬN của lượt.
//   · BarcodeSua16 = nhãn hàng lỗi của tem (16 + 10 số sau mã tem 15) · BarcodeSua17 = '' (lúc nhận chưa có tem 17).
//   · Ca trưởng · chuyền trưởng · thợ in · CHUYỀN (`banin`) · TỔ IN = của lượt IN TEM SF0 (`utils/phanCongSf0`, `thietBi`) —
//     không có SF0 ⇒ giữ của tem (chuyền lúc in, tổ của phiếu).
//   · Ngày CT / Ngày ca / Từ giờ / Đến giờ = MỐC NHẬN của lượt (không phải lúc bấm gửi) ⇒ "Gửi lại ERP" ngày sau vẫn đúng ngày.
//   · IDDotNhanvai · DDHID · DDHsubID · inbosung · Lenhbosung = của tem (như SF0).
// Hủy lượt nhận ⇒ báo ERP hủy IDMES (`utils/erpHuy` KENH.NHAN_SUA, gọi ở `nhansua.service huyNhanSua`).
// ⚠ KHÔNG BAO GIỜ NÉM LỖI khi chạy ngầm (bên gọi không `await`).
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../../config/db');
const env = require('../../config/env');
const { ghiInTem, taoPayload, dungThanGui, laMaTemErp, ghiChuaCoMaErp } = require('../../utils/erpGhiInTem');
const { ghiLog } = require('../../utils/erpApiLog');
const { thuCua } = require('../../utils/erpThuLai');
const { capIdMes } = require('../../utils/idMes');
const { apPhanCongSf0 } = require('../../utils/phanCongSf0');
const { temCode, laMaErp } = require('../../utils/temPrefix');
const prodRepo = require('../production/production.repository');
const { maNgayCaTaiMoc } = require('./suaDatErp');

const MA_API = 'ERP_GUI_NHAN_SUA';

// Lượt nhận + mốc nhận (giờ VN, 'YYYY/MM/DD HH24:MI:SS').
async function docLuot(nhanSuaId) {
  const { rows } = await query(
    `SELECT n.id, n.tem_id, n.so_luong, n.loai, n.da_huy, t.ma_tem,
            to_char(n.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY/MM/DD HH24:MI:SS') AS moc
       FROM nhan_sua n JOIN tem t ON t.id = n.tem_id WHERE n.id::text = $1`.replace(/\s+/g, ' '), [String(nhanSuaId)]);
  return rows[0] || null;
}

async function daGuiThanhCong(nhanSuaId) {
  const { rows } = await query(
    'SELECT 1 FROM audit_log WHERE ten_bang = $1 AND id_ban_ghi = $2 AND hanh_dong = $3 LIMIT 1',
    ['nhan_sua', String(nhanSuaId), MA_API]);
  return rows.length > 0;
}

// Payload THÔ (trước `chuanHoa`) của 1 lượt — dùng chung cho gửi API và bộ sinh script SQL Server
//   (`scripts/taoSqlServerNhanSua.js`). Trả null khi không đọc được dữ liệu tem.
async function dungPayload(l, idMes) {
  const moc = l.moc;
  const ngayCt = moc ? moc.slice(0, 10).replace(/\//g, '-') : null;
  const [r] = await prodRepo.duLieuGhiInTem([{ temId: l.tem_id, dotVaiId: null }], ngayCt);
  if (!r) return null;
  const payload = taoPayload(r, { idMes, soLuong: Number(l.so_luong) || 0 });
  try { await apPhanCongSf0(payload, l.tem_id, { thietBi: true }); } catch (e) {
    console.error(`[gui-nhan-sua] ⚠ Không đọc được phân công SF0 (tem ${l.ma_tem}): ${e.message}`);
  }
  payload.Ngayca = await maNgayCaTaiMoc(moc, r.loai_chuyen);
  payload.Tugio = moc;
  payload.Dengio = moc;
  payload.BarcodeSua16 = laMaErp(r.ma_tem) ? temCode(r.ma_tem, 16) : '';
  payload.BarcodeSua17 = '';
  return payload;
}

// Thân ĐÚNG như sẽ gửi (đã chuẩn hóa + mã số nhân viên) — cho bộ sinh script SQL Server.
async function dungThan(l, idMes) {
  const p = await dungPayload(l, idMes);
  return p ? dungThanGui(p, MA_API) : null;
}

/**
 * Gửi 1 lượt nhận sửa. Trả { ok, bo_qua?, ly_do?, error?, id_mes? }.
 * `opts` = { guiLai, idMes } — nút "Gửi lại ERP": bỏ chặn "đã gửi" + dùng lại IDMES cũ.
 */
async function guiNhanSua(nhanSuaId, actorId, opts = {}) {
  const l = await docLuot(nhanSuaId);
  if (!l) return { ok: false, bo_qua: true, ly_do: 'NOT_FOUND' };
  if (l.da_huy) return { ok: false, bo_qua: true, ly_do: 'DA_HUY' };
  if (l.loai !== 'NHAN') return { ok: false, bo_qua: true, ly_do: 'LUOT_CU' }; // `CU` = dữ liệu mig 132, không phải lượt nhận thật
  if (!(Number(l.so_luong) > 0)) return { ok: false, bo_qua: true, ly_do: 'KHONG_SO_LUONG' };
  if (!opts.guiLai && await daGuiThanhCong(nhanSuaId)) return { ok: true, bo_qua: true, ly_do: 'DA_GUI' };
  if (!laMaTemErp(l.ma_tem)) return ghiChuaCoMaErp(MA_API, { idBanGhi: nhanSuaId, maTem: l.ma_tem, actorId });

  // ⚠ Cấp IDMES SAU mọi guard (mỗi lần cấp tiêu 1 số của dãy dùng chung) — nhưng API tắt thì đừng tiêu số.
  if (!opts.guiLai && !(await require('../../utils/caiDatApi').apiBat(MA_API))) return { ok: false, bo_qua: true, ly_do: 'API_DANG_TAT' };
  const idMes = opts.idMes != null ? opts.idMes : await capIdMes('gui-erp-nhan-sua');
  if (idMes == null) return { ok: false, error: 'Không cấp được IDMES' };

  const payload = await dungPayload(l, idMes);
  if (!payload) return { ok: false, bo_qua: true, ly_do: 'KHONG_DU_LIEU' };
  const kq = await ghiInTem(payload, { maApi: MA_API });
  if (kq.bo_qua) return { ok: false, bo_qua: true, ly_do: 'API_DANG_TAT' };

  const p = kq.data && typeof kq.data === 'object' ? kq.data : null;
  await ghiLog(MA_API, {
    thanhCong: kq.ok,
    idBanGhi: nhanSuaId,
    idMes,
    maTem: payload.BarcodeIn,
    url: env.erp.guiNhanSuaUrl,
    gui: kq.body,
    nhan: kq.data,
    erpMessage: p ? (p.message ?? null) : null,
    erpError: p ? (p.error ?? null) : null,
    erpReturnValue: p && p.returnValue != null ? p.returnValue : null,
    loi: kq.error || null,
    ...thuCua(kq),
    actorId,
  });
  return kq.ok ? { ok: true, id_mes: idMes } : { ok: false, error: kq.error };
}

// Bắn NGẦM sau khi nhận sửa — TUẦN TỰ từng lượt (1 lô nhận nhiều tem; router ERP xếp hàng theo URL), không bao giờ ném.
function guiNgam(nhanSuaIds = [], actorId = null) {
  const ids = (Array.isArray(nhanSuaIds) ? nhanSuaIds : [nhanSuaIds]).filter(Boolean);
  if (!ids.length) return;
  (async () => {
    for (const id of ids) {
      try {
        await guiNhanSua(id, actorId); // eslint-disable-line no-await-in-loop
      } catch (e) {
        console.error(`[gui-nhan-sua] ✗ Lỗi ngoài dự kiến (lượt nhận ${id}): ${e.message}`);
      }
    }
  })();
}

module.exports = { MA_API, guiNhanSua, guiNgam, docLuot, dungPayload, dungThan, daGuiThanhCong };
