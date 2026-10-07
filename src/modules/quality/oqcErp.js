'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// GỬI KẾT QUẢ OQC BỐC MẪU SANG ERP — POST /gui-erp-oqc → proc `MES_spr_MES2QO6` (02/10/2026).
//
// Proc nhận ĐÚNG bộ 20 tham số của `ghi-in-tem`, riêng mã tem nằm ở `@pBarcodeSua` (như SK6) ⇒ tái dùng
// `duLieuGhiInTem` + `taoPayload` + `ghiInTem({ maApi })` (kênh `ERP_GUI_OQC` khai `them: BarcodeSua`),
// KHÔNG chép luồng.
//   · `BarcodeSua` (+ `BarcodeIn`) = mã tem ĐÚNG NHƯ NHÃN của nguồn OQC: nguồn KCS → `15…`, nguồn SỬA (dữ liệu
//     trước mig 091) → `17…`, tem con 17 / tem gia công 13 đã mang mã riêng thì giữ nguyên (`maTemNhan`, cùng
//     luật `DsTemGiao` của phiếu giao).
//   · `Soluong` = SL QUA GIAO của lượt (cả lô nguồn khi ĐẠT hoặc cho giao ngoại lệ) — đi tiếp sang giao, khớp
//     nghĩa "chuyển giao" của SH6/SK6. Σ Soluong mọi lượt OQC của 1 tem = SL tem được qua giao (không đếm đôi).
//   · `Soluongloi` = SL LỖI TRONG MẪU (bốc mẫu − đạt; lượt ĐẠT luôn 0 vì đạt = đạt hết mẫu) · `SOLUONGTHIEU` = 0.
//   ⚠ Lượt KHÔNG ĐẠT nằm lại OQC (qua giao = 0) KHÔNG gửi: không có hàng nào đi tiếp. Muốn gửi cả lượt đó thì
//     bỏ guard `KHONG_QUA_GIAO` bên dưới — đúng 1 chỗ.
//   · Ngày ca / giờ: như kiểm phẩm — tem có thì giữ, thiếu ⇒ mã ngày ca HÔM NAY + MỐC XÁC NHẬN OQC.
//
// ⚠ GỬI ĐÚNG 1 LẦN MỖI LƯỢT OQC — khóa chống trùng = `oqc.id` (`audit_log ten_bang='oqc'`).
// ⚠ KHÔNG BAO GIỜ NÉM LỖI khi chạy ngầm (bên gọi không `await`) — hỏng chiều đẩy không chặn xác nhận OQC.
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../../config/db');
const env = require('../../config/env');
const { ghiInTem, taoPayload, laMaTemErp, ghiChuaCoMaErp } = require('../../utils/erpGhiInTem');
const { ghiLog } = require('../../utils/erpApiLog');
const { capIdMes } = require('../../utils/idMes');
const { maTemNhan } = require('../../utils/temPrefix');
const prodRepo = require('../production/production.repository');
const planningRepo = require('../planning/planning.repository');
const repo = require('./quality.repository');
const { maNgayCaHomNay } = require('./suaDatErp');

const MA_API = 'ERP_GUI_OQC';

async function daGuiThanhCong(oqcId) {
  const { rows } = await query(
    `SELECT 1 FROM audit_log WHERE ten_bang = 'oqc' AND id_ban_ghi = $1 AND hanh_dong = $2 LIMIT 1`,
    [String(oqcId), MA_API]
  );
  return rows.length > 0;
}

// Mốc xác nhận lượt OQC theo giờ VN, đúng định dạng trường ngày của `ghi-in-tem`. Lỗi ⇒ bây giờ.
async function mocXacNhanOqc(oqcId) {
  try {
    const { rows } = await query(
      `SELECT to_char(COALESCE((SELECT created_date FROM oqc WHERE id = $1), now()) AT TIME ZONE 'Asia/Ho_Chi_Minh',
              'YYYY/MM/DD HH24:MI:SS') AS moc`, [oqcId]);
    return rows[0] ? rows[0].moc : null;
  } catch { return null; }
}

// Đợt vải của tem (tem 13 gia công nhận theo code phần có `tem.dot_vai_ve_id`, mig 095) — để
// `duLieuGhiInTem` lấy đúng DDHID/subID/đợt nhận vải; tem sản xuất để NULL ⇒ đợt đại diện của lệnh.
async function dotVaiCuaTem(temId) {
  if (!(await planningRepo.temCoCotDotVai())) return null;
  const { rows } = await query('SELECT dot_vai_ve_id FROM tem WHERE id = $1', [temId]);
  return (rows[0] && rows[0].dot_vai_ve_id) || null;
}

/**
 * Gửi 1 lượt OQC. Trả { ok, bo_qua?, ly_do?, error?, id_mes? }.
 * `opts` = { guiLai, idMes } — nút "Gửi lại ERP" ở Cài đặt API › Lịch sử: bỏ chặn "đã gửi" và DÙNG LẠI IDMES cũ.
 */
async function guiOqc(oqcId, actorId = null, opts = {}) {
  if (!oqcId) return { ok: false, bo_qua: true, ly_do: 'THIEU_DU_LIEU' };
  const o = await repo.getCancelOqcRow(oqcId);
  if (!o) return { ok: false, bo_qua: true, ly_do: 'NOT_FOUND' };
  if (o.da_huy) return { ok: false, bo_qua: true, ly_do: 'DA_HUY' };
  const quaGiao = Number(o.sl_qua_giao) || 0;
  if (quaGiao <= 0) return { ok: false, bo_qua: true, ly_do: 'KHONG_QUA_GIAO' };
  if (!opts.guiLai && await daGuiThanhCong(oqcId)) return { ok: true, bo_qua: true, ly_do: 'DA_GUI' };

  const [r] = await prodRepo.duLieuGhiInTem([{ temId: o.tem_id, dotVaiId: await dotVaiCuaTem(o.tem_id) }]);
  if (!r) return { ok: false, bo_qua: true, ly_do: 'KHONG_DU_LIEU' };
  // Chờ có mã tem ERP cấp mới gửi (30/09/2026).
  if (!laMaTemErp(r.ma_tem)) return ghiChuaCoMaErp(MA_API, { idBanGhi: oqcId, maTem: r.ma_tem, actorId });

  // ⚠ Cấp IDMES SAU mọi guard — mỗi lần cấp là tiêu 1 số của dãy dùng chung.
  const idMes = opts.idMes != null ? opts.idMes : await capIdMes('gui-erp-oqc');
  if (idMes == null) return { ok: false, error: 'Không cấp được IDMES' };

  const payload = taoPayload(r, { idMes, soLuong: quaGiao, soLuongHuy: Number(o.so_luong_loi) || 0 });
  payload.BarcodeIn = maTemNhan(r.ma_tem, o.nguon === 'SUA' ? 17 : 15, null, r.la_tem_sua);
  if (!payload.Ngayca) payload.Ngayca = await maNgayCaHomNay(r.loai_chuyen);
  const moc = await mocXacNhanOqc(oqcId);
  if (!payload.Tugio) payload.Tugio = moc;
  if (!payload.Dengio) payload.Dengio = moc;
  if (!payload.Ngayct) payload.Ngayct = moc ? moc.slice(0, 10) : null;

  const kq = await ghiInTem(payload, { maApi: MA_API });
  if (kq.bo_qua) return { ok: false, bo_qua: true, ly_do: 'API_DANG_TAT' };

  const p = kq.data && typeof kq.data === 'object' ? kq.data : null;
  await ghiLog(MA_API, {
    thanhCong: kq.ok,
    idBanGhi: oqcId,
    idMes,
    maTem: payload.BarcodeIn,
    url: env.erp.guiOqcUrl,
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

// Bắn NGẦM sau khi xác nhận OQC — không bao giờ ném.
function guiNgam(oqcId, actorId) {
  guiOqc(oqcId, actorId).catch((e) => {
    console.error(`[gui-oqc] ✗ Lỗi ngoài dự kiến (lượt OQC ${oqcId}): ${e.message}`);
  });
}

module.exports = { guiOqc, guiNgam, daGuiThanhCong, MA_API };
