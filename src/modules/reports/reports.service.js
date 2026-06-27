'use strict';

const repo = require('./reports.repository');
const AppError = require('../../utils/AppError');

const DEFS = {
  'san-luong': {
    ten: 'Báo cáo sản lượng theo lệnh',
    columns: [
      { key: 'ma_lenh_san_xuat', header: 'Mã lệnh' },
      { key: 'ma_chuyen', header: 'Chuyền' },
      { key: 'ke_hoach', header: 'Kế hoạch' },
      { key: 'da_in', header: 'Đã in' },
      { key: 'so_tem', header: 'Số tem' },
      { key: 'trang_thai', header: 'Trạng thái' },
    ],
    fn: repo.sanLuong,
  },
  'chat-luong': {
    ten: 'Báo cáo chất lượng (KCS)',
    columns: [
      { key: 'ma_tem', header: 'Tem' },
      { key: 'ma_lenh_san_xuat', header: 'Lệnh SX' },
      { key: 'so_luong_kiem', header: 'Kiểm' },
      { key: 'so_luong_dat', header: 'Đạt' },
      { key: 'so_luong_loi', header: 'Lỗi' },
      { key: 'so_luong_huy', header: 'Hủy' },
      { key: 'ket_qua', header: 'Kết quả' },
    ],
    fn: repo.chatLuong,
  },
  'giao-hang': {
    ten: 'Báo cáo giao hàng',
    columns: [
      { key: 'ma_phieu_giao', header: 'Mã phiếu' },
      { key: 'ten_khach_hang', header: 'Khách hàng' },
      { key: 'ma_don_hang', header: 'Đơn hàng' },
      { key: 'so_tem', header: 'Số tem' },
      { key: 'tong_sl', header: 'Tổng SL' },
      { key: 'ngay_giao', header: 'Ngày giao' },
      { key: 'trang_thai', header: 'Trạng thái' },
    ],
    fn: repo.giaoHang,
  },
};

function listReports() {
  return Object.entries(DEFS).map(([ma, d]) => ({ ma, ten: d.ten }));
}

async function getReport(ma) {
  const def = DEFS[ma];
  if (!def) throw new AppError('Báo cáo không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const rows = await def.fn();
  return { ma, ten: def.ten, columns: def.columns, rows };
}

module.exports = { listReports, getReport };
