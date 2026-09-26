'use strict';

const { withTransaction } = require('../../config/db');
const repo = require('./suathongtin.repository');
// Sửa trường phần in / đợt vải: TÁI DÙNG đúng đường ghi của *Quản trị phần in* (whitelist cột cứng,
// guard hạ SL vải dưới SL đã in, tính lại phương án in khi đổi loại/SL, audit). ⚠ Đừng viết UPDATE riêng.
const phanInAdmin = require('../phaninadmin/phaninadmin.service');
const { THONG_TIN_GN, TEN_THEO_MA } = require('../../utils/traVeGn');
const AppError = require('../../utils/AppError');
const sockets = require('../../sockets');

const NGUON_HOP_LE = { KT: 'READY Kỹ thuật', QC: 'QC chuẩn bị kỹ thuật' };
const ngayHopLe = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);

function danhMuc() {
  return { thong_tin: THONG_TIN_GN, nguon: NGUON_HOP_LE };
}

async function danhSach(q) {
  const trangThai = ['CHO', 'DA', ''].includes(q.trangThai) ? q.trangThai : 'CHO';
  return repo.danhSach({
    search: q.search || '', trangThai, tuNgay: ngayHopLe(q.tuNgay), denNgay: ngayHopLe(q.denNgay),
  });
}

async function chiTiet(phanInId) {
  const [ct, dangCho, lichSu] = await Promise.all([
    phanInAdmin.chiTiet(phanInId), repo.dangCho(phanInId), repo.lichSu(phanInId),
  ]);
  return { ...ct, tra_ve_dang_cho: dangCho, lich_su: lichSu };
}

// READY (Kỹ thuật / QC) trả phần in về GN.
// ⚠ Guard chạy TRƯỚC khi ghi: phần in phải còn hoạt động, chưa đang ở GN, và phải chọn ÍT NHẤT 1 mục
//   (hoặc gõ ô "Khác") — lý do rỗng thì GN không biết phải sửa gì.
async function traVe({ phanInId, thongTin, khac, nguon }, actorId) {
  const pin = await repo.getPhanInCoBan(phanInId);
  if (!pin) throw new AppError('Phần in không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (!pin.dang_hoat_dong) throw new AppError('Phần in đã bị hủy', { status: 409, errorCode: 'DA_HUY' });
  const ma = [...new Set((Array.isArray(thongTin) ? thongTin : []).map((x) => String(x).trim()))]
    .filter((x) => TEN_THEO_MA[x]);
  const khacSach = String(khac || '').trim().slice(0, 500);
  if (!ma.length && !khacSach) {
    throw new AppError('Chọn ít nhất 1 thông tin sai (hoặc ghi ở ô "Khác")', { status: 422, errorCode: 'NO_LY_DO' });
  }
  const nguonSach = NGUON_HOP_LE[nguon] ? nguon : 'KT';
  if ((await repo.dangCho(phanInId)).length) {
    throw new AppError(`Phần in ${pin.ma_phan} đang chờ Giao nhận sửa — không trả về lần nữa`,
      { status: 409, errorCode: 'DANG_O_GN' });
  }
  const ten = ma.map((x) => TEN_THEO_MA[x]);
  if (khacSach) ten.push(`Khác: ${khacSach}`);
  const lyDo = `Sai thông tin: ${ten.join(' · ')}`;

  const kq = await withTransaction(async (client) => {
    const r = await repo.insertTraVe(client, { phanInId, checklistList: ten.join(', '), lyDo }, actorId);
    await repo.ghiAudit(client, r.id, 'TRA_VE_GN',
      { phan_in_id: phanInId, ma_phan: pin.ma_phan, nguon: nguonSach, thong_tin: ma, khac: khacSach || null }, actorId);
    return r;
  });
  sockets.emit('ready:confirmed', { phanInId, tra_ve_gn: true });
  sockets.emit('gn:updated', { phanInId });
  return { id: kq.id, phan_in_id: phanInId, ma_phan: pin.ma_phan, ly_do: lyDo };
}

async function kiemDangO(phanInId) {
  if (!(await repo.dangCho(phanInId)).length) {
    throw new AppError('Phần in không còn chờ Giao nhận sửa (đã xác nhận lại)', { status: 409, errorCode: 'KHONG_O_GN' });
  }
}

// ⚠ CHỈ cho sửa khi phần in ĐANG ở GN — trang này không phải cửa sau để sửa phần in bất kỳ
//   (việc đó thuộc *Quản trị phần in*, quyền PHAN_IN_ADMIN).
async function suaPhanIn(phanInId, patch, actorId) {
  await kiemDangO(phanInId);
  const r = await phanInAdmin.suaPhanIn(phanInId, patch, actorId);
  sockets.emit('gn:updated', { phanInId });
  return r;
}

async function suaDotVai(dotVaiId, patch, actorId) {
  const pinId = await repo.dotVaiThuocPhanIn(dotVaiId);
  if (!pinId) throw new AppError('Đợt vải không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  await kiemDangO(pinId);
  const r = await phanInAdmin.suaDotVai(dotVaiId, patch, actorId);
  sockets.emit('gn:updated', { phanInId: pinId });
  return r;
}

// GN xác nhận đã sửa xong ⇒ tắt cờ ⇒ phần in QUAY LẠI màn READY (listCandidates hết bị lọc).
async function xacNhanLai(phanInId, { ghiChu } = {}, actorId) {
  const pin = await repo.getPhanInCoBan(phanInId);
  if (!pin) throw new AppError('Phần in không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const ghiChuSach = String(ghiChu || '').trim().slice(0, 500) || null;
  const ids = await withTransaction(async (client) => {
    const xs = await repo.xuLyHet(client, phanInId, actorId);
    for (const id of xs) {
      await repo.ghiAudit(client, id, 'GN_XAC_NHAN_LAI', { phan_in_id: phanInId, ma_phan: pin.ma_phan, ghi_chu: ghiChuSach }, actorId);
    }
    return xs;
  });
  if (!ids.length) {
    throw new AppError('Phần in không còn chờ Giao nhận sửa (đã có người xác nhận lại)', { status: 409, errorCode: 'ALREADY' });
  }
  sockets.emit('ready:confirmed', { phanInId, gn_xac_nhan: true });
  sockets.emit('gn:updated', { phanInId });
  sockets.emit('dashboard:refresh', {});
  return { phan_in_id: phanInId, ma_phan: pin.ma_phan, so_luot: ids.length };
}

// Xác nhận lại NHIỀU phần in cùng lúc (tích checkbox đầu bảng). Mỗi phần in 1 transaction riêng ⇒ 1 phần
// lỗi (đã có người xác nhận trước) KHÔNG làm hỏng các phần còn lại; trả về danh sách lỗi để FE báo rõ.
async function xacNhanLaiNhieu({ phanInIds, ghiChu } = {}, actorId) {
  const ids = [...new Set((Array.isArray(phanInIds) ? phanInIds : []).map(String).filter(Boolean))];
  if (!ids.length) throw new AppError('Chưa chọn phần in nào', { status: 422, errorCode: 'NO_ITEMS' });
  if (ids.length > 500) throw new AppError('Tối đa 500 phần in mỗi lần', { status: 422, errorCode: 'QUA_NHIEU' });
  const ok = []; const loi = [];
  for (const id of ids) {
    try { ok.push(await xacNhanLai(id, { ghiChu }, actorId)); } catch (e) { loi.push({ phan_in_id: id, loi: e.message }); }
  }
  return { so_ok: ok.length, items: ok, loi };
}

module.exports = { danhMuc, danhSach, chiTiet, traVe, suaPhanIn, suaDotVai, xacNhanLai, xacNhanLaiNhieu };
