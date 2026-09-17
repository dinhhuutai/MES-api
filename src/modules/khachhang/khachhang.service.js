'use strict';

const repo = require('./khachhang.repository');
const AppError = require('../../utils/AppError');
const { buildMeta } = require('../../utils/pagination');

// Cắt khoảng trắng thừa + chặn chuỗi quá dài. Cột là TEXT nên không có trần cứng ở DB, nhưng địa chỉ
// dài quá sẽ phá bố cục phiếu in ⇒ chặn ngay ở đây thay vì để người dùng in ra mới thấy vỡ.
const DAI_TOI_DA = 500;
function chuan(v, ten) {
  if (v === undefined) return undefined;
  const s = String(v == null ? '' : v).trim().replace(/[ \t]+/g, ' ');
  if (s.length > DAI_TOI_DA) {
    throw new AppError(`${ten} quá dài (tối đa ${DAI_TOI_DA} ký tự)`, { status: 422, errorCode: 'QUA_DAI' });
  }
  return s;
}

async function danhSach({ search, page, limit, offset }) {
  const { rows, total, co_cot } = await repo.list({ search, offset, limit });
  return { items: rows, meta: { ...buildMeta(page, limit, total), co_cot } };
}

async function capNhat(id, body = {}, actorId) {
  const cu = await repo.getById(id);
  if (!cu) throw new AppError('Không tìm thấy khách hàng', { status: 404, errorCode: 'NOT_FOUND' });

  // ⚠ Thiếu mig 099 mà người dùng vẫn gửi địa chỉ lên (tab để lâu, F5 chưa tải lại) ⇒ báo RÕ thay vì
  //   im lặng bỏ qua rồi để họ tưởng đã lưu.
  const co = await repo.coCotDiaChi();
  if (!co && (body.diaChi !== undefined || body.diaChiGiao !== undefined)) {
    throw new AppError('Chưa chạy migration 099 — chưa lưu được địa chỉ khách hàng',
      { status: 409, errorCode: 'THIEU_MIGRATION' });
  }

  const data = {
    diaChi: chuan(body.diaChi, 'Địa chỉ'),
    diaChiGiao: chuan(body.diaChiGiao, 'Địa chỉ giao hàng'),
    ghiChu: chuan(body.ghiChu, 'Ghi chú'),
  };
  if (Object.values(data).every((v) => v === undefined)) {
    throw new AppError('Không có gì để cập nhật', { status: 422, errorCode: 'NOTHING' });
  }
  await repo.update(id, data, actorId);
  return repo.getById(id);
}

module.exports = { danhSach, capNhat };
