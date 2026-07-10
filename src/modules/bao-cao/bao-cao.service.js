'use strict';

const repo = require('./bao-cao.repository');
const metrics = require('./metrics');
const { evaluateGrid } = require('./formula');
const AppError = require('../../utils/AppError');

function listMetrics() {
  return metrics.catalog();
}

async function listReports({ search, userId, all }) {
  return repo.list({ search: search || '', userId, all: !!all });
}

async function getReport(id) {
  const rep = await repo.findById(id);
  if (!rep || rep.dang_hoat_dong === false) throw new AppError('Báo cáo không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  return rep;
}

async function createReport({ tenBaoCao, moTa, noiDungJson, kyTu, kyDen }, actorId) {
  if (!tenBaoCao) throw new AppError('Thiếu tên báo cáo', { status: 422, errorCode: 'VALIDATION' });
  const maBaoCao = await repo.nextMa();
  const id = await repo.create({ maBaoCao, tenBaoCao, moTa, nguoiDungId: actorId, noiDungJson, kyTu, kyDen }, actorId);
  await repo.audit('bao_cao', id, 'CREATE', null, { ma_bao_cao: maBaoCao, ten_bao_cao: tenBaoCao }, actorId);
  return getReport(id);
}

// Chỉ chủ sở hữu hoặc admin ('*') mới sửa/xóa được.
function assertCanEdit(rep, user) {
  const isAdmin = (user.permissions || []).includes('*');
  if (rep.nguoi_dung_id !== user.id && !isAdmin) {
    throw new AppError('Chỉ chủ sở hữu báo cáo mới được chỉnh sửa', { status: 403, errorCode: 'FORBIDDEN' });
  }
}

async function updateReport(id, body, user) {
  const rep = await getReport(id);
  assertCanEdit(rep, user);
  await repo.update(id, body, user.id);
  await repo.audit('bao_cao', id, 'UPDATE', null, { ten_bao_cao: body.tenBaoCao ?? rep.ten_bao_cao }, user.id);
  return getReport(id);
}

async function undoReport(id, user) {
  const rep = await getReport(id);
  assertCanEdit(rep, user);
  const ok = await repo.undo(id, user.id);
  if (!ok) throw new AppError('Không có phiên bản trước để hoàn tác', { status: 409, errorCode: 'NO_UNDO' });
  await repo.audit('bao_cao', id, 'HOAN_TAC', null, null, user.id);
  return getReport(id);
}

async function deleteReport(id, user) {
  const rep = await getReport(id);
  assertCanEdit(rep, user);
  await repo.softDelete(id, user.id);
  await repo.audit('bao_cao', id, 'XOA', { ma_bao_cao: rep.ma_bao_cao }, null, user.id);
  return { id };
}

// Tính giá trị báo cáo (metric + công thức). Mỗi metric tự mang mốc thời gian → giá trị realtime.
async function renderContent(rep) {
  const noiDung = rep.noi_dung_json || {};
  const cells = noiDung.o || {};
  const usedMetrics = Object.values(cells)
    .filter((c) => c && c.loai === 'metric' && c.metric)
    .map((c) => c.metric);
  const metricValues = await metrics.compute(usedMetrics);
  const ketQua = evaluateGrid(cells, metricValues);
  return {
    id: rep.id, ma_bao_cao: rep.ma_bao_cao, ten_bao_cao: rep.ten_bao_cao,
    so_cot: noiDung.so_cot || 8, so_hang: noiDung.so_hang || 20,
    o: cells, merges: noiDung.merges || [], dinh_dang: noiDung.dinh_dang || {},
    ket_qua: ketQua, metric_values: metricValues,
    tinh_luc: new Date().toISOString(),
  };
}

async function renderReport(id, { noiDung } = {}) {
  const rep = await getReport(id);
  // Cho phép xem trước layout CHƯA lưu (noiDung gửi từ FE) mà không ghi DB.
  if (noiDung && typeof noiDung === 'object') rep.noi_dung_json = noiDung;
  return renderContent(rep);
}

async function history(id, date) {
  const d = date || new Date().toISOString().slice(0, 10);
  const rows = await repo.historyByDate(id, d);
  const MAP = { CREATE: 'Tạo báo cáo', UPDATE: 'Lưu chỉnh sửa', HOAN_TAC: 'Hoàn tác', XOA: 'Xóa' };
  return rows.map((r) => ({
    tg: r.tg, nguoi: r.nguoi || '—', hanh_dong: MAP[r.hanh_dong] || r.hanh_dong,
    chi_tiet: r.gia_tri_moi ? JSON.stringify(r.gia_tri_moi) : '',
  }));
}

// ---- Phòng ban ----
async function listPhongBan() {
  const [apDung, choDuyet] = await Promise.all([repo.listPhongBanApDung(), repo.listChoDuyet()]);
  return { phong_ban: apDung, cho_duyet: choDuyet };
}

async function deXuat(phongBanId, { baoCaoId, ghiChu }, actorId) {
  if (!baoCaoId) throw new AppError('Chưa chọn báo cáo', { status: 422, errorCode: 'VALIDATION' });
  await getReport(baoCaoId); // đảm bảo báo cáo tồn tại
  const id = await repo.createDeXuat({ phongBanId, baoCaoId, ghiChu }, actorId);
  await repo.audit('bao_cao_phong_ban', id, 'DE_XUAT', null, { phong_ban_id: phongBanId, bao_cao_id: baoCaoId }, actorId);
  return { id };
}

async function duyetDeXuat(id, actorId) {
  const dx = await repo.getDeXuat(id);
  if (!dx) throw new AppError('Đề xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (dx.trang_thai !== 'CHO_DUYET') throw new AppError('Đề xuất đã được xử lý', { status: 409, errorCode: 'PROCESSED' });
  await repo.duyet(id, actorId);
  await repo.audit('bao_cao_phong_ban', id, 'DUYET', null, { phong_ban_id: dx.phong_ban_id, bao_cao_id: dx.bao_cao_id }, actorId);
  return { id };
}

async function tuChoiDeXuat(id, lyDo, actorId) {
  const dx = await repo.getDeXuat(id);
  if (!dx) throw new AppError('Đề xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (dx.trang_thai !== 'CHO_DUYET') throw new AppError('Đề xuất đã được xử lý', { status: 409, errorCode: 'PROCESSED' });
  await repo.tuChoi(id, lyDo, actorId);
  await repo.audit('bao_cao_phong_ban', id, 'TU_CHOI', null, { ly_do: lyDo || null }, actorId);
  return { id };
}

async function hienHanhPhongBan(phongBanId) {
  const rep = await repo.hienHanh(phongBanId);
  if (!rep) return null;
  return renderContent(rep);
}

// Gỡ báo cáo hiện hành khỏi phòng ban.
async function huyApDungPhongBan(phongBanId, actorId) {
  const n = await repo.huyApDung(phongBanId, actorId);
  if (n === 0) throw new AppError('Phòng ban chưa có báo cáo áp dụng', { status: 409, errorCode: 'NO_APPLIED' });
  await repo.audit('bao_cao_phong_ban', phongBanId, 'HUY_AP_DUNG', null, { phong_ban_id: phongBanId }, actorId);
  return { phong_ban_id: phongBanId };
}

module.exports = {
  listMetrics, listReports, getReport, createReport, updateReport, undoReport, deleteReport,
  renderReport, history, listPhongBan, deXuat, duyetDeXuat, tuChoiDeXuat, hienHanhPhongBan, huyApDungPhongBan,
};
