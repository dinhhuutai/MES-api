'use strict';

const { withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const repo = require('./tinhchatin.repository');
const {
  LUONG, MA_LUONG, BO_QUA_MAC_DINH, BO_QUA_MAC_DINH_RAW, normTcin, luongTuCongDoan, congDoanCuaLuong, luongSxTheoPhanLoai,
  coCongDoanEp, khongInRoiEp, epThanhLogo,
} = require('../../utils/tinhChatIn');
const { xoaNho: xoaNhoLuong } = require('../../utils/luongSanXuat');
// Chế độ READY của tính chất nhiều công đoạn (mig 131 — `utils/readyCongDoan.js`).
const { CHE_DO } = require('../../utils/readyCongDoan');
// Yêu cầu KT của công đoạn Ép/Logo (mig 133 — `utils/tech.js`).
const { KT_YC, KT_YC_MAC_DINH } = require('../../utils/tech');

// Luồng sản xuất của phần in ứng với 1 luồng phân loại (chưa phân loại ⇒ in thường).
const luongPhanIn = luongSxTheoPhanLoai;

// ─────────────────────────────────────────────────────────────────────────────
// Hệ thống › Tính chất in (mig 123). Luật + danh mục luồng: `utils/tinhChatIn.js`.
//   · Client gửi `cong_doan` `{ in, kieng, logo, ep }` (4 công tắc In · In kiếng · Logo · Ép — 16/11/2026 tách Logo khỏi Ép)
//              ⇒ server đổi ra mã `luong` (`luongTuCongDoan`); vẫn nhận `luong` trực tiếp cho bên gọi cũ.
//   · `luong`  — mig 126: đổi luồng 1 tính chất ⇒ áp cho phần in mang tính chất
//              đó mà CHƯA có lệnh sống và chưa sửa tay ở Quản trị phần in (`repo.apLuongChoPhanInTx`).
//   · `bo_qua` CÓ HIỆU LỰC: đồng bộ ERP đọc ở lượt kế tiếp ⇒ tắt = đợt mới vào MES, bật = đợt mới không vào nữa.
// ─────────────────────────────────────────────────────────────────────────────

const TEN_TOI_DA = 100;
const GHI_CHU_TOI_DA = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUA_MIG = () => new AppError('Chưa chạy migration 123 (bảng tinh_chat_in) nên chưa lưu được.', { status: 409, errorCode: 'CHUA_MIGRATION_123' });
const THU_TU = new Map(LUONG.map((l, i) => [l.ma, i]));

// Kiểm + chuẩn hóa 1 dòng từ client. Khóa `ma_chuan` tính lại ở server, không tin client.
function chuanDong(x) {
  const ten = String((x && x.ten) ?? '').trim().replace(/\s+/g, ' ');
  const ma = normTcin(ten);
  if (!ma || ten.length > TEN_TOI_DA) {
    throw new AppError(`Tên tính chất in không hợp lệ (bắt buộc, tối đa ${TEN_TOI_DA} ký tự)`, { status: 422, errorCode: 'TEN_SAI' });
  }
  let luong = x.cong_doan && typeof x.cong_doan === 'object' ? luongTuCongDoan(x.cong_doan) : x.luong;
  if (!MA_LUONG.has(luong)) {
    throw new AppError(`Luồng không hợp lệ ở tính chất "${ten}"`, { status: 422, errorCode: 'LUONG_SAI' });
  }
  // Dòng sản phẩm LOGO (mig 137, 18/11/2026): công tắc Ép ⇒ Logo; In + Logo được phép (`utils/tinhChatIn.js epThanhLogo`).
  const dspLogo = x.dsp_logo === true;
  if (dspLogo) luong = luongTuCongDoan(epThanhLogo(congDoanCuaLuong(luong)));
  // 17/11/2026: không có công đoạn In rồi Ép/Logo (`utils/tinhChatIn.js khongInRoiEp`) — trừ DSP logo (In + Logo).
  if (khongInRoiEp(congDoanCuaLuong(luong), dspLogo)) {
    throw new AppError(`Tính chất "${ten}": không có công đoạn In rồi Ép/Logo — bật In HOẶC Logo/Ép (kiếng ủi = In kiếng + Ép; `
      + 'In + Logo chỉ cho tính chất DSP Logo)', { status: 422, errorCode: 'KHONG_IN_ROI_EP' });
  }
  if (typeof x.bo_qua !== 'boolean') {
    throw new AppError(`Thiếu trạng thái bỏ qua ở tính chất "${ten}"`, { status: 422, errorCode: 'BO_QUA_SAI' });
  }
  const ghiChu = String(x.ghi_chu ?? '').trim();
  if (ghiChu.length > GHI_CHU_TOI_DA) {
    throw new AppError(`Ghi chú tối đa ${GHI_CHU_TOI_DA} ký tự`, { status: 422, errorCode: 'GHI_CHU_DAI' });
  }
  const cheDo = x.ready_che_do == null || x.ready_che_do === '' ? 'RIENG' : String(x.ready_che_do);
  if (!CHE_DO.includes(cheDo)) throw new AppError(`Chế độ READY không hợp lệ ở tính chất "${ten}"`, { status: 422, errorCode: 'CHE_DO_SAI' });
  // Yêu cầu KT của công đoạn Ép/Logo (mig 133, 16/11/2026) — chỉ có nghĩa khi tính chất có công đoạn Ép/Logo; còn lại
  //   luôn KHUON_MUC (luật chung).
  const ktYc = x.kt_yeu_cau == null || x.kt_yeu_cau === '' ? KT_YC_MAC_DINH : String(x.kt_yeu_cau);
  if (!KT_YC.includes(ktYc)) throw new AppError(`Yêu cầu kỹ thuật không hợp lệ ở tính chất "${ten}"`, { status: 422, errorCode: 'KT_YC_SAI' });
  const coEp = coCongDoanEp(congDoanCuaLuong(luong)); // Logo hoặc Ép
  // "Xác nhận HSKT" của công đoạn Ép/Logo (mig 134) — mặc định BẬT; chỉ có nghĩa khi tính chất có Ép/Logo.
  const ktHskt = x.kt_hskt == null ? true : !!x.kt_hskt;
  return { ma_chuan: ma, ten, luong, bo_qua: x.bo_qua, ghi_chu: ghiChu || null, ready_che_do: cheDo, kt_yeu_cau: coEp ? ktYc : KT_YC_MAC_DINH,
    kt_hskt: ktHskt, dsp_logo: dspLogo };
}

const giaTri = (r) => ({ ten: r.ten, luong: r.luong, bo_qua: r.bo_qua, ghi_chu: r.ghi_chu || null, ready_che_do: r.ready_che_do || 'RIENG',
  kt_yeu_cau: r.kt_yeu_cau || KT_YC_MAC_DINH, kt_hskt: r.kt_hskt !== false, dsp_logo: r.dsp_logo === true });
// Chưa có cột (chưa chạy mig 131) mà muốn đặt chế độ khác mặc định ⇒ 409 (đừng âm thầm bỏ qua).
async function kiemCheDo(ds) {
  if (ds.some((d) => d.ready_che_do !== 'RIENG') && !(await repo.coCotCheDo())) {
    throw new AppError('Chưa chạy migration 131 nên chưa lưu được chế độ READY', { status: 409, errorCode: 'CHUA_MIGRATION_131' });
  }
  if (ds.some((d) => d.kt_yeu_cau !== KT_YC_MAC_DINH) && !(await repo.coCotKtYc())) {
    throw new AppError('Chưa chạy migration 133 nên chưa lưu được yêu cầu kỹ thuật Ép/Logo', { status: 409, errorCode: 'CHUA_MIGRATION_133' });
  }
  if (ds.some((d) => d.dsp_logo) && !(await repo.coCotDspLogo())) {
    throw new AppError('Chưa chạy migration 137 nên chưa lưu được "DSP Logo"', { status: 409, errorCode: 'CHUA_MIGRATION_137' });
  }
}

// Danh mục + số liệu. Tính chất có trong dữ liệu mà chưa có trong danh mục ⇒ dòng `moi` (đồng bộ không bỏ qua nó).
async function danhSach() {
  const coBang = await repo.coBang();
  const [dm, pis, dots] = await Promise.all([coBang ? repo.danhMuc() : [], repo.demPhanIn(), repo.demDotErp()]);
  const m = new Map();
  const dat = (ma, ten, them) => {
    if (!m.has(ma)) m.set(ma, { id: null, ma_chuan: ma, ten, luong: 'CHUA_PHAN_LOAI', bo_qua: false, ghi_chu: null, ready_che_do: 'RIENG', kt_yeu_cau: KT_YC_MAC_DINH, kt_hskt: true, dsp_logo: false, moi: true, so_phan_in: 0, so_dot_erp: 0 });
    Object.assign(m.get(ma), them);
  };
  if (coBang) {
    dm.forEach((r) => dat(r.ma_chuan, r.ten, { ...r, moi: false }));
  } else {
    BO_QUA_MAC_DINH_RAW.forEach((ten) => dat(normTcin(ten), ten, { bo_qua: true, moi: false }));
  }
  pis.forEach((r) => dat(r.ma, r.ten, { so_phan_in: r.so_phan_in }));
  dots.forEach((r) => dat(r.ma, r.ten, { so_dot_erp: r.so_dot }));
  if (!coBang) m.forEach((v, ma) => { if (BO_QUA_MAC_DINH.has(ma)) v.bo_qua = true; });
  m.forEach((v) => { v.cong_doan = congDoanCuaLuong(v.luong); });

  const items = [...m.values()].sort((a, b) => (THU_TU.get(a.luong) ?? 99) - (THU_TU.get(b.luong) ?? 99)
    || b.so_phan_in - a.so_phan_in || b.so_dot_erp - a.so_dot_erp || a.ten.localeCompare(b.ten));
  return { items, luong: LUONG, chua_migration: !coBang, co_che_do_ready: coBang && (await repo.coCotCheDo()),
    co_kt_yeu_cau: coBang && (await repo.coCotKtYc()), kt_yeu_cau: KT_YC, co_kt_hskt: coBang && (await repo.coCotKtHskt()),
    co_dsp_logo: coBang && (await repo.coCotDspLogo()) };
}

// Lưu nhiều dòng 1 lượt. Chỉ ghi + ghi vết dòng THẬT SỰ đổi (giữ `updated_*` đúng người đã sửa).
async function luu(items, actorId) {
  if (!(await repo.coBang())) throw CHUA_MIG();
  const ds = (Array.isArray(items) ? items : []).map(chuanDong);
  if (!ds.length) throw new AppError('Không có dòng nào để lưu', { status: 422, errorCode: 'EMPTY' });
  await kiemCheDo(ds);
  const theoMa = new Map(ds.map((d) => [d.ma_chuan, d])); // trùng mã trong 1 lượt ⇒ dòng sau thắng
  let apPhanIn = 0; // số phần in đổi luồng sản xuất theo phân loại mới (mig 126)
  // Chưa chạy mig 134 ⇒ không so cột kt_hskt (giao diện khóa công tắc, giá trị đọc ra là false giả).
  const coHskt = await repo.coCotKtHskt();
  const coDsp = await repo.coCotDspLogo(); // mig 137 — chưa có cột ⇒ không so dsp_logo

  const soDoi = await withTransaction(async (client) => {
    const cu = new Map((await repo.docTheoMaTx(client, [...theoMa.keys()])).map((r) => [r.ma_chuan, r]));
    let n = 0;
    for (const d of theoMa.values()) {
      const c = cu.get(d.ma_chuan);
      if (!c) {
        const id = await repo.themTx(client, d, actorId);
        await repo.logTx(client, id, 'THEM_TINH_CHAT_IN', null, giaTri(d), actorId);
        // Dòng "Mới từ ERP" lần đầu vào danh mục: phần in đã có mang tính chất này cũng nhận luồng (trước đây bị sót).
        apPhanIn += await repo.apLuongChoPhanInTx(client, d.ma_chuan, luongPhanIn(d.luong));
        n += 1;
      } else if (!c.dang_hoat_dong || c.luong !== d.luong || c.bo_qua !== d.bo_qua || (c.ghi_chu || null) !== d.ghi_chu
                 || (c.ready_che_do || 'RIENG') !== d.ready_che_do || (c.kt_yeu_cau || KT_YC_MAC_DINH) !== d.kt_yeu_cau
                 || (coHskt && c.kt_hskt !== d.kt_hskt) || (coDsp && (c.dsp_logo === true) !== d.dsp_logo)) {
        await repo.suaTx(client, c.id, d, actorId);
        await repo.logTx(client, c.id, 'SUA_TINH_CHAT_IN', giaTri(c), giaTri(d), actorId);
        if (c.luong !== d.luong) apPhanIn += await repo.apLuongChoPhanInTx(client, d.ma_chuan, luongPhanIn(d.luong));
        n += 1;
      }
    }
    return n;
  });
  xoaNhoLuong();
  return { ...(await danhSach()), so_doi: soDoi, so_phan_in_doi_luong: apPhanIn };
}

// Thêm 1 tính chất. Đã có (đang dùng) ⇒ 409; đã xóa trước đó ⇒ bật lại.
async function them(item, actorId) {
  if (!(await repo.coBang())) throw CHUA_MIG();
  const d = chuanDong(item);
  await kiemCheDo([d]);
  const apPhanIn = await withTransaction(async (client) => {
    const [c] = await repo.docTheoMaTx(client, [d.ma_chuan]);
    if (c && c.dang_hoat_dong) throw new AppError(`Tính chất "${c.ten}" đã có trong danh mục`, { status: 409, errorCode: 'DA_CO' });
    if (c) {
      await repo.suaTx(client, c.id, d, actorId);
      await repo.logTx(client, c.id, 'THEM_TINH_CHAT_IN', giaTri(c), giaTri(d), actorId);
    } else {
      const id = await repo.themTx(client, d, actorId);
      await repo.logTx(client, id, 'THEM_TINH_CHAT_IN', null, giaTri(d), actorId);
    }
    return repo.apLuongChoPhanInTx(client, d.ma_chuan, luongPhanIn(d.luong));
  });
  xoaNhoLuong();
  return { ...(await danhSach()), so_phan_in_doi_luong: apPhanIn };
}

// Xóa mềm. Chặn dòng đang bỏ qua (xóa = thôi bỏ qua ⇒ hàng tràn vào MES mà không ai để ý) và dòng còn phần in.
async function xoa(id, actorId) {
  if (!UUID_RE.test(String(id))) throw new AppError('Mã không hợp lệ', { status: 422, errorCode: 'ID_SAI' });
  if (!(await repo.coBang())) throw CHUA_MIG();
  await withTransaction(async (client) => {
    const c = await repo.docTheoIdTx(client, id);
    if (!c || !c.dang_hoat_dong) throw new AppError('Không tìm thấy tính chất in', { status: 404, errorCode: 'NOT_FOUND' });
    if (c.bo_qua) throw new AppError(`"${c.ten}" đang bị bỏ qua — tắt bỏ qua trước rồi mới xóa được`, { status: 409, errorCode: 'DANG_BO_QUA' });
    const n = await repo.demPhanInCua(client, c.ma_chuan);
    if (n > 0) throw new AppError(`"${c.ten}" đang có ${n} phần in trong MES — không xóa được`, { status: 409, errorCode: 'DANG_DUNG' });
    await repo.anTx(client, id, actorId);
    await repo.logTx(client, id, 'XOA_TINH_CHAT_IN', giaTri(c), null, actorId);
  });
  return danhSach();
}

module.exports = { danhSach, luu, them, xoa };
