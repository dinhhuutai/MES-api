'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// PHÂN LOẠI LỖI — nghiệp vụ (mig 075).
//
// ⚠⚠ ĐÂY LÀ NGUỒN CHÍNH THỨC CỦA PHẦN CHIA SỬA / HỦY (người dùng chốt 10/08/2026):
//   lưu phiếu ⇒ `tem.sl_kcs_sua = Σ sửa`, `tem.sl_kcs_huy = Σ hủy` (ĐẶT THẲNG, không cộng dồn).
//   KCS vẫn là nơi chốt tổng ĐẠT / HƯ; trang này chỉ CHIA LẠI phần hư đó.
//
// Bất biến giữ sổ cái §11.4 luôn cân:
//   · `so_luong`, `sl_chenh_lech`, `sl_kcs_dat` KHÔNG đụng ⇒ tổng cần kiểm không đổi.
//   · Σ(sửa + hủy) BẮT BUỘC = SL hư hiện tại (`sl_kcs_sua + sl_kcs_huy`) ⇒ `con_kcs` không đổi.
//   · Không được hạ `sửa` xuống dưới phần SỬA ĐÃ XỬ LÝ (`sl_sua_dat + sl_sua_huy`) — phần đó đã đi
//     tiếp sang OQC/giao, hạ xuống sẽ làm `con_sua` ÂM.
// ─────────────────────────────────────────────────────────────────────────────

const { withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { baseMaTem } = require('../../utils/temPrefix');
const repo = require('./phanloailoi.repository');
const qualityRepo = require('./quality.repository');

const soNguyen = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
};

async function danhSach(q) { return repo.listTheoNgay(q); }

// Quét mã vạch / gõ tay → trả thông tin tem + phiếu đã có (nếu có).
// `baseMaTem` quy mọi tiền tố công đoạn (13/15/16/17) + hậu tố lần giao về mã gốc đang lưu.
async function traTem(code) {
  const ma = baseMaTem(code);
  if (!ma) throw new AppError('Chưa nhập mã tem', { status: 422, errorCode: 'NO_CODE' });
  const tem = await repo.timTemDePhanLoai(ma);
  if (!tem) throw new AppError(`Không tìm thấy tem "${code}"`, { status: 404, errorCode: 'NOT_FOUND' });
  if (tem.trang_thai === 'HUY') throw new AppError(`Tem ${tem.ma_tem} đã bị HỦY`, { status: 409, errorCode: 'TEM_HUY' });
  const phieu = await repo.getPhieuTheoTem(tem.tem_id);
  return { tem, phieu };
}

const chiTiet = async (temId) => ({
  tem: await repo.timTemDePhanLoai(temId), phieu: await repo.getPhieuTheoTem(temId),
});

// ─── LƯU PHIẾU ───────────────────────────────────────────────────────────────
async function luu(temId, { dong = [], ghiChu = '' } = {}, actorId) {
  const rows = (Array.isArray(dong) ? dong : [])
    .map((d) => ({ ...d, soLuongSua: soNguyen(d.soLuongSua), soLuongHuy: soNguyen(d.soLuongHuy) }))
    .filter((d) => d.loaiLoiId && (d.soLuongSua > 0 || d.soLuongHuy > 0));
  if (!rows.length) throw new AppError('Chưa nhập dòng lỗi nào có số lượng', { status: 422, errorCode: 'NO_ROW' });

  const sd = await qualityRepo.getTemLedger(temId);
  if (!sd) throw new AppError('Không tìm thấy tem', { status: 404, errorCode: 'NOT_FOUND' });

  const slHu = Number(sd.sl_kcs_sua || 0) + Number(sd.sl_kcs_huy || 0);
  if (slHu <= 0) {
    throw new AppError('Tem này KCS chưa ghi nhận số lượng hư nào — không có gì để phân loại', { status: 409, errorCode: 'KHONG_CO_HU' });
  }

  const tongSua = rows.reduce((s, d) => s + d.soLuongSua, 0);
  const tongHuy = rows.reduce((s, d) => s + d.soLuongHuy, 0);
  if (tongSua + tongHuy !== slHu) {
    throw new AppError(
      `Tổng sửa + hủy (${tongSua} + ${tongHuy} = ${tongSua + tongHuy}) phải bằng đúng SL hư KCS đã ghi (${slHu})`,
      { status: 422, errorCode: 'LECH_TONG' }
    );
  }

  // Phần SỬA đã xử lý xong thì không được hạ dưới nó (nếu không `con_sua` âm).
  const daXuLySua = Number(sd.sl_sua_dat || 0) + Number(sd.sl_sua_huy || 0);
  if (tongSua < daXuLySua) {
    throw new AppError(
      `Đã sửa xong ${daXuLySua} pcs của tem này rồi — tổng SỬA không được nhỏ hơn ${daXuLySua}`,
      { status: 409, errorCode: 'DA_SUA_ROI' }
    );
  }

  await withTransaction(async (client) => {
    const phieuId = await repo.upsertPhieuTx(
      client, temId, { ghiChu, slHu, slSua: tongSua, slHuy: tongHuy }, actorId
    );
    await repo.replaceChiTietTx(client, phieuId, rows, actorId);
    await repo.datChiaSuaHuyTx(client, temId, { sua: tongSua, huy: tongHuy }, actorId);
    // Trạng thái tem = công đoạn kém tiến độ nhất còn hàng — phải tính lại vì `con_sua` vừa đổi.
    await qualityRepo.recomputeTemStageMany(client, [temId], actorId);
    await client.query(
      `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_cu, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
       VALUES ('tem', $1, 'PHAN_LOAI_LOI', $2::jsonb, $3::jsonb, $4, CURRENT_TIMESTAMP, $4)`.replace(/\s+/g, ' '),
      [String(temId),
        JSON.stringify({ sl_kcs_sua: sd.sl_kcs_sua, sl_kcs_huy: sd.sl_kcs_huy }),
        JSON.stringify({ sl_kcs_sua: tongSua, sl_kcs_huy: tongHuy, sl_hu: slHu, so_dong: rows.length, ghi_chu: ghiChu || null }),
        actorId]
    );
  });

  return { tem_id: temId, tong_sua: tongSua, tong_huy: tongHuy, sl_hu: slHu };
}

// ─── Danh mục biện pháp xử lý ────────────────────────────────────────────────
const dsBienPhap = (q) => repo.listBienPhap(q);

async function taoBienPhap(d, actorId) {
  const ma = String(d.maBienPhap || '').trim().toUpperCase();
  if (!ma || !String(d.tenBienPhap || '').trim()) {
    throw new AppError('Thiếu mã hoặc tên biện pháp', { status: 422, errorCode: 'VALIDATION_ERROR' });
  }
  if (await repo.existsMaBienPhap(ma)) throw new AppError(`Mã "${ma}" đã tồn tại`, { status: 409, errorCode: 'MA_TRUNG' });
  const id = await repo.createBienPhap({ ...d, maBienPhap: ma }, actorId);
  return { id };
}

const suaBienPhap = (id, d, actorId) => repo.updateBienPhap(id, d, actorId);
const doiTrangThaiBienPhap = (id, active, actorId) => repo.setBienPhapActive(id, active, actorId);

module.exports = {
  danhSach, traTem, chiTiet, luu,
  dsBienPhap, taoBienPhap, suaBienPhap, doiTrangThaiBienPhap,
};
