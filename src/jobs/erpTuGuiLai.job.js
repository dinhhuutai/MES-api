'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// HÀNG ĐỢI TỰ GỬI LẠI LƯỢT GỬI ERP BỊ LỖI (06/11/2026, người dùng: "lỗi gửi qua ERP còn rất nhiều, tem nào lỗi thì cho
//   vào hàng đợi gửi lại, gửi đến lần thứ 5"). Đo prod 06/11 (30 ngày, IDMES mà lần gửi mới nhất lỗi): in tem 28 ·
//   kiểm phẩm 14 · OQC 92 · sửa đạt 4 · phiếu giao 3 — phần lớn là TIMEOUT 10 s / DEADLOCK bên ERP (gửi lại là qua);
//   còn lại là lỗi trong proc ERP (OQC `Invalid object name 'SX_PhieukiemhangCTBo'`, PK/FK, chuỗi quá dài) — gửi lại
//   không tự hết nhưng giới hạn số lần nên vô hại.
//
// Cách chạy (mỗi `env.erp.tuGuiLaiPhut` phút, 1 lượt / lúc — lượt trước chưa xong thì bỏ lượt này):
//   1. 1 câu quét `audit_log` lấy mọi IDMES của các kênh tem (`KENH`) mà lần gửi MỚI NHẤT lỗi, trong N ngày
//      (`caidatapi.repository.hangDoiTuGuiLai`).
//   2. Lượt được gửi lại khi: tổng số lần gửi < `tuGuiLaiToiDa` (5 — tính cả lần gửi đầu + "Gửi lại" bằng tay), số lần
//      hàng đợi đã xử lý < 4, đã qua thời gian giãn cách kể từ lần gửi mới nhất (`GIAN_CACH_PHUT`), API của kênh đang
//      BẬT, chưa bị đánh dấu bỏ qua.
//   3. Gửi bằng CHÍNH `caidatapi/guiLai.guiLai` (= nút "Gửi lại ERP": dựng lại từ dữ liệu MES, giữ IDMES + ngày CT ⇒
//      proc ERP ghi đè theo IDMES, không đẻ phiếu 2), thay mặt NGƯỜI GỬI ĐẦU (`nhanvien`/`user` của ERP giữ đúng người),
//      TUẦN TỰ từng lượt; dòng lịch sử mới mang `tu_gui_lai.lan` (`erpApiLog.chayTuGuiLai`).
//   4. Mỗi lần xử lý ghi 1 vết `TU_GUI_LAI_ERP` (`ten_bang='erp_tu_gui_lai'`, `id_ban_ghi` = `<mã API>|<IDMES>`).
//      Lỗi do DỮ LIỆU MES (409/404/422 — vd lượt KCS đã hủy xác nhận, phiếu giao đã hủy, tem chưa có mã ERP) ⇒ vết có
//      `bo_qua` ⇒ không thử lại lượt đó (tới khi có lần gửi mới hơn).
// ⚠⚠ KHÔNG GỬI LẠI BẢN GHI ĐÃ HỦY Ở MES: IDMES đã từng được báo hủy (`ERP_GUI_HUY_IDMES`) hoặc tem đã HỦY (kênh gắn
//   tem) ⇒ bỏ qua — gửi lại là dựng lại phiếu ERP mà MES đã hủy. Lượt KCS / Sửa / OQC đã hủy xác nhận, phiếu giao HUY
//   do chính `guiLai` chặn (409 ⇒ bỏ qua).
// ⚠ CHỈ 1 MÁY CHẠY: mặc định chỉ chạy khi PGHOST là chính máy này (backend production nối DB qua 127.0.0.1) — máy dev
//   trỏ DB production từ xa mà cũng chạy là 2 máy cùng gửi 1 IDMES song song (đúng ca "ERP ra 2 phiếu", `erpThuLai`).
// ─────────────────────────────────────────────────────────────────────────────

const env = require('../config/env');
const repo = require('../modules/caidatapi/caidatapi.repository');
const { apiBat } = require('../utils/caiDatApi');
const { chayTuGuiLai } = require('../utils/erpApiLog');

// Kênh đưa vào hàng đợi — các kênh đẩy dữ liệu theo TEM (gửi lại theo IDMES là ghi đè). Release 1 / hủy vải / báo hủy
//   không đưa vào (không phải dữ liệu tem; gửi lại thân cũ của kế hoạch đã bị thay là sai).
const KENH = ['ERP_GHI_IN_TEM', 'ERP_GUI_TEM_GIA_CONG', 'ERP_GUI_KIEM_PHAM', 'ERP_GUI_SUA_DAT', 'ERP_GUI_OQC',
  'ERP_GUI_PHAN_LOAI_LOI', 'ERP_GUI_PHIEU_GIAO'];
const KENH_GAN_TEM = new Set(['ERP_GHI_IN_TEM', 'ERP_GUI_TEM_GIA_CONG', 'ERP_GUI_PHAN_LOAI_LOI']); // `id_ban_ghi` = tem
// Giãn cách trước lần gửi thứ (n + 1), theo số lần đã gửi n: 1 → 2 phút · 2 → 5 · 3 → 15 · ≥ 4 → 30.
const GIAN_CACH_PHUT = [2, 5, 15, 30];
const gianCach = (soLanGui) => GIAN_CACH_PHUT[Math.min(Math.max(soLanGui, 1), GIAN_CACH_PHUT.length) - 1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Máy này có được chạy job không (xem đầu file).
function duocChayTrenMayNay() {
  if (env.erp.tuGuiLaiJob === 'true') return { chay: true, ly_do: 'ERP_TU_GUI_LAI_JOB=true' };
  if (env.erp.tuGuiLaiJob === 'false') return { chay: false, ly_do: 'ERP_TU_GUI_LAI_JOB=false' };
  const h = String(env.db.host || '').toLowerCase();
  const cucBo = ['localhost', '127.0.0.1', '::1'].includes(h);
  return cucBo
    ? { chay: true, ly_do: `PGHOST=${h} (máy chủ)` }
    : { chay: false, ly_do: `PGHOST=${h} là máy khác — đặt ERP_TU_GUI_LAI_JOB=true nếu đây đúng là máy chủ` };
}

// Trạng thái lượt chạy gần nhất (RAM) — trang Cài đặt API đọc qua `trangThai()`.
const tt = { chay_tren_may: null, ly_do_may: null, dang_chay: false, lan_cuoi: null };

// Lý do bỏ qua của 1 lỗi từ `guiLai`: lỗi do dữ liệu MES (gửi lại bao nhiêu lần cũng thế) ⇒ mã lỗi; còn lại ⇒ null.
// Mã 409 mà nguyên nhân là ERP / cấu hình TẠM THỜI (không phải dữ liệu của lượt): API tắt giữa chừng · phiếu giao chưa xin
//   được ID ERP (`delivery.guiLaiErp`) · ERP cấp số trùng ⇒ thử lại chu kỳ sau như lỗi thường.
const LOI_TAM_THOI = new Set(['API_DANG_TAT', 'CHUA_CO_ID', 'TRUNG_ID']);
function lyDoBoQua(e) {
  const st = e && (e.status || e.statusCode);
  if (!st || st >= 500) return null;               // 502 ERP_LOI / lỗi lạ ⇒ tính 1 lần gửi, thử tiếp lần sau
  if (LOI_TAM_THOI.has(e.errorCode)) return null;
  return `${e.errorCode || st}: ${String(e.message || '').slice(0, 200)}`;
}

async function chayMotLuot() {
  const bd = Date.now();
  const kq = { tg: new Date().toISOString(), dang_loi: 0, da_gui: 0, thanh_cong: 0, con_loi: 0, bo_qua_moi: 0,
    het_luot: 0, cho_gian_cach: 0, da_bo_qua: 0, api_tat: 0, con_trong_hang: 0, ms: 0 };
  const toiDa = env.erp.tuGuiLaiToiDa;
  const ds = await repo.hangDoiTuGuiLai({ dsMa: KENH, soNgay: env.erp.tuGuiLaiSoNgay });
  kq.dang_loi = ds.length;
  if (!ds.length) { kq.ms = Date.now() - bd; return kq; }

  const bat = {};
  for (const ma of KENH) bat[ma] = await apiBat(ma); // eslint-disable-line no-await-in-loop
  const now = Date.now();
  const sanSang = [];
  for (const r of ds) {
    if (r.so_lan_gui >= toiDa || r.so_tu >= toiDa - 1) kq.het_luot += 1;
    else if (r.bo_qua) kq.da_bo_qua += 1;
    else if (!bat[r.ma]) kq.api_tat += 1;
    else if (now - new Date(r.thoi_gian).getTime() < gianCach(r.so_lan_gui) * 60000) kq.cho_gian_cach += 1;
    else sanSang.push(r);
  }
  // Ít lần gửi trước (lỗi mới phát sinh không phải xếp sau lượt đã gửi 4 lần), cùng số lần thì lượt mới hơn trước.
  sanSang.sort((a, b) => (a.so_lan_gui - b.so_lan_gui) || (new Date(b.thoi_gian) - new Date(a.thoi_gian)));
  const lam = sanSang.slice(0, env.erp.tuGuiLaiMoiLuot);
  kq.con_trong_hang = sanSang.length - lam.length;
  if (!lam.length) { kq.ms = Date.now() - bd; return kq; }

  const [daHuy, temHuy] = await Promise.all([
    repo.idMesDaBaoHuy(),
    repo.temDaHuy(lam.filter((r) => KENH_GAN_TEM.has(r.ma)).map((r) => r.id_ban_ghi)),
  ]);
  const { guiLai } = require('../modules/caidatapi/guiLai'); // nạp lười: guiLai kéo nhiều module nghiệp vụ
  for (const r of lam) {
    const lan = r.so_lan_gui + 1;
    const vet = { ma: r.ma, idm: r.idm, auditId: r.audit_id, lan };
    let boQua = null;
    if (daHuy.has(String(r.idm))) boQua = 'DA_BAO_HUY: IDMES đã được báo hủy sang ERP — bản ghi đã hủy ở MES';
    else if (KENH_GAN_TEM.has(r.ma) && temHuy.has(String(r.id_ban_ghi))) boQua = 'TEM_HUY: tem đã hủy ở MES';
    if (boQua) {
      kq.bo_qua_moi += 1;
      await repo.ghiTuGuiLai({ ...vet, ok: false, boQua: true, lyDo: boQua }).catch(() => {}); // eslint-disable-line no-await-in-loop
      continue; // eslint-disable-line no-continue
    }
    kq.da_gui += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      await chayTuGuiLai({ lan, toi_da: toiDa }, () => guiLai(r.ma, r.audit_id, r.nguoi_dau || null));
      kq.thanh_cong += 1;
      await repo.ghiTuGuiLai({ ...vet, ok: true }).catch(() => {}); // eslint-disable-line no-await-in-loop
    } catch (e) {
      const ly = lyDoBoQua(e);
      if (ly) kq.bo_qua_moi += 1; else kq.con_loi += 1;
      // eslint-disable-next-line no-await-in-loop
      await repo.ghiTuGuiLai({ ...vet, ok: false, boQua: !!ly, lyDo: ly, loi: String(e.message || e).slice(0, 300) })
        .catch(() => {});
    }
    await sleep(500); // eslint-disable-line no-await-in-loop
  }
  kq.ms = Date.now() - bd;
  return kq;
}

async function run() {
  if (tt.dang_chay) return; // lượt trước (nhiều timeout) chưa xong — không chạy chồng
  try {
    if (!(await apiBat('ERP_TU_GUI_LAI'))) { tt.lan_cuoi = { tg: new Date().toISOString(), tat: true }; return; }
    tt.dang_chay = true;
    const kq = await chayMotLuot();
    tt.lan_cuoi = kq;
    if (kq.da_gui || kq.bo_qua_moi) {
      console.log(`[erp-tu-gui-lai] gửi lại ${kq.da_gui} lượt: ${kq.thanh_cong} thành công · ${kq.con_loi} còn lỗi · `
        + `${kq.bo_qua_moi} bỏ qua (đã hủy ở MES / dữ liệu) · còn chờ ${kq.con_trong_hang + kq.cho_gian_cach} · `
        + `đủ ${env.erp.tuGuiLaiToiDa} lần ${kq.het_luot} (${Math.round(kq.ms / 1000)} s)`);
    }
  } catch (e) {
    tt.lan_cuoi = { tg: new Date().toISOString(), loi: e.message };
    console.error('[erp-tu-gui-lai] Lỗi lượt chạy:', e.message);
  } finally {
    tt.dang_chay = false;
  }
}

function startErpTuGuiLaiJob() {
  const may = duocChayTrenMayNay();
  tt.chay_tren_may = may.chay;
  tt.ly_do_may = may.ly_do;
  if (!may.chay) {
    console.log(`[erp-tu-gui-lai] KHÔNG chạy trên máy này — ${may.ly_do}`);
    return;
  }
  // Lượt đầu sau 2 phút (để job đồng bộ + server ổn định), rồi lặp.
  setTimeout(run, 120000);
  setInterval(run, env.erp.tuGuiLaiPhut * 60000);
  console.log(`[erp-tu-gui-lai] Job mỗi ${env.erp.tuGuiLaiPhut} phút — gửi lại tới lần ${env.erp.tuGuiLaiToiDa}, `
    + `xét ${env.erp.tuGuiLaiSoNgay} ngày, tối đa ${env.erp.tuGuiLaiMoiLuot} lượt / chu kỳ (${may.ly_do})`);
}

const trangThai = () => ({
  ...tt, phut: env.erp.tuGuiLaiPhut, toi_da: env.erp.tuGuiLaiToiDa, so_ngay: env.erp.tuGuiLaiSoNgay,
  moi_luot: env.erp.tuGuiLaiMoiLuot,
});

module.exports = {
  startErpTuGuiLaiJob, chayMotLuot, trangThai, KENH, GIAN_CACH_PHUT, gianCach, lyDoBoQua, duocChayTrenMayNay,
};
