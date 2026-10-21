'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// "SỬA & GỬI LẠI" Ở TỪNG DÒNG *Hệ thống › Cài đặt API › Lịch sử* (21/10/2026, người dùng yêu cầu: "chỗ gửi
// lại ERP, cho thêm chức năng sửa dữ liệu rồi gửi lại").
//
// Khác nút "Gửi lại ERP" (`guiLai.js` — DỰNG LẠI thân từ dữ liệu MES hiện tại): ở đây lấy ĐÚNG thân đã gửi của
// dòng lịch sử, người dùng sửa từng trường, rồi gửi NGUYÊN thân đã sửa sang đúng router của API đó.
//   · ⚠⚠ CHỈ ĐỔI THỨ GỬI SANG ERP — dữ liệu trong MES (tem, lượt KCS, phiếu giao…) KHÔNG đổi. Bấm "Gửi lại ERP"
//     thường sau đó là dựng lại từ MES ⇒ ghi đè phần đã sửa tay bên ERP.
//   · ⚠⚠ ID KẾT NỐI (IDMES / IDMes / IDKetNoi) KHÓA: proc ERP xóa phiếu cùng `Soctcu` (= IDMES) rồi tạo lại ⇒ giữ
//     IDMES là ghi đè đúng phiếu cũ; đổi IDMES là đẻ phiếu THỨ HAI bên ERP. Trường "gương" (vd `BarcodeSua17`
//     = `BarcodeIn`, `pID` = `IDPhieuGiao`) không sửa riêng — tự lấy theo trường nguồn.
//   · Kiểm kiểu + độ dài ĐÚNG tham số proc (cắt cụt im lặng là gửi sai dữ liệu mà người sửa không biết ⇒ BÁO
//     LỖI thay vì cắt); ngày giờ đổi về đúng dạng của kênh (`Z` / `VN` — xem `utils/erpNgayGio.js`).
//   · Lý do BẮT BUỘC. Dòng lịch sử mới mang `sua_tay: { ly_do, tu_dong, doi }` (`erpApiLog`) — người sửa =
//     người thực hiện của dòng.
//   · Đi qua `erpApiChung.goiErp` (công tắc API · retry · ghi Lịch sử) như mọi API đẩy khác.
// ─────────────────────────────────────────────────────────────────────────────

const env = require('../../config/env');
const AppError = require('../../utils/AppError');
const { goiErp } = require('../../utils/erpApiChung');
const { ngayGioErp } = require('../../utils/erpNgayGio');
const { KENH: KENH_20, THU_TU_TRUONG, DAI_TOI_DA, laMaTemErp } = require('../../utils/erpGhiInTem');
const { API_HUY, LY_DO_TOI_DA } = require('../../utils/erpHuy');
const { docDong, loiNeu, MA_GUI_LAI } = require('./guiLai');
const { maNgayCaHopLe, NGAY_CA_SAI } = require('../../utils/ca');

const LY_DO_SUA_TOI_DA = 300;
const MA_ERP = /^\d{12}$/;
const tachDs = (s) => String(s == null ? '' : s).split(',').map((x) => x.trim());

// ─── KHAI BÁO TỪNG KÊNH ──────────────────────────────────────────────────────
//   truong  : các trường của thân, ĐÚNG thứ tự hiện (trường cũ ngoài danh sách vẫn hiện, nhưng khóa)
//   so      : trường số nguyên · ngay: trường ngày giờ (thiếu ⇒ null) · kieuNgay: 'Z' | 'VN'
//   dai     : độ dài tối đa (= nvarchar của proc) · khoa: không cho sửa · guong: { trường: trường nguồn }
//   maTem   : trường phải là mã tem ERP cấp (12 số) · batBuoc: thân cũ phải có mới sửa được
//   kiem    : kiểm thêm cả thân (trả câu lỗi theo trường) · maHien: mã hiện ở cột "Mã" của Lịch sử
const SO_20 = ['IDMES', 'DDHsubID', 'inbosung', 'Soluong', 'Soluongloi', 'SOLUONGTHIEU'];

function kenh20(ma, them = {}) {
  const k = KENH_20[ma];
  return {
    nhan: k.nhan, url: k.url, timeoutMs: k.timeoutMs, retry: k.retry,
    truong: [...THU_TU_TRUONG, ...(them.truong || [])],
    so: SO_20, ngay: ['Ngayct', 'Tugio', 'Dengio'], kieuNgay: k.kieuNgay || 'Z',
    dai: { ...DAI_TOI_DA, ...(them.dai || {}) },
    khoa: ['IDMES'], guong: them.guong || {}, maTem: ['BarcodeIn'],
    // Sửa `Ngayca` phải đúng dạng mã ngày ca như ô In tem (21/10/2026, `utils/ca.js maNgayCaHopLe`).
    kiemTruong: { Ngayca: (s) => (maNgayCaHopLe(s) ? '' : NGAY_CA_SAI) },
    batBuoc: ['IDMES', 'BarcodeIn'],
    maHien: (b) => b.BarcodeIn,
  };
}

function kiemDsRelease(b) {
  const { SO_TRUONG } = require('../planning/release1Erp');
  const p = tachDs(b.DsRelease);
  if (!b.DsRelease || p.length % SO_TRUONG !== 0) {
    return { DsRelease: `Mỗi bản ghi phải đủ ${SO_TRUONG} trường ngăn dấu phẩy (đang có ${b.DsRelease ? p.length : 0} giá trị)` };
  }
  for (let i = 0; i < p.length; i += SO_TRUONG) {
    if (!p[i]) return { DsRelease: `Bản ghi thứ ${i / SO_TRUONG + 1} thiếu mã lệnh` };
  }
  return null;
}

const KENH = {
  ERP_GHI_IN_TEM: kenh20('ERP_GHI_IN_TEM'),
  ERP_GUI_KIEM_PHAM: kenh20('ERP_GUI_KIEM_PHAM'),
  ERP_GUI_TEM_GIA_CONG: kenh20('ERP_GUI_TEM_GIA_CONG'),
  ERP_GUI_SUA_DAT: kenh20('ERP_GUI_SUA_DAT', {
    truong: ['BarcodeSua16', 'BarcodeSua17', 'BarcodeSua'],
    dai: { BarcodeSua16: 20 },
    guong: { BarcodeSua17: 'BarcodeIn', BarcodeSua: 'BarcodeIn' },
  }),
  ERP_GUI_OQC: kenh20('ERP_GUI_OQC', { truong: ['BarcodeSua'], guong: { BarcodeSua: 'BarcodeIn' } }),
  ERP_GUI_PHIEU_GIAO: {
    nhan: 'gui-erp-phieu-giao', url: () => env.erp.guiPhieuGiaoUrl,
    timeoutMs: () => env.erp.guiPhieuGiaoTimeoutMs, retry: () => env.erp.guiPhieuGiaoRetry,
    truong: ['IDMES', 'IDPhieuGiao', 'Ngayct', 'user', 'DsTemGiao', 'ID', 'pID'],
    so: ['IDMES'], ngay: ['Ngayct'], kieuNgay: 'Z',
    dai: { IDPhieuGiao: 20, user: 20, DsTemGiao: 4000 },
    khoa: ['IDMES'], guong: { ID: 'IDPhieuGiao', pID: 'IDPhieuGiao' }, maTem: [],
    batBuoc: ['IDMES', 'IDPhieuGiao', 'DsTemGiao'],
    kiem: (b) => {
      const sai = tachDs(b.DsTemGiao).filter((m) => !MA_ERP.test(m));
      return sai.length ? { DsTemGiao: `Mã tem phải đủ 12 số ERP cấp, ngăn dấu phẩy — sai: ${sai.slice(0, 5).map((m) => `"${m}"`).join(', ')}` } : null;
    },
    maHien: (b) => b.IDPhieuGiao,
  },
  ERP_GUI_PHAN_LOAI_LOI: {
    nhan: 'gui-erp-phan-loai-loi', url: () => env.erp.guiPhanLoaiLoiUrl,
    timeoutMs: () => env.erp.guiPhanLoaiLoiTimeoutMs, retry: () => env.erp.guiPhanLoaiLoiRetry,
    truong: ['IDMes', 'Ngayct', 'nhanvien', 'Maquet', 'DsMaloi'],
    so: [], ngay: ['Ngayct'], kieuNgay: 'Z',
    dai: { IDMes: 20, nhanvien: 20, Maquet: 20, DsMaloi: 4000 },
    khoa: ['IDMes'], guong: {}, maTem: ['Maquet'],
    batBuoc: ['IDMes', 'Maquet', 'DsMaloi'],
    // Bộ ba `mã lỗi, SL sửa, SL hủy` (xem `erpApiChung.dsMaLoi`) — lệch 1 ô là ERP đọc sai MỌI bộ ba phía sau.
    kiem: (b) => {
      const p = tachDs(b.DsMaloi);
      if (!b.DsMaloi || p.length % 3 !== 0) return { DsMaloi: 'Phải là các bộ ba "mã lỗi,SL sửa,SL hủy" ngăn dấu phẩy' };
      for (let i = 0; i < p.length; i += 3) {
        if (!p[i] || !/^\d+$/.test(p[i + 1]) || !/^\d+$/.test(p[i + 2])) {
          return { DsMaloi: `Bộ ba thứ ${i / 3 + 1} sai ("${p.slice(i, i + 3).join(',')}") — cần mã lỗi + 2 số nguyên` };
        }
      }
      return null;
    },
    maHien: (b) => b.Maquet,
  },
  ERP_GUI_DS_HUY_VAI: {
    nhan: 'gui-ds-huy-vai', url: () => env.erp.guiDsHuyVaiUrl,
    timeoutMs: () => env.erp.guiDsHuyVaiTimeoutMs, retry: () => env.erp.guiDsHuyVaiRetry,
    truong: ['DsPhanDotVai', 'IDKetNoi'],
    so: [], ngay: [], kieuNgay: 'Z', dai: { DsPhanDotVai: 4000 },
    khoa: ['IDKetNoi'], guong: {}, maTem: [], batBuoc: ['DsPhanDotVai'],
    kiem: (b) => {
      const p = tachDs(b.DsPhanDotVai);
      return !b.DsPhanDotVai || p.length % 2 !== 0 || p.some((x) => !x)
        ? { DsPhanDotVai: 'Phải là các cặp "code phần,IDDotReady" ngăn dấu phẩy, không ô trống' } : null;
    },
    maHien: (b) => [...new Set(tachDs(b.DsPhanDotVai).filter((_, i) => i % 2 === 0))].join(', '),
  },
  ERP_GUI_RELEASE_1: {
    nhan: 'gui-erp-release-1', url: () => env.erp.guiRelease1Url,
    timeoutMs: () => env.erp.guiRelease1TimeoutMs, retry: () => env.erp.guiRelease1Retry,
    truong: ['IDMES', 'nhanvien', 'banin', 'Loaichuyen', 'Ngaykehoach', 'Tugio', 'Dengio', 'Inset', 'BarcodeHKT',
      'Pain', 'Ngayca', 'DsRelease', 'Nguon'],
    so: ['IDMES', 'Inset', 'Pain'], ngay: ['Ngaykehoach', 'Tugio', 'Dengio'], kieuNgay: 'VN',
    dai: { nhanvien: 20, banin: 20, Loaichuyen: 20, BarcodeHKT: 20, Ngayca: 20, DsRelease: 4000 },
    khoa: ['IDMES', 'Nguon'], guong: {}, maTem: [], batBuoc: ['IDMES', 'DsRelease'],
    kiem: kiemDsRelease,
    maHien: (b) => require('../planning/release1Erp').maLenhTuDs(b.DsRelease),
  },
};
for (const ma of Object.keys(API_HUY)) {
  const a = API_HUY[ma];
  KENH[ma] = {
    nhan: a.nhan, url: a.url, timeoutMs: a.timeoutMs, retry: a.retry,
    truong: ['IDMES', 'NgayHuy', 'NguoiHuy', 'Lydohuy', 'Nguon'],
    so: ['IDMES'], ngay: ['NgayHuy'], kieuNgay: 'Z',
    dai: { NguoiHuy: 20, Lydohuy: LY_DO_TOI_DA },
    khoa: ['IDMES', 'Nguon'], guong: {}, maTem: [], batBuoc: ['IDMES'],
    maHien: null, // giữ mã của dòng cũ (mã tem / số phiếu / mã lệnh của chứng từ bị hủy)
  };
}

// ─── ĐỌC DÒNG + DỰNG DANH SÁCH TRƯỜNG ───────────────────────────────────────
async function docKenhVaDong(ma, auditId) {
  if (!MA_GUI_LAI.has(ma) || !KENH[ma]) {
    throw new AppError('API này không sửa & gửi lại được', { status: 400, errorCode: 'KHONG_GUI_LAI' });
  }
  const d = await docDong(ma, auditId);
  if (!d) throw new AppError('Không tìm thấy dòng lịch sử', { status: 404, errorCode: 'NOT_FOUND' });
  const g = d.gia_tri_moi || {};
  const cu = g.gui || g.payload;
  const k = KENH[ma];
  const thieu = cu && typeof cu === 'object' ? k.batBuoc.filter((t) => cu[t] == null || cu[t] === '') : k.batBuoc;
  if (thieu.length) {
    // Vd dòng "chưa gửi" (phiếu chưa có ID ERP, tem chưa có mã ERP) chỉ lưu 1 trường — không có thân để sửa.
    throw new AppError(`Dòng lịch sử không có đủ dữ liệu đã gửi (thiếu ${thieu.join(', ')}) — dùng nút "Gửi lại ERP"`,
      { status: 409, errorCode: 'DONG_THIEU_DU_LIEU' });
  }
  return { k, d, g, cu };
}

const kieuCua = (k, t) => (k.so.includes(t) ? 'so' : k.ngay.includes(t) ? 'ngay' : 'chuoi');

function danhSachTruong(k, cu) {
  const ds = [...k.truong, ...Object.keys(cu).filter((t) => !k.truong.includes(t))];
  return ds.map((t) => ({
    truong: t,
    gia_tri: cu[t] === undefined ? null : cu[t],
    co_san: Object.prototype.hasOwnProperty.call(cu, t),
    kieu: kieuCua(k, t),
    dai: k.dai[t] || null,
    khoa: k.khoa.includes(t) || !k.truong.includes(t),
    guong: k.guong[t] || null,
    ma_tem: k.maTem.includes(t),
  }));
}

async function xemSua(ma, auditId) {
  const { k, d, cu } = await docKenhVaDong(ma, auditId);
  return { audit_id: d.id, kieu_ngay: k.kieuNgay, truong: danhSachTruong(k, cu) };
}

// ─── KIỂM + CHUẨN HÓA 1 GIÁ TRỊ ─────────────────────────────────────────────
const MAU_NGAY = { Z: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/, VN: /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/ };
function ngayHopLe(s) {
  const [y, mo, d, h, mi, se] = s.match(/\d+/g).map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && h < 24 && mi < 60 && se < 60;
}

function chuanGiaTri(k, t, v) {
  const kieu = kieuCua(k, t);
  if (kieu === 'ngay') {
    const s = ngayGioErp(v, k.kieuNgay);
    if (s == null) return { gt: null };
    if (!MAU_NGAY[k.kieuNgay].test(s) || !ngayHopLe(s)) {
      return { loi: k.kieuNgay === 'VN' ? 'Ngày giờ sai — nhập dạng 2026/10/21 08:30:00' : 'Ngày giờ sai — nhập dạng 2026-10-21 08:30:00' };
    }
    return { gt: s };
  }
  if (kieu === 'so') {
    const s = String(v == null ? '' : v).trim();
    if (!/^-?\d+$/.test(s)) return { loi: 'Phải là số nguyên' };
    const n = Number(s);
    if (!Number.isSafeInteger(n)) return { loi: 'Số quá lớn' };
    return { gt: n };
  }
  const s = v == null ? '' : String(v).trim();
  if (k.dai[t] && s.length > k.dai[t]) return { loi: `Tối đa ${k.dai[t]} ký tự (đang ${s.length})` };
  const kt = k.kiemTruong && k.kiemTruong[t];
  if (kt && kt(s)) return { loi: kt(s) };
  return { gt: s };
}

const giongNhau = (a, b) => (a == null ? null : a) === (b == null ? null : b)
  || (a != null && b != null && String(a) === String(b));

// Dựng thân MỚI từ thân cũ + các trường người dùng gửi. Trả { moi, doi } hoặc ném 422 kèm lỗi theo trường.
function dungThanMoi(k, cu, sua) {
  if (!sua || typeof sua !== 'object' || Array.isArray(sua)) {
    throw new AppError('Thiếu dữ liệu sửa', { status: 422, errorCode: 'THIEU_DU_LIEU' });
  }
  const moi = { ...cu };
  const doi = {};
  const loi = [];
  const duocSua = new Set(k.truong.filter((t) => !k.khoa.includes(t) && !k.guong[t]));
  for (const [t, v] of Object.entries(sua)) {
    if (!duocSua.has(t)) {
      // Trường khóa / gương / lạ: chỉ chấp nhận khi giữ NGUYÊN giá trị cũ (FE gửi cả thân là chuyện bình thường).
      if (giongNhau(v, cu[t]) || k.guong[t]) continue;
      loi.push({ truong: t, loi: k.khoa.includes(t) ? 'Trường này không sửa được (ID kết nối / nội bộ)' : 'Trường không thuộc API này' });
      continue;
    }
    const r = chuanGiaTri(k, t, v);
    if (r.loi) { loi.push({ truong: t, loi: r.loi }); continue; }
    if (!giongNhau(r.gt, cu[t]) || !Object.prototype.hasOwnProperty.call(cu, t)) {
      moi[t] = r.gt;
      if (!giongNhau(r.gt, cu[t])) doi[t] = { cu: cu[t] === undefined ? null : cu[t], moi: r.gt };
    }
  }
  for (const [t, nguon] of Object.entries(k.guong)) {
    if (Object.prototype.hasOwnProperty.call(moi, t) || Object.prototype.hasOwnProperty.call(doi, nguon)) moi[t] = moi[nguon];
  }
  for (const t of k.maTem) {
    if (!laMaTemErp(moi[t])) loi.push({ truong: t, loi: 'Phải là mã tem ERP cấp (đủ 12 số)' });
  }
  if (!loi.length && k.kiem) {
    const l = k.kiem(moi);
    if (l) for (const [t, m] of Object.entries(l)) loi.push({ truong: t, loi: m });
  }
  if (loi.length) {
    throw new AppError(`Dữ liệu sửa chưa hợp lệ: ${loi.map((x) => `${x.truong} — ${x.loi}`).join(' · ')}`,
      { status: 422, errorCode: 'DU_LIEU_SAI', details: loi });
  }
  if (!Object.keys(doi).length) {
    throw new AppError('Chưa sửa trường nào — muốn gửi lại như cũ thì dùng nút "Gửi lại ERP"', { status: 422, errorCode: 'KHONG_DOI' });
  }
  return { moi, doi };
}

// ─── GỬI ─────────────────────────────────────────────────────────────────────
async function suaGuiLai(ma, auditId, { gui, lyDo } = {}, actorId) {
  const ly = String(lyDo == null ? '' : lyDo).trim();
  if (!ly) throw new AppError('Phải nhập lý do sửa', { status: 422, errorCode: 'THIEU_LY_DO' });
  if (ly.length > LY_DO_SUA_TOI_DA) {
    throw new AppError(`Lý do tối đa ${LY_DO_SUA_TOI_DA} ký tự`, { status: 422, errorCode: 'LY_DO_QUA_DAI' });
  }
  const { k, d, g, cu } = await docKenhVaDong(ma, auditId);
  const { moi, doi } = dungThanMoi(k, cu, gui);
  const idBanGhi = d.id_ban_ghi && d.id_ban_ghi !== '-' ? d.id_ban_ghi : null;
  const maHien = (k.maHien && k.maHien(moi)) || g.ma_tem || null;
  const kq = await goiErp(ma, {
    nhan: k.nhan,
    url: k.url(),
    method: 'POST',
    body: moi,
    timeoutMs: k.timeoutMs(),
    retry: k.retry(),
    idBanGhi,
    maTem: maHien,
    // Giữ đúng ID kết nối của dòng cũ (dòng không có ID trong thân ⇒ lấy `id_mes` đã ghi).
    idKetNoi: g.id_mes != null && g.id_mes !== '' ? String(g.id_mes) : null,
    moTa: `sửa & gửi lại · ${Object.keys(doi).join(', ')}`,
    actorId,
    suaTay: { ly_do: ly, tu_dong: String(d.id), doi },
  });
  loiNeu(kq, ma);
  // Hủy đợt READY (trả về GN): thành công ⇒ lượt GN chuyển "ERP đã hủy" như nút "Gửi lại ERP".
  if (ma === 'ERP_GUI_DS_HUY_VAI' && idBanGhi) {
    await require('../suathongtin/gnErp').danhDauGuiLaiThanhCong(idBanGhi, kq.id_ket_noi, actorId);
  }
  return { ok: true, doi: Object.keys(doi) };
}

module.exports = { xemSua, suaGuiLai, KENH, _dungThanMoi: dungThanMoi };
