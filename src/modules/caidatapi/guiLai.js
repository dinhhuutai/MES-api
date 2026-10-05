'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// NÚT "GỬI LẠI ERP" Ở TỪNG DÒNG *Hệ thống › Cài đặt API › Lịch sử* (26/09/2026).
//
// Chỉ 5 API ĐẨY dữ liệu mới có nút (API XIN SỐ — mã tem 15/17/13, ID phiếu giao — gọi lại là TIÊU thêm
// một số của ERP, vô nghĩa). Mỗi API gửi lại bằng CHÍNH hàm nghiệp vụ của nó (dựng lại dữ liệu mới
// nhất), KHÔNG tự chép payload cũ ⇒ các bản vá payload (vd `BarcodeSua`, `DsMaloi` = mã,SL sửa,SL hủy) tự áp dụng.
//
// ⚠⚠ DÙNG LẠI IDMES CŨ của dòng lịch sử: 3 proc `MES2SK6` · `MES2SU6` · `MES2SQ0` đều XÓA phiếu cùng
//   `Soctcu` rồi tạo lại ⇒ gửi lại không đẻ phiếu trùng bên ERP. Dòng cũ không có IDMES ⇒ cấp số mới.
// ⚠ Phiếu giao: phải CÓ ID phiếu giao của ERP + có mã tem mới gửi — xem `delivery.service.guiLaiErp`.
// ⚠ Hàm này CÓ `await` và NÉM LỖI cho người bấm (khác nhánh ngầm): họ đang đứng chờ biết ERP nhận chưa.
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { temCode } = require('../../utils/temPrefix');
const { capIdMes } = require('../../utils/idMes');
const { ghiInTem, taoPayload, laMaTemErp } = require('../../utils/erpGhiInTem');

// "Gửi lại" cũng phải chờ có mã tem ERP cấp (30/09/2026) — tem còn mang mã MES thì báo rõ, không gửi.
const chanChuaCoMa = (maTem) => {
  if (laMaTemErp(maTem)) return;
  throw new AppError(`Tem chưa có mã do ERP cấp (đang là "${maTem || 'trống'}") — không gửi sang ERP được`,
    { status: 409, errorCode: 'CHUA_CO_MA_ERP' });
};
const erp = require('../../utils/erpApiChung');

// Mã API có nút gửi lại (FE gương ở `LichSuApiPanel` hằng `CO_GUI_LAI`).
const MA_GUI_LAI = new Set([
  'ERP_GHI_IN_TEM', 'ERP_GUI_PHIEU_GIAO', 'ERP_GUI_PHAN_LOAI_LOI', 'ERP_GUI_SUA_DAT', 'ERP_GUI_KIEM_PHAM',
  'ERP_GUI_TEM_GIA_CONG', 'ERP_GUI_DS_HUY_VAI', 'ERP_GUI_OQC', 'ERP_GUI_RELEASE_1',
]);

const soHoacNull = (v) => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? null : n; };

async function docDong(ma, auditId) {
  const { rows } = await query(
    `SELECT id, id_ban_ghi, hanh_dong, gia_tri_moi FROM audit_log
      WHERE id::text = $1 AND hanh_dong IN ($2, $3)`, [String(auditId), ma, `${ma}_LOI`]);
  return rows[0] || null;
}

// IDMES của dòng cũ — hình dạng JSON đổi qua từng giai đoạn nên dò đủ chỗ.
function idMesCu(g = {}) {
  const gui = g.gui || g.payload || {};
  return soHoacNull(g.id_mes ?? gui.IDMES ?? gui.IDMes);
}

const loiNeu = (kq, ten) => {
  if (kq && kq.ok) return;
  if (kq && kq.bo_qua && (!kq.ly_do || kq.ly_do === 'API_DANG_TAT')) {
    throw new AppError(`API "${ten}" đang TẮT ở Hệ thống › Cài đặt API`, { status: 409, errorCode: 'API_DANG_TAT' });
  }
  if (kq && kq.bo_qua) {
    throw new AppError(`Không có dữ liệu để gửi (${kq.ly_do || 'bỏ qua'})`, { status: 409, errorCode: kq.ly_do || 'THIEU_DU_LIEU' });
  }
  throw new AppError(`ERP báo lỗi: ${(kq && kq.error) || 'không rõ'}`, { status: 502, errorCode: 'ERP_LOI' });
};

async function guiLai(ma, auditId, actorId) {
  if (!MA_GUI_LAI.has(ma)) throw new AppError('API này không gửi lại được', { status: 400, errorCode: 'KHONG_GUI_LAI' });
  const d = await docDong(ma, auditId);
  if (!d) throw new AppError('Không tìm thấy dòng lịch sử', { status: 404, errorCode: 'NOT_FOUND' });
  const g = d.gia_tri_moi || {};
  // GN hủy vải — dòng không gắn bản ghi (1 lượt nhiều phần in) ⇒ gửi lại ĐÚNG danh sách code phần đã gửi,
  //   giữ nguyên ID kết nối cũ để 2 bên vẫn khớp.
  if (ma === 'ERP_GUI_DS_HUY_VAI') {
    const gui = g.gui || {};
    const ds = String(gui.DsPhan || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!ds.length) throw new AppError('Dòng lịch sử không có danh sách code phần', { status: 409, errorCode: 'THIEU_DU_LIEU' });
    const kq = await erp.guiDsHuyVai(ds, { actorId, idKetNoi: gui.IDKetNoi || g.id_mes || null });
    loiNeu(kq, 'Gửi danh sách hủy vải');
    return { ok: true };
  }
  // Release 1 / kế hoạch lệnh (04/10/2026) — gửi lại ĐÚNG thân đã gửi (IDMES + DsRelease cũ), xem
  //   `planning/release1Erp.guiLai` vì sao không dựng lại từ dữ liệu hiện tại.
  if (ma === 'ERP_GUI_RELEASE_1') {
    const release1Erp = require('../planning/release1Erp');
    const kq = await release1Erp.guiLai(g.gui, { idBanGhi: d.id_ban_ghi, actorId });
    if (kq && kq.bo_qua && kq.ly_do === 'THIEU_DU_LIEU') {
      throw new AppError('Dòng lịch sử không có dữ liệu đã gửi (DsRelease) — không gửi lại được', { status: 409, errorCode: 'THIEU_DU_LIEU' });
    }
    loiNeu(kq, 'Gửi dữ liệu Release 1');
    return { ok: true };
  }
  const id = d.id_ban_ghi;
  if (!id || id === '-') throw new AppError('Dòng lịch sử không gắn bản ghi nào — không gửi lại được', { status: 409, errorCode: 'THIEU_DU_LIEU' });

  if (ma === 'ERP_GUI_PHIEU_GIAO') {
    // Lazy require: delivery.service nạp nhiều module, tránh vòng require khi app khởi động.
    const delivery = require('../delivery/delivery.service');
    // ⚠ CHỈ lấy `gui.IDMES` — dòng cũ (trước 30/09/2026) ghi `id_mes` = MÃ PHIẾU giao, đem dùng làm IDMES là sai.
    return delivery.guiLaiErp(id, actorId, soHoacNull((g.gui || {}).IDMES));
  }

  if (ma === 'ERP_GUI_SUA_DAT') {
    const suaDatErp = require('../quality/suaDatErp');
    const kq = await suaDatErp.guiSuaDat(id, actorId, { guiLai: true, idMes: idMesCu(g) });
    loiNeu(kq, 'Gửi sửa đạt');
    return { ok: true };
  }

  if (ma === 'ERP_GUI_KIEM_PHAM') {
    const qaRepo = require('../quality/quality.repository');
    const kiemPhamErp = require('../quality/kiemPhamErp');
    const k = await qaRepo.getCancelKcsRow(id);
    if (!k) throw new AppError('Lượt KCS không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
    if (k.da_huy) throw new AppError('Lượt KCS này đã bị hủy xác nhận — không gửi lại', { status: 409, errorCode: 'DA_HUY' });
    const gui = g.gui || {};
    const thieu = soHoacNull(gui.SOLUONGTHIEU) ?? Math.max(0, -(Number(k.so_luong_chenh_lech) || 0));
    const kq = await kiemPhamErp.guiKiemPham(id, k.tem_id,
      { dat: k.so_luong_dat, hu: k.so_luong_loi, thieu }, actorId, { guiLai: true, idMes: idMesCu(g) });
    loiNeu(kq, 'Gửi kiểm KCS');
    return { ok: true };
  }

  // OQC bốc mẫu (02/10/2026) — dựng lại từ lượt `oqc` (lượt đã hủy xác nhận / không qua giao ⇒ 409).
  if (ma === 'ERP_GUI_OQC') {
    const oqcErp = require('../quality/oqcErp');
    const kq = await oqcErp.guiOqc(id, actorId, { guiLai: true, idMes: idMesCu(g) });
    if (kq && kq.bo_qua && kq.ly_do === 'DA_HUY') {
      throw new AppError('Lượt OQC này đã bị hủy xác nhận — không gửi lại', { status: 409, errorCode: 'DA_HUY' });
    }
    loiNeu(kq, 'Gửi kết quả OQC');
    return { ok: true };
  }

  if (ma === 'ERP_GUI_PHAN_LOAI_LOI') {
    const plRepo = require('../quality/phanloailoi.repository');
    const phieu = await plRepo.getPhieuTheoTem(id);
    const dsLoi = phieu ? erp.dsMaLoi(phieu.dong) : '';
    if (!dsLoi) throw new AppError('Tem chưa có phiếu phân loại lỗi (có mã lỗi) — không có dữ liệu để gửi', { status: 409, errorCode: 'THIEU_DU_LIEU' });
    const { rows: t } = await query(
      `SELECT ma_tem, to_char(now() AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY/MM/DD HH24:MI:SS') AS bay_gio FROM tem WHERE id = $1`, [id]);
    if (!t[0]) throw new AppError('Tem không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
    chanChuaCoMa(t[0].ma_tem);
    const idMes = idMesCu(g) ?? await capIdMes('gui-erp-phan-loai-loi');
    const kq = await erp.guiPhanLoaiLoi({
      IDMes: String(idMes), Ngayct: t[0].bay_gio, nhanvien: await erp.tenDangNhap(actorId),
      Maquet: temCode(t[0].ma_tem, 16), DsMaloi: dsLoi,
    }, { temId: id, actorId });
    loiNeu(kq, 'Gửi phân loại lỗi');
    return { ok: true };
  }

  // ERP_GHI_IN_TEM · ERP_GUI_TEM_GIA_CONG — dựng lại từ tem + GIỮ các số lượng đã gửi lần trước (tem gia
  //   công báo ĐẠT/HỦY riêng, không suy lại được từ tem). Ngày chứng từ giữ ngày cũ nếu có.
  const prodRepo = require('../production/production.repository');
  const cu = g.gui || g.payload || {};
  const ngayCt = cu.Ngayct ? String(cu.Ngayct).slice(0, 10).replace(/\//g, '-') : null;
  // Tem gia công nhận theo code phần có `tem.dot_vai_ve_id` (mig 095) — dùng đúng đợt đó; thiếu cột thì đợt đại diện.
  let dotVaiId = null;
  try {
    const { rows: dv } = await query('SELECT dot_vai_ve_id FROM tem WHERE id = $1', [id]);
    dotVaiId = (dv[0] && dv[0].dot_vai_ve_id) || null;
  } catch { dotVaiId = null; }
  const [r] = await prodRepo.duLieuGhiInTem([{ temId: id, dotVaiId }], ngayCt);
  if (!r) throw new AppError('Không đọc được dữ liệu tem — không gửi lại được', { status: 409, errorCode: 'THIEU_DU_LIEU' });
  chanChuaCoMa(r.ma_tem);
  const ten = ma ==='ERP_GUI_TEM_GIA_CONG' ? 'Gửi dữ liệu tem gia công' : 'Báo ERP mỗi lần in tem';
  const idMes = idMesCu(g) ?? await capIdMes(ma === 'ERP_GUI_TEM_GIA_CONG' ? 'gui-tem-gia-cong' : 'ghi-in-tem');
  const payload = taoPayload(r, {
    idMes,
    soLuong: soHoacNull(cu.Soluong),
    soLuongHuy: soHoacNull(cu.Soluongloi) || 0,
    soLuongThieu: soHoacNull(cu.SOLUONGTHIEU) || 0,
  });
  const kq = await ghiInTem(payload, { maApi: ma });
  if (kq.bo_qua) loiNeu({ bo_qua: true, ly_do: 'API_DANG_TAT' }, ten);
  await prodRepo.logGhiInTem(id, kq.ok, kq.body, kq.error, actorId, kq.data, ma);
  loiNeu(kq, ten);
  return { ok: true };
}

module.exports = { guiLai, MA_GUI_LAI };
