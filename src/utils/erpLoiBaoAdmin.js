'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// BÁO QUẢN TRỊ KHI GỬI ERP LỖI (19/11/2026, người dùng: "chỗ gửi dữ liệu sang ERP, khi gửi cả 3 lần mà bị lỗi thì thông báo
//   đến tài khoản admin những tem đó").
// Mỗi dòng Lịch sử API THẤT BẠI (`erpApiLog.ghiLog`, `thanhCong=false` — tức đã hết các lần thử trong lượt, `erpThuLai`) của
//   kênh ĐẨY dữ liệu ⇒ gom lại `GOM_MS` rồi gửi 1 thông báo chuông `ERP_GUI_LOI` cho vai trò ADMIN (`thongBaoHeThong`).
// ⚠ Chống ồn: mỗi (kênh, IDMES | bản ghi) chỉ báo 1 lần trong `NHO_MS` — hàng đợi tự gửi lại (`jobs/erpTuGuiLai`) thử lại lượt
//   lỗi nhiều lần trong ngày, báo mỗi lần là admin ngập thông báo. Nhớ trong RAM (khởi động lại máy chủ ⇒ có thể báo lại 1 lần).
// ⚠ KHÔNG BAO GIỜ NÉM LỖI — gọi từ `ghiLog` (nằm trong luồng in tem / KCS…).
// ─────────────────────────────────────────────────────────────────────────────

// Kênh đẩy dữ liệu sang ERP (không gồm API xin mã / kéo dữ liệu — lỗi ở đó người bấm thấy ngay trên màn).
const KENH_BAO = new Set([
  'ERP_GHI_IN_TEM', 'ERP_GUI_TEM_GIA_CONG', 'ERP_GUI_KIEM_PHAM', 'ERP_GUI_SUA_DAT', 'ERP_GUI_OQC', 'ERP_GUI_PHAN_LOAI_LOI',
  'ERP_GUI_PHIEU_GIAO', 'ERP_GUI_RELEASE_1', 'ERP_GUI_HUY_IDMES', 'ERP_GUI_HUY_RELEASE_1', 'ERP_GUI_DS_HUY_VAI',
]);
const GOM_MS = 60 * 1000;
const NHO_MS = 12 * 3600 * 1000;
const TOI_DA_DONG = 30;

const daBao = new Map(); // khóa → mốc đã báo
let cho = [];
let hen = null;

function tenApi(ma) {
  try { return (require('./caiDatApi').DANH_MUC_API.find((x) => x.ma === ma) || {}).ten || ma; } catch { return ma; }
}

/** Gọi từ `erpApiLog.ghiLog` với mọi lượt lỗi. */
function ghiNhan({ maApi, maTem, idMes, idBanGhi, loi, soLanThu }) {
  try {
    if (!KENH_BAO.has(maApi)) return;
    const khoa = `${maApi}|${idMes ?? idBanGhi ?? maTem ?? '-'}`;
    const bayGio = Date.now();
    for (const [k, t] of daBao) if (bayGio - t > NHO_MS) daBao.delete(k);
    if (daBao.has(khoa)) return;
    daBao.set(khoa, bayGio);
    cho.push({ maApi, maTem, idMes, loi: String(loi || 'không rõ').replace(/\s+/g, ' ').slice(0, 160), soLanThu });
    if (!hen) {
      hen = setTimeout(() => { hen = null; xa().catch(() => {}); }, GOM_MS);
      if (hen.unref) hen.unref();
    }
  } catch (e) { /* ghi vết không được làm hỏng luồng gửi */ }
}

async function xa() {
  const ds = cho;
  cho = [];
  if (!ds.length) return;
  const htb = require('./thongBaoHeThong');
  const admin = await htb.idQuanTri();
  if (!admin.length) return;
  const tem = [...new Set(ds.map((x) => x.maTem).filter(Boolean))];
  const dong = ds.slice(0, TOI_DA_DONG).map((x) => `• ${tenApi(x.maApi)} · ${x.maTem ? `tem ${x.maTem}` : 'không gắn tem'}`
    + `${x.idMes != null ? ` · IDMES ${x.idMes}` : ''}${x.soLanThu ? ` · thử ${x.soLanThu} lần` : ''} — ${x.loi}`);
  if (ds.length > TOI_DA_DONG) dong.push(`… và ${ds.length - TOI_DA_DONG} lượt khác (xem Cài đặt API › Lịch sử)`);
  await htb.gui({
    maLoai: 'ERP_GUI_LOI',
    userIds: admin,
    tieuDe: `Gửi ERP lỗi ${ds.length} lượt${tem.length ? ` · ${tem.length} tem` : ''}`,
    noiDung: `${dong.join('\n')}\nHệ thống vẫn tự gửi lại theo chu kỳ; lỗi mãi thì xem Lịch sử API và bấm "Gửi lại ERP".`,
    trang: '/he-thong/cai-dat-api',
    duLieu: { so_luot: ds.length, tem: tem.slice(0, 100), api: [...new Set(ds.map((x) => x.maApi))] },
  });
}

module.exports = { ghiNhan, KENH_BAO };
