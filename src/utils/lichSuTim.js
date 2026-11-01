'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SIDEBAR LỊCH SỬ: THEO NGÀY HOẶC TÌM MỌI NGÀY THEO MÃ (01/11/2026, người dùng báo: "tìm code phần phải chọn đúng
// ngày mới ra, clear ngày thì không thấy gì — không có ngày thì phải tìm theo code phần").
//   · có `date`                ⇒ như cũ: mọi lượt của ngày đó (ô tìm lọc ở FE).
//   · không `date`, có `q` ≥ 3 ⇒ tìm MỌI NGÀY: lượt có code phần / mã TDTHĐH (hoặc mã riêng của dòng: mã tem, mã
//                                lệnh, mã phiếu…) khớp `q`, tối đa `TOI_DA_TIM` lượt mới nhất.
//   · không cả hai             ⇒ hôm nay (hành vi cũ của mọi controller).
// Cùng 1 tham số SQL ($p) mang NGÀY hoặc MẪU TÌM (`mauTim`) ⇒ câu cũ chỉ đổi đúng điều kiện ngày.
// ⚠ Các mảnh dưới đây được nhúng vào câu `.replace(/\s+/g,' ')` — KHÔNG đặt comment `--` bên trong.
// ─────────────────────────────────────────────────────────────────────────────
const { mauTim } = require('./timKiem');
const { ngayHomNayVN } = require('./khoangNgay');

const TOI_DA_TIM = 500;
const TU_KHOA_TOI_THIEU = 3;
const VN = "AT TIME ZONE 'Asia/Ho_Chi_Minh'";

// Đọc `?date` + `?q` của request ⇒ { date, tim } (đúng 1 trong 2 có giá trị).
function thamSoLichSu(qs = {}) {
  const date = String(qs.date || '').trim();
  if (date) return { date, tim: null };
  const q = String(qs.q || '').trim();
  if (q.length >= TU_KHOA_TOI_THIEU) return { date: null, tim: mauTim(q) };
  return { date: ngayHomNayVN(), tim: null };
}

// Nhận cả chuỗi ngày cũ (service gọi kiểu cũ) lẫn object { date, tim }.
const chuan = (ls) => (ls && typeof ls === 'object' ? ls : { date: ls || ngayHomNayVN(), tim: null });
const giaTri = (ls) => (ls.date ? ls.date : ls.tim);
const gioiHan = (ls) => (ls.date ? '' : ` LIMIT ${TOI_DA_TIM}`);

// Phần in khớp mẫu (code phần hoặc mã TDTHĐH — danh sách mã ngăn dấu phẩy nên khớp CHỨA là đủ).
const phanInKhop = (pinIdCol, p) =>
  `${pinIdCol} IN (SELECT pk.id FROM phan_in pk WHERE pk.ma_phan ~* ${p} OR pk.barcode ~* ${p})`;
// Lệnh có ÍT NHẤT 1 phần in khớp (lệnh gom set khớp khi bất kỳ phần in nào khớp).
const lenhKhop = (lenhCol, p) =>
  `${lenhCol} IN (SELECT lk.lenh_san_xuat_id FROM lenh_sx_dot_vai lk JOIN dot_vai_ve dk ON dk.id = lk.dot_vai_ve_id WHERE ${phanInKhop('dk.phan_in_id', p)})`;
// Tem khớp: chính mã tem, hoặc phần in của lệnh (qua phiếu), hoặc đợt vải gắn thẳng tem (tem gia công 13).
const temKhop = (t, p) =>
  `(${t}.ma_tem ~* ${p} OR ${t}.phieu_san_xuat_id IN (SELECT pp.id FROM phieu_san_xuat pp WHERE ${lenhKhop('pp.lenh_san_xuat_id', p)}) OR ${t}.dot_vai_ve_id IN (SELECT dt.id FROM dot_vai_ve dt WHERE ${phanInKhop('dt.phan_in_id', p)}))`;

// Điều kiện thay cho "(cột thời gian giờ VN)::date = $p::date".
const ngayHoacTim = (ls, cotTg, p, khop) => (ls.date ? `(${cotTg} ${VN})::date = ${p}::date` : `(${khop})`);

// Danh sách code phần của 1 lệnh — để dòng lịch sử mang code phần (ô tìm FE quét được).
const maPhanLenhSql = (lenhCol) =>
  `(SELECT string_agg(DISTINCT pm.ma_phan, ', ') FROM lenh_sx_dot_vai lm JOIN dot_vai_ve dm ON dm.id = lm.dot_vai_ve_id JOIN phan_in pm ON pm.id = dm.phan_in_id WHERE lm.lenh_san_xuat_id = ${lenhCol})`;
// Code phần của 1 tem (qua phiếu → lệnh; tem gia công qua đợt vải).
const maPhanTemSql = (t) =>
  `COALESCE((SELECT ${maPhanLenhSql('pt.lenh_san_xuat_id')} FROM phieu_san_xuat pt WHERE pt.id = ${t}.phieu_san_xuat_id), (SELECT pd.ma_phan FROM dot_vai_ve dd JOIN phan_in pd ON pd.id = dd.phan_in_id WHERE dd.id = ${t}.dot_vai_ve_id))`;

module.exports = {
  TOI_DA_TIM, TU_KHOA_TOI_THIEU, thamSoLichSu, chuan, giaTri, gioiHan,
  phanInKhop, lenhKhop, temKhop, ngayHoacTim, maPhanLenhSql, maPhanTemSql,
};
