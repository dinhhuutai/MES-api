const repo = require('./phaninadmin.repository');
const planningService = require('../planning/planning.service');
const ordersService = require('../orders/orders.service');
const technicalService = require('../technical/technical.service');
const erpsyncRepo = require('../erpsync/erpsync.repository');
// HSKT active của phần in — để tính lại phương án in khi đổi LOẠI đợt vải / SL vải về (16/09/2026).
// ⚠ Chỉ require REPOSITORY (không phải service) nên không có vòng require.
const hsktRepo = require('../hskt/hskt.repository');
// Bỏ công đoạn (11/11/2026): cờ Test Run của lệnh + đổi trạng thái / audit kế hoạch · theo dõi dòng chảy · ERP Release 1.
const planningRepo = require('../planning/planning.repository');
const release1Erp = require('../planning/release1Erp');
const tracking = require('../workflow/tracking.service');
const sockets = require('../../sockets');
const AppError = require('../../utils/AppError');
const { query, withTransaction } = require('../../config/db');
const khoaErp = require('../../utils/khoaErp');
const { LUONG_SX } = require('../../utils/luongSanXuat');

// ─────────────────────────────────────────────────────────────────────────────
// QUẢN TRỊ PHẦN IN — một chỗ gỡ rối mọi thứ của 1 phần in.
//
// ⚠⚠ NGUYÊN TẮC: **TÁI DÙNG service đang chạy ngoài giao diện**, KHÔNG viết đường ghi riêng.
//   Đổi giai đoạn = gọi `planning.rollbackLenh` (chính hàm của tab "Hủy lệnh sản xuất");
//   hủy/mở đợt vải = gọi `orders.softDeleteDotVai`/`reopenDotVai` (chính hàm của tab Hủy/Mở đợt vải).
//   Viết SQL riêng ở đây là sớm muộn lệch guard với phần còn lại của hệ.
// ─────────────────────────────────────────────────────────────────────────────

async function traCuu(search) {
  return repo.traCuu(search || '', 30);
}

async function chiTiet(phanInId) {
  const pin = await repo.getPhanIn(phanInId);
  if (!pin) throw new AppError('Phần in không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const [ready, dotVai, loaiDotVai, toanCanh, coKhoa] = await Promise.all([
    repo.getReady(phanInId), repo.getDotVaiList(phanInId), repo.danhMucLoaiDotVai(), repo.toanCanh(phanInId),
    khoaErp.coCotKhoaErp(),
  ]);
  // Khóa ERP (mig 116): người khóa đọc riêng — cột có thể chưa có (chưa chạy mig) nên không JOIN trong getPhanIn.
  let khoa = { co_cot: coKhoa, dang_khoa: !!pin.khoa_erp, tg: pin.khoa_erp_tg || null, nguoi: null };
  if (coKhoa && pin.khoa_erp_boi) {
    const { rows } = await query('SELECT ho_ten FROM nguoi_dung WHERE id = $1', [pin.khoa_erp_boi]);
    khoa = { ...khoa, nguoi: rows[0] ? rows[0].ho_ten : null };
  }
  // Công đoạn của từng đợt (mig 139 — đánh dấu thắng loại đợt) + lựa chọn để đánh dấu tay (chỉ phần in 2 công đoạn).
  const L = require('../../utils/luongSanXuat');
  const luong = L.chuanLuong(pin.luong_sx);
  const haiCd = L.laHaiCongDoan(luong);
  const paEp = haiCd ? await L.paCongDoanEp(pin.tinh_chat_in).catch(() => null) : null;
  const dots = dotVai.map((d) => ({ ...d, cong_doan_dot: L.chuanCdDot(d.cong_doan_dot_dat),
    cong_doan_ten: tenCongDoanDot(L, luong, d.ma_loai_dot_vai, d.cong_doan_dot_dat, paEp) }));
  return {
    phan_in: pin, ready, dot_vai: dots, loai_dot_vai: loaiDotVai, toan_canh: toanCanh, khoa_erp: khoa, dich_lui: DICH_LUI, luong_sx: LUONG_SX,
    cong_doan_dot_chon: haiCd ? luaChonCongDoan(L, luong, paEp).map((c) => ({ id: c.ma, ten: c.ten })) : [],
    co_cot_cong_doan: haiCd ? await L.coCotCdDot() : false,
  };
}

// ─── SỬA TRƯỜNG ──────────────────────────────────────────────────────────────
// `opts.khoa` = sửa từ TRANG Quản trị phần in ⇒ tự KHÓA đồng bộ ERP của phần in (mig 116, `utils/khoaErp.js`).
// Hàm còn được trang GN (sửa tay, không khóa) và luồng ERP (`suathongtin/erpCapNhat` — đã tự bỏ qua phần in khóa) dùng chung.
async function suaPhanIn(phanInId, patch, actorId, opts = {}) {
  const truoc = await repo.getPhanIn(phanInId);
  if (!truoc) throw new AppError('Phần in không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const kq = await repo.updatePhanIn(phanInId, patch || {}, actorId);
  if (!kq) throw new AppError('Không có trường nào hợp lệ để sửa', { status: 422, errorCode: 'NO_FIELD' });
  const cu = {}; const moi = {};
  kq.cols.forEach((c) => { cu[c] = truoc[c]; moi[c] = kq.row[c]; });
  await repo.ghiAudit('phan_in', phanInId, 'QUAN_TRI_SUA_PHAN_IN', cu, moi, actorId);
  const daKhoa = opts.khoa ? await khoaSauKhiSua(phanInId, actorId) : false;
  sockets.emit('dashboard:refresh', {});
  return { id: phanInId, cols: kq.cols, khoa_erp: daKhoa };
}

// Khóa ERP sau khi sửa tay — best-effort: chưa chạy mig 116 thì sửa vẫn xong, chỉ không khóa.
async function khoaSauKhiSua(phanInId, actorId) {
  try { await khoaErp.datKhoa(phanInId, true, actorId, { lyDo: 'Sửa tay ở Quản trị phần in' }); return true; } catch (e) {
    if (e.errorCode !== 'CHUA_MIGRATION_116') console.error(`[quan-tri-phan-in] ✗ Khóa ERP lỗi: ${e.message}`);
    return false;
  }
}

// ─── LUỒNG SẢN XUẤT (mig 126, 09/11/2026) ────────────────────────────────────
// Đổi luồng của phần in (In thường · In kiếng · In + ép · Logo · In kiếng không ép) + "ép ủi trước, in sau". Lý do bắt buộc.
//   · Bỏ 2 công đoạn (về 1 công đoạn) khi phần in còn LỆNH ÉP sống ⇒ 409 `DA_LAP_EP` — dùng "Bỏ công đoạn ép ủi"
//     (`boCongDoan`: tự hủy lệnh ép chưa in tem). Chưa lập ⇒ phần ép ủi biến khỏi Release 1 ngay.
//   · Lệnh sống CHƯA in tem ⇒ đánh lại "công đoạn đầu" theo luồng + thứ tự mới. Lệnh ĐÃ in tem: thôi là công đoạn đầu ⇒
//     đánh lại + NHẢ tem công đoạn đầu vào KCS (`nhaTemCongDoanDauTx` — để nguyên thì tem kẹt "Chờ công đoạn sau" mãi);
//     thành công đoạn đầu ⇒ giữ (tem đã đi KCS không kéo lại được) — trả mã lệnh giữ.
//   · Thêm lại 2 công đoạn cho phần in đã "Bỏ công đoạn In" mà lệnh ép đã đổi sang công đoạn duy nhất còn sống ⇒ 409
//     `DA_BO_CONG_DOAN_IN` (đường này sẽ coi chúng là lệnh IN).
//   · Đặt `luong_sx_sua_tay` ⇒ đổi phân loại ở trang Tính chất in không ghi đè nữa.
// CÔNG ĐOẠN ĐẦU theo luồng + thứ tự mới — luật DUY NHẤT của Đổi luồng · Thêm công đoạn. `lenh` = `repo.lenhTheoCongDoan`
//   (công đoạn `gd` đã đúng). Mỗi lệnh: `GIU_NGUYEN` (đã đúng) · `DOI` (đặt lại; thôi là công đoạn đầu mà có tem công đoạn
//   đầu ⇒ `nha` = nhả tem vào KCS) · `GIU` (đã in tem mà sẽ thành công đoạn đầu ⇒ giữ — tem đã đi KCS không kéo lại được).
function keHoachCongDoanDau(lenh, luong, epT) {
  const L = require('../../utils/luongSanXuat');
  return lenh.map((l) => {
    const dau = L.laCongDoanDau(luong, epT, l.gd);
    if (dau === !!l.la_cong_doan_dau) return { l, dau, viec: 'GIU_NGUYEN', nha: false };
    if (l.so_tem > 0 && dau) return { l, dau, viec: 'GIU', nha: false };
    return { l, dau, viec: 'DOI', nha: !dau && l.so_tem_dau > 0 };
  });
}
async function danhLaiCongDoanDauTx(client, lenh, luong, epT, actorId) {
  const ke = keHoachCongDoanDau(lenh, luong, epT);
  let doiLenh = 0;
  for (const k of ke.filter((x) => x.viec === 'DOI')) {
    // eslint-disable-next-line no-await-in-loop
    await repo.datCongDoanLenhTx(client, [k.l.id], { laDau: k.dau }, actorId);
    doiLenh += 1;
  }
  const temNha = await repo.nhaTemCongDoanDauTx(client, ke.filter((x) => x.nha).map((x) => x.l.id), actorId);
  return { doiLenh, giu: ke.filter((x) => x.viec === 'GIU').map((x) => x.l.ma_lenh_san_xuat), temNha };
}

async function datLuongSx(phanInId, { luong, epTruoc, lyDo } = {}, actorId) {
  const L = require('../../utils/luongSanXuat');
  if (!L.MA_LUONG_SX.has(luong)) throw new AppError('Luồng sản xuất không hợp lệ', { status: 422, errorCode: 'LUONG_SAI' });
  const ly = String(lyDo || '').trim();
  if (!ly) throw new AppError('Nhập lý do đổi luồng', { status: 422, errorCode: 'NO_LY_DO' });
  const epT = L.laHaiCongDoan(luong) ? !!epTruoc : false;
  if (L.laHaiCongDoan(luong)) {
    const daDoi = await repo.lenhEpDaDoiConSong(phanInId);
    if (daDoi.length) {
      throw new AppError(`Phần in đã bỏ công đoạn In — ${daDoi.join(', ')} là lệnh ÉP ỦI đã chuyển thành lệnh của công đoạn duy nhất. `
        + 'Hủy các lệnh này trước rồi mới thêm lại 2 công đoạn', { status: 409, errorCode: 'DA_BO_CONG_DOAN_IN', details: daDoi });
    }
  }
  const kq = await withTransaction(async (client) => {
    const { rows: [cu] } = await client.query(
      'SELECT id, ma_phan, luong_sx, ep_truoc, luong_sx_sua_tay FROM phan_in WHERE id = $1 FOR UPDATE', [phanInId]);
    if (!cu) throw new AppError('Phần in không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
    const luongCu = L.chuanLuong(cu.luong_sx);
    if (luongCu === luong && !!cu.ep_truoc === epT) {
      throw new AppError('Luồng không đổi', { status: 422, errorCode: 'KHONG_DOI' });
    }
    const lenh = await repo.lenhTheoCongDoan(phanInId, client);
    if (!L.laHaiCongDoan(luong)) {
      const ep = lenh.filter((l) => l.gd === L.GD_EP);
      if (ep.length) {
        throw new AppError(`Phần in còn lệnh ép ủi ${ep.map((l) => l.ma_lenh_san_xuat).join(', ')} — dùng "Bỏ công đoạn ép ủi" (tự hủy lệnh ép chưa in tem) hoặc hủy lệnh ép trước`,
          { status: 409, errorCode: 'DA_LAP_EP', details: ep.map((l) => l.id) });
      }
    }
    // Logo ⇒ 2 công đoạn mà đã có lệnh: lệnh Logo phải đổi sang công đoạn ÉP (đổi luồng ở đây sẽ coi chúng là lệnh IN) ⇒ dùng
    //   "Thêm công đoạn In" (`themCongDoan` — đổi công đoạn lệnh + kế hoạch tạm trong cùng lượt).
    if (luongCu === 'LOGO' && L.laHaiCongDoan(luong) && lenh.some((l) => l.gd === L.GD_IN)) {
      throw new AppError(`Phần in Logo đã có lệnh ${lenh.map((l) => l.ma_lenh_san_xuat).join(', ')} — dùng nút "Thêm công đoạn In" (đổi các lệnh này sang công đoạn Logo)`,
        { status: 409, errorCode: 'DUNG_THEM_CONG_DOAN' });
    }
    const { doiLenh, giu, temNha } = await danhLaiCongDoanDauTx(client, lenh, luong, epT, actorId);
    await repo.datLuongPhanInTx(client, phanInId, luong, epT, actorId);
    await repo.ghiAudit('phan_in', phanInId, 'DOI_LUONG_SX', { luong_sx: luongCu, ep_truoc: !!cu.ep_truoc },
      { luong_sx: luong, ep_truoc: epT, ly_do: ly, so_lenh_doi_cong_doan_dau: doiLenh, lenh_giu: giu,
        tem_nha_kcs: temNha.map((t) => t.ma_tem) }, actorId, client);
    return { ma_phan: cu.ma_phan, doiLenh, giu, temNha };
  });
  sockets.emit('workflow:updated', { phanInId, action: 'doi-luong' });
  if (kq.temNha.length) sockets.emit('production:updated', { phanInId, action: 'nha-tem-cong-doan-dau' });
  sockets.emit('dashboard:refresh', {});
  return {
    phan_in_id: phanInId, luong_sx: luong, ep_truoc: epT, so_lenh_doi: kq.doiLenh, lenh_da_in_tem_giu: kq.giu,
    so_tem_nha_kcs: kq.temNha.length,
  };
}

// ─── BỎ 1 CÔNG ĐOẠN của phần in 2 công đoạn (11/11/2026, người dùng chốt) ──────────────────────────────────
// "Bỏ công đoạn In, chỉ giữ ép ủi" / "Bỏ công đoạn Ép ủi, chỉ giữ in". Luồng mới theo `luongSanXuat.luongSauKhiBo`
//   (bỏ In ⇒ LOGO như hàng chỉ ép; bỏ Ép ⇒ In kiếng giữ kiếng (`KIENG_KHONG_EP`) / In + ép ⇒ In thường). Lý do bắt buộc;
//   `xemTruoc` = chỉ dựng kế hoạch (FE hiện trước khi bấm). Mọi bước gọi lại service thật:
//   1. Lệnh của công đoạn BỊ BỎ chưa in tem ⇒ hủy bằng CHÍNH `planning.rollbackLenh` (đích Release 1; lệnh đã có phiếu
//      chưa in tem ⇒ hủy tùy chọn kèm phiếu) — báo ERP hủy kế hoạch như tab Hủy lệnh sản xuất. Đã in tem ⇒ CHẶN.
//   2. Kế hoạch tạm của công đoạn bị bỏ ⇒ `planning.huyKeHoachTam` (lý do, audit `HUY_KE_HOACH_TAM`).
//   3. (1 transaction) lệnh của công đoạn CÒN LẠI thôi là công đoạn đầu (nhả tem công đoạn đầu vào KCS); bỏ In ⇒ lệnh ép
//      đổi `giai_doan` → 'IN' (thành "phần chính" của đợt ở mọi câu release / giai đoạn / ERP) + kế hoạch tạm phần ép thành
//      kế hoạch tạm thường + lệnh còn chờ Test Run (không vướng chờ KT / GN / Kế hoạch) vào thẳng Chờ chạy như lệnh Logo
//      (audit `RELEASE_2` cờ `bo_test_run_logo`); đặt luồng mới; audit `phan_in` · `BO_CONG_DOAN`.
//   4. Bỏ In ⇒ phương án in HSKT thành Ép (4 — `L.PAIN_EP`) — `hskt.service changePhuongAnIn` (tùy chọn `doiPa`, mặc định có).
//   5. Bỏ In ⇒ gửi ERP Release 1 cho các lệnh ép vừa đổi (trước đây lệnh ép không gửi — `release1Erp` lọc EP_UI).
async function dungKeHoachBoCongDoan(phanInId, bo) {
  const L = require('../../utils/luongSanXuat');
  const pin = await repo.getPhanIn(phanInId);
  if (!pin) throw new AppError('Phần in không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const luongCu = L.chuanLuong(pin.luong_sx);
  if (!L.laHaiCongDoan(luongCu)) {
    throw new AppError(`Phần in đang ở luồng ${(L.LUONG_SX.find((x) => x.ma === luongCu) || {}).ten || luongCu} (1 công đoạn) — không có công đoạn để bỏ`,
      { status: 409, errorCode: 'KHONG_HAI_CONG_DOAN' });
  }
  const boGd = L.chuanGd(bo);
  const giuGd = boGd === L.GD_IN ? L.GD_EP : L.GD_IN;
  const luongMoi = L.luongSauKhiBo(luongCu, boGd);
  const nhanBo = L.nhanCongDoan(luongCu, boGd);
  const nhanGiu = L.nhanCongDoan(luongCu, giuGd);
  const [lenh, kht, hskt] = await Promise.all([
    repo.lenhTheoCongDoan(phanInId), repo.keHoachTamTheoCongDoan(phanInId), hsktRepo.activeHsktOfPhanIn(phanInId),
  ]);
  const chan = [];
  const lenhBo = lenh.filter((l) => l.gd === boGd).map((l) => {
    if (l.so_tem > 0) {
      chan.push(`Lệnh ${l.ma_lenh_san_xuat} (công đoạn ${nhanBo}) đã in ${l.so_tem} tem — hủy tem / lệnh trước (Hủy lệnh xác nhận) rồi mới bỏ công đoạn này`);
      return { ...l, viec: 'CHAN' };
    }
    if (l.so_phan_in > 1) {
      chan.push(`Lệnh ${l.ma_lenh_san_xuat} gom ${l.so_phan_in} phần in — hủy lệnh này sẽ kéo theo phần in khác, xử lý tay trước`);
      return { ...l, viec: 'CHAN' };
    }
    return { ...l, viec: 'HUY', huy_tuy_chon: l.co_phieu || !['RELEASE_1', 'RELEASE_2', 'GIA_CONG'].includes(l.trang_thai) };
  });
  const lenhGiu = [];
  for (const l of lenh.filter((x) => x.gd === giuGd)) {
    const doiGd = giuGd === L.GD_EP;
    if (l.so_phan_in > 1 && (doiGd || l.la_cong_doan_dau)) {
      chan.push(`Lệnh ${l.ma_lenh_san_xuat} gom ${l.so_phan_in} phần in — đổi công đoạn sẽ kéo theo phần in khác, xử lý tay trước`);
    }
    let sangChoChay = false; let lyDoGiu = null;
    if (luongMoi === 'LOGO' && l.trang_thai === 'RELEASE_1') {
      // eslint-disable-next-line no-await-in-loop
      const f = await planningRepo.lenhChoKyThuat(l.id);
      if (f && f.co_phieu) lyDoGiu = 'đã có phiếu sản xuất';
      else if (f && f.cho_ky_thuat) lyDoGiu = 'đang chờ kỹ thuật làm lại READY';
      else if (f && f.cho_gn) lyDoGiu = 'phần in đang ở Giao nhận';
      else if (f && f.cho_ke_hoach) lyDoGiu = 'đang được trả về Kế hoạch';
      else sangChoChay = true;
    }
    lenhGiu.push({ ...l, doi_gd: doiGd, sang_cho_chay: sangChoChay, giu_test_run: lyDoGiu, nha_tem: l.so_tem_dau });
  }
  const khtBo = kht.filter((k) => L.chuanGd(k.gd) === boGd);
  const khtGiuDoi = giuGd === L.GD_EP ? kht.filter((k) => L.chuanGd(k.gd) === L.GD_EP) : [];
  const canhBao = [];
  let hs = null;
  if (hskt) {
    const dungChung = await repo.phanInCungHskt(hskt.id, phanInId);
    hs = { id: hskt.id, barcode_hskt: hskt.barcode_hskt, phuong_an_in: Number(hskt.phuong_an_in) || 0, dung_chung: dungChung };
    if (boGd === L.GD_IN && hs.phuong_an_in !== L.PAIN_EP && dungChung.length) {
      canhBao.push(`Hồ sơ kỹ thuật ${hs.barcode_hskt} dùng chung với ${dungChung.map((p) => p.ma_phan).join(', ')} — đổi phương án in sang Ép là đổi cho cả các phần in này`);
    }
    if (boGd === L.GD_EP && hs.phuong_an_in === L.PAIN_EP) {
      canhBao.push('Phương án in của hồ sơ đang là Ép — công đoạn in còn lại sẽ mang PA này. Đổi lại ở Hồ sơ kỹ thuật nếu sai');
    }
  }
  if (khtGiuDoi.length && !(await L.khtCoCotGd())) {
    canhBao.push('Kế hoạch tạm phần ép chưa có cột công đoạn (chưa chạy mig 128)');
  }
  return {
    pin, luongCu, luongMoi, boGd, giuGd, nhanBo, nhanGiu, lenhBo, lenhGiu, khtBo, khtGiuDoi, hskt: hs,
    doiPaDuoc: boGd === L.GD_IN && !!hs && hs.phuong_an_in !== L.PAIN_EP, chan, canhBao,
  };
}

// Kế hoạch ⇒ dạng trả FE (xem trước + kết quả).
function moTaKeHoachBo(kh) {
  const L = require('../../utils/luongSanXuat');
  const tenL = (ma) => (L.LUONG_SX.find((x) => x.ma === ma) || {}).ten || ma;
  return {
    ma_phan: kh.pin.ma_phan, bo: kh.boGd, giu: kh.giuGd, nhan_bo: kh.nhanBo, nhan_giu: kh.nhanGiu,
    luong_cu: kh.luongCu, luong_moi: kh.luongMoi, ten_luong_cu: tenL(kh.luongCu), ten_luong_moi: tenL(kh.luongMoi),
    lenh_bo: kh.lenhBo.map((l) => ({ id: l.id, ma: l.ma_lenh_san_xuat, trang_thai: l.trang_thai, ma_chuyen: l.ma_chuyen,
      viec: l.viec, huy_tuy_chon: !!l.huy_tuy_chon, so_tem: l.so_tem })),
    lenh_giu: kh.lenhGiu.map((l) => ({ id: l.id, ma: l.ma_lenh_san_xuat, trang_thai: l.trang_thai, ma_chuyen: l.ma_chuyen,
      doi_gd: l.doi_gd, sang_cho_chay: l.sang_cho_chay, giu_test_run: l.giu_test_run, nha_tem: l.nha_tem, so_tem: l.so_tem })),
    kht_bo: kh.khtBo.map((k) => ({ id: k.id, ma_dot_vai: k.ma_dot_vai, so_luong: k.so_luong, ma_chuyen: k.ma_chuyen })),
    kht_giu_doi: kh.khtGiuDoi.length,
    hskt: kh.hskt && { barcode_hskt: kh.hskt.barcode_hskt, phuong_an_in: kh.hskt.phuong_an_in,
      dung_chung: kh.hskt.dung_chung.map((p) => p.ma_phan) },
    doi_pa_duoc: kh.doiPaDuoc,
    erp_gui_release_1: kh.giuGd === L.GD_EP ? kh.lenhGiu.map((l) => l.ma_lenh_san_xuat) : [],
    chan: kh.chan, canh_bao: kh.canhBao,
  };
}

async function boCongDoan(phanInId, { bo, lyDo, xemTruoc = false, doiPa = true } = {}, actorId) {
  const L = require('../../utils/luongSanXuat');
  if (![L.GD_IN, L.GD_EP].includes(bo)) throw new AppError('Chọn công đoạn bỏ: IN hoặc EP_UI', { status: 422, errorCode: 'BO_SAI' });
  const kh = await dungKeHoachBoCongDoan(phanInId, bo);
  if (xemTruoc) return { xem_truoc: true, ...moTaKeHoachBo(kh) };
  const ly = String(lyDo || '').trim();
  if (!ly) throw new AppError('Nhập lý do bỏ công đoạn', { status: 422, errorCode: 'NO_LY_DO' });
  if (kh.chan.length) throw new AppError(kh.chan.join(' · '), { status: 409, errorCode: 'KHONG_BO_DUOC', details: kh.chan });
  const lyDoGhi = `Bỏ công đoạn ${kh.nhanBo} (${kh.pin.ma_phan}): ${ly}`;

  // 1–2) Hủy lệnh + kế hoạch tạm của công đoạn bị bỏ — từng việc 1 lần gọi service thật; lỗi giữa chừng ⇒ dừng, báo đã làm.
  const lenhHuy = []; const khtHuy = [];
  const dung = (viec, e) => {
    const xong = [...lenhHuy.map((m) => `hủy ${m}`), ...khtHuy.map((m) => `hủy KH tạm ${m}`)];
    throw new AppError(`Dừng ở bước ${viec}: ${e.message}${xong.length ? ` (đã làm: ${xong.join(', ')} — luồng CHƯA đổi, bấm lại để làm tiếp)` : ''}`,
      { status: e.status || 409, errorCode: e.errorCode || 'BO_CONG_DOAN_DUNG' });
  };
  for (const l of kh.lenhBo) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await planningService.rollbackLenh(l.id, { target: 'RELEASE_1', lyDo: lyDoGhi, force: !!l.huy_tuy_chon }, actorId);
      lenhHuy.push(l.ma_lenh_san_xuat);
    } catch (e) { dung(`hủy lệnh ${l.ma_lenh_san_xuat}`, e); }
  }
  for (const k of kh.khtBo) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await planningService.huyKeHoachTam(k.id, { lyDo: lyDoGhi }, actorId);
      khtHuy.push(k.ma_dot_vai);
    } catch (e) {
      if (e.errorCode !== 'NOT_FOUND') dung(`hủy kế hoạch tạm đợt ${k.ma_dot_vai}`, e);
    }
  }

  // 3) Đổi công đoạn lệnh còn lại + luồng — 1 transaction, đọc lại lệnh sau khi khóa phần in.
  const coCotKht = await L.khtCoCotGd();
  const tx = await withTransaction(async (client) => {
    const { rows: [cu] } = await client.query('SELECT luong_sx FROM phan_in WHERE id = $1 FOR UPDATE', [phanInId]);
    if (!cu || L.chuanLuong(cu.luong_sx) !== kh.luongCu) {
      throw new AppError('Luồng của phần in vừa bị đổi ở nơi khác — tải lại rồi làm lại', { status: 409, errorCode: 'DA_DOI' });
    }
    const lenh = await repo.lenhTheoCongDoan(phanInId, client);
    const conBo = lenh.filter((l) => l.gd === kh.boGd);
    if (conBo.length) {
      throw new AppError(`Vừa có lệnh ${conBo.map((l) => l.ma_lenh_san_xuat).join(', ')} của công đoạn ${kh.nhanBo} — bấm lại để xử lý`,
        { status: 409, errorCode: 'DA_DOI' });
    }
    const giu = lenh.filter((l) => l.gd === kh.giuGd);
    const doiGd = kh.giuGd === L.GD_EP;
    // Bỏ In ⇒ mọi lệnh ép đổi `giai_doan`; bỏ Ép ⇒ chỉ lệnh in đang là công đoạn đầu (in trước) cần đánh lại.
    const canDoi = doiGd ? giu : giu.filter((l) => l.la_cong_doan_dau);
    await repo.datCongDoanLenhTx(client, canDoi.map((l) => l.id), { laDau: false, gd: doiGd ? L.GD_IN : null }, actorId);
    const temNha = await repo.nhaTemCongDoanDauTx(client, giu.filter((l) => l.so_tem_dau > 0).map((l) => l.id), actorId);
    const khtDoi = doiGd && coCotKht ? await repo.doiKeHoachTamSangInTx(client, kh.khtGiuDoi.map((k) => k.id)) : 0;
    const choChay = new Set(kh.lenhGiu.filter((l) => l.sang_cho_chay).map((l) => l.id));
    const sangChoChay = [];
    for (const l of giu) {
      if (!choChay.has(l.id) || l.trang_thai !== 'RELEASE_1' || l.co_phieu) continue;
      // eslint-disable-next-line no-await-in-loop
      await planningRepo.setLenhTrangThai(client, l.id, 'RELEASE_2', actorId);
      // eslint-disable-next-line no-await-in-loop
      await planningRepo.logPlanChange(client, l.id, 'RELEASE_2', { trang_thai: 'RELEASE_1' },
        { trang_thai: 'RELEASE_2', bo_test_run_logo: true, nguon: 'BO_CONG_DOAN', ly_do: lyDoGhi }, actorId);
      sangChoChay.push(l);
    }
    await repo.datLuongPhanInTx(client, phanInId, kh.luongMoi, false, actorId);
    await repo.ghiAudit('phan_in', phanInId, 'BO_CONG_DOAN', { luong_sx: kh.luongCu, ep_truoc: !!kh.pin.ep_truoc }, {
      bo: kh.boGd, luong_sx: kh.luongMoi, ly_do: ly,
      lenh_huy: lenhHuy, kht_huy: khtHuy,
      lenh_doi_gd: doiGd ? giu.map((l) => l.id) : [], lenh_doi_gd_ma: doiGd ? giu.map((l) => l.ma_lenh_san_xuat) : [],
      lenh_sang_cho_chay: sangChoChay.map((l) => l.ma_lenh_san_xuat), tem_nha_kcs: temNha.map((t) => t.ma_tem),
      kht_doi_gd: khtDoi,
    }, actorId, client);
    return { giu, temNha, sangChoChay, khtDoi };
  });

  // 4) Phương án in hồ sơ ⇒ Ép (bỏ In). Lỗi không hoàn tác bước 3 — báo kèm kết quả.
  let hsktKq = null;
  if (kh.doiPaDuoc && doiPa !== false) {
    try {
      const hsktService = require('../hskt/hskt.service');
      const r = await hsktService.changePhuongAnIn(kh.hskt.id, L.PAIN_EP, actorId);
      hsktKq = { doi: true, barcode_cu: r.barcode_cu, barcode_moi: r.barcode_moi };
    } catch (e) {
      console.error(`[quan-tri-phan-in] ✗ Bỏ công đoạn ${kh.pin.ma_phan}: không đổi được PA hồ sơ: ${e.message}`);
      hsktKq = { doi: false, loi: e.message };
    }
  }

  // 5) Theo dõi dòng chảy (`ton_tram` — chỉ đồng hồ SLA; hủy lệnh ở bước 1 đã kéo đợt về READY ⇒ đặt lại theo lệnh còn
  //    lại) + ERP + socket. `moveByLenh` tự nuốt lỗi.
  const daChuyen = new Set(tx.sangChoChay.map((l) => l.id));
  for (const l of tx.giu) {
    const tram = daChuyen.has(l.id) ? 'RELEASE_2' : (lenhHuy.length && ['RELEASE_1', 'RELEASE_2'].includes(l.trang_thai) ? l.trang_thai : null);
    // eslint-disable-next-line no-await-in-loop
    if (tram) await tracking.moveByLenh(l.id, tram, actorId);
  }
  const erpGui = kh.giuGd === L.GD_EP ? tx.giu.map((l) => l.id) : [];
  if (erpGui.length) release1Erp.xepHang(erpGui, actorId, 'BO_CONG_DOAN');
  tx.giu.forEach((l) => sockets.emit('workflow:updated', { lenhId: l.id, action: 'bo-cong-doan' }));
  sockets.emit('workflow:updated', { phanInId, action: 'bo-cong-doan' });
  if (tx.temNha.length) sockets.emit('production:updated', { phanInId, action: 'nha-tem-cong-doan-dau' });
  sockets.emit('dashboard:refresh', {});
  return {
    ...moTaKeHoachBo(kh), xem_truoc: false,
    ket_qua: {
      lenh_huy: lenhHuy, kht_huy: khtHuy, lenh_doi_gd: kh.giuGd === L.GD_EP ? tx.giu.map((l) => l.ma_lenh_san_xuat) : [],
      lenh_sang_cho_chay: tx.sangChoChay.map((l) => l.ma_lenh_san_xuat), tem_nha_kcs: tx.temNha.length,
      kht_doi_gd: tx.khtDoi, hskt: hsktKq, erp_gui_release_1: tx.giu.filter((l) => erpGui.includes(l.id)).map((l) => l.ma_lenh_san_xuat),
    },
  };
}

// ─── THÊM 1 CÔNG ĐOẠN cho phần in 1 công đoạn + ĐẶT CÔNG ĐOẠN MỚI VÀO MÀN NÀO (19/11/2026, người dùng chốt) ──────────
// Hướng `luongSanXuat.luongSauKhiThem`: In thường + Ép/Logo ⇒ In + Logo · In kiếng + Ép ⇒ kiếng ủi · Logo + In ⇒ In + Logo.
// Xem trước (`xemTruoc`) rồi mới làm — gương "Bỏ công đoạn". Các bước gọi lại service thật:
//   1. (1 transaction) Logo + In ⇒ lệnh Logo đang sống đổi `giai_doan` → EP_UI (là công đoạn ép của luồng mới) + kế hoạch tạm
//      'IN' → 'EP_UI'; đặt luồng + thứ tự (`epTruoc`); đánh lại công đoạn đầu (`danhLaiCongDoanDauTx` — chung Đổi luồng);
//      audit `phan_in` · `THEM_CONG_DOAN`.
//   2. Logo + In mà PA hồ sơ đang 0 / Ép / Logo ⇒ PA cho công đoạn In (`paIn` 1 Bàn / 2 Máy / 3 Robot) — `hskt.service
//      changePhuongAnIn` (khóa sửa tay ⇒ ERP gửi Pain Logo không lật lại).
//   3. Đặt công đoạn mới vào màn `dich`:
//      · RELEASE_1 — không làm gì thêm: đợt Ready hiện thêm dòng công đoạn mới ở Release 1 (đợt chưa Ready vẫn ở READY).
//      · TEST_RUN (chỉ công đoạn In) / CHO_CHAY — lập lệnh ngay bằng CHÍNH `planning.createRelease1` cho các đợt Ready đã chọn
//        (chuyền / ngày / giờ / SL / thợ in). Ép/Logo tự vào Chờ chạy; In vào Test Run, chọn CHO_CHAY ⇒ quản trị bỏ Test Run
//        (RELEASE_1 → RELEASE_2, audit `RELEASE_2` `nguon THEM_CONG_DOAN` + `bo_test_run_quan_tri`).
//      · READY — mọi đợt sống về READY bằng CHÍNH `datGiaiDoan` (`readyKieu` READY_KT kỹ thuật làm lại / READY_QA chỉ QA). CHỈ
//        khi phần in CHƯA có lệnh sống: READY dùng chung 1 bộ theo đợt, hủy READY mức phần in kéo cả đợt đã chạy.
//   Bước 2–3 lỗi KHÔNG hoàn tác bước 1 (công đoạn đã thêm) — trả lỗi kèm kết quả để làm tiếp ở màn tương ứng.
// Chặn: phần in đã 2 công đoạn · Logo + In có lệnh gom nhiều phần in · In kiếng + Ép mà đợt không phải 4I (sẽ thành đợt Ép
//   theo luật kiếng ủi) đang có lệnh / kế hoạch tạm In kiếng.
const DICH_THEM = ['RELEASE_1', 'READY', 'TEST_RUN', 'CHO_CHAY'];
const READY_KIEU = ['READY_KT', 'READY_QA'];
const PA_CONG_DOAN_IN = [1, 2, 3];

async function dungKeHoachThemCongDoan(phanInId, epTruocVao) {
  const L = require('../../utils/luongSanXuat');
  const pin = await repo.getPhanIn(phanInId);
  if (!pin) throw new AppError('Phần in không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const luongCu = L.chuanLuong(pin.luong_sx);
  const huong = L.luongSauKhiThem(luongCu);
  if (!huong) {
    throw new AppError(`Phần in đang ở luồng ${(L.LUONG_SX.find((x) => x.ma === luongCu) || {}).ten || luongCu} (đã 2 công đoạn) — không thêm được`,
      { status: 409, errorCode: 'DA_HAI_CONG_DOAN' });
  }
  const { luong: luongMoi, them } = huong;
  const giuGd = them === L.GD_IN ? L.GD_EP : L.GD_IN;
  const epT = !!epTruocVao;
  const paEp = await L.paCongDoanEp(pin.tinh_chat_in);
  const nhanThem = L.nhanCongDoan(luongMoi, them, paEp);
  const nhanGiu = L.nhanCongDoan(luongMoi, giuGd, paEp);
  const [lenhRaw, kht, dots, hskt] = await Promise.all([
    repo.lenhTheoCongDoan(phanInId), repo.keHoachTamTheoCongDoan(phanInId), repo.dotChoThemCongDoan(phanInId),
    hsktRepo.activeHsktOfPhanIn(phanInId),
  ]);
  const chan = []; const canhBao = [];

  // 1) Logo + In: lệnh / kế hoạch tạm đang có (công đoạn duy nhất 'IN' của luồng Logo) thành công đoạn ép.
  const lenhDoiGd = them === L.GD_IN ? lenhRaw.filter((l) => l.gd === L.GD_IN) : [];
  lenhDoiGd.filter((l) => l.so_phan_in > 1).forEach((l) => {
    chan.push(`Lệnh ${l.ma_lenh_san_xuat} gom ${l.so_phan_in} phần in — đổi công đoạn sẽ kéo theo phần in khác, xử lý tay trước`);
  });
  const khtDoiGd = them === L.GD_IN ? kht.filter((k) => L.chuanGd(k.gd) === L.GD_IN) : [];
  if (khtDoiGd.length && !(await L.khtCoCotGd())) {
    chan.push('Kế hoạch tạm chưa có cột công đoạn (chưa chạy mig 128) — xóa kế hoạch tạm của phần in trước');
  }
  const doiSet = new Set(lenhDoiGd.map((l) => l.id));
  const keDau = keHoachCongDoanDau(lenhRaw.map((l) => (doiSet.has(l.id) ? { ...l, gd: L.GD_EP } : l)), luongMoi, epT);

  // 2) Đợt: phần của công đoạn mới (chưa release gì ⇒ còn = SL vải) + Ready (READY dùng chung theo đợt).
  const qc = dots.length ? await planningRepo.getDotVaiForCompose(dots.map((d) => d.id)) : [];
  const qcMap = new Map(qc.map((r) => [String(r.id), r]));
  const dot = dots.map((d) => {
    const thuoc = L.dotThuocGd(luongMoi, d.ma_loai, them, d.cong_doan_dot);
    return { ...d, thuoc, gd_dot: L.dotGd(luongMoi, d.ma_loai, d.cong_doan_dot), ready: !!(qcMap.get(d.id) || {}).qc_done, sl_moi: thuoc ? d.so_luong : 0 };
  });
  if (luongMoi === 'IN_KIENG') {
    dot.filter((d) => d.gd_dot === L.GD_EP && (d.ma_lenh || d.co_kht)).forEach((d) => {
      chan.push(`Đợt ${d.ma_dot_vai} (${d.ten_loai || d.ma_loai || 'không rõ loại'}) sẽ thành đợt công đoạn Ép (kiếng ủi: chỉ đợt 4I là In kiếng) `
        + `nhưng đang có ${d.ma_lenh ? `lệnh In kiếng ${d.ma_lenh}` : 'kế hoạch tạm In kiếng'} — hủy trước, hoặc giữ phần in ở luồng In kiếng`);
    });
    if (!dot.some((d) => d.gd_dot === L.GD_IN)) {
      canhBao.push('Phần in chưa có đợt 4I — sau khi thêm, công đoạn In kiếng không còn đợt nào cho tới khi ERP gửi đợt 4I');
    }
  }
  const dotLap = dot.filter((d) => d.thuoc && d.ready && d.sl_moi > 0);
  const maLenhCo = lenhRaw.map((l) => l.ma_lenh_san_xuat);
  const khongCoDotLap = 'Chưa có đợt vải đã Ready cho công đoạn mới (chờ QC READY rồi lập ở Release 1)';
  const dichKhong = {
    RELEASE_1: null,
    READY: maLenhCo.length
      ? `Phần in đã có lệnh ${maLenhCo.join(', ')} — READY dùng chung theo đợt, đưa về READY sẽ kéo cả công đoạn đang làm`
      : (dot.length ? null : 'Phần in không còn đợt vải sống'),
    TEST_RUN: them !== L.GD_IN ? `Công đoạn ${nhanThem} không qua Test Run (lập lệnh là vào thẳng Chờ chạy)` : (dotLap.length ? null : khongCoDotLap),
    CHO_CHAY: dotLap.length ? null : khongCoDotLap,
  };

  // 3) Phương án in: Logo + In ⇒ công đoạn In đọc PA hồ sơ — hồ sơ đang 0 / Ép / Logo thì phải chọn Bàn / Máy / Robot.
  let hs = null; let canPaIn = false; let goiYPa = null;
  if (hskt) {
    const dungChung = await repo.phanInCungHskt(hskt.id, phanInId);
    hs = { id: hskt.id, barcode_hskt: hskt.barcode_hskt, phuong_an_in: Number(hskt.phuong_an_in) || 0, dung_chung: dungChung };
    if (them === L.GD_IN && [0, L.PAIN_EP, L.PAIN_LOGO_CD].includes(hs.phuong_an_in)) {
      canPaIn = true;
      goiYPa = dot.reduce((s, d) => s + d.so_luong, 0) >= erpsyncRepo.NGUONG_VAI_IN_MAY ? 2 : 1;
      if (dungChung.length) {
        canhBao.push(`Hồ sơ kỹ thuật ${hs.barcode_hskt} dùng chung với ${dungChung.map((p) => p.ma_phan).join(', ')} — đổi phương án in cho công đoạn In là đổi cho cả các phần in này`);
      }
    }
  } else if (them === L.GD_IN) {
    canhBao.push('Phần in chưa có hồ sơ kỹ thuật — công đoạn In chưa có phương án in (nằm chip Khác ở Release 1)');
  }
  return {
    pin, luongCu, luongMoi, them, giuGd, epT, nhanThem, nhanGiu, lenhRaw, lenhDoiGd, khtDoiGd, keDau, dot, dotLap, dichKhong,
    hskt: hs, canPaIn, goiYPa, chan, canhBao,
  };
}

function moTaKeHoachThem(kh) {
  const L = require('../../utils/luongSanXuat');
  const tenL = (ma) => (L.LUONG_SX.find((x) => x.ma === ma) || {}).ten || ma;
  const doi = new Set(kh.lenhDoiGd.map((l) => l.id));
  return {
    ma_phan: kh.pin.ma_phan, them: kh.them, nhan_them: kh.nhanThem, nhan_giu: kh.nhanGiu, ep_truoc: kh.epT,
    luong_cu: kh.luongCu, luong_moi: kh.luongMoi, ten_luong_cu: tenL(kh.luongCu), ten_luong_moi: tenL(kh.luongMoi),
    cong_doan_dau: kh.epT ? (kh.them === L.GD_EP ? kh.nhanThem : kh.nhanGiu) : (kh.them === L.GD_IN ? kh.nhanThem : kh.nhanGiu),
    lenh: kh.keDau.map(({ l, dau, viec, nha }) => ({
      id: l.id, ma: l.ma_lenh_san_xuat, trang_thai: l.trang_thai, ma_chuyen: l.ma_chuyen, so_tem: l.so_tem,
      doi_gd: doi.has(l.id), dau, viec, nha_tem: nha ? l.so_tem_dau : 0,
    })),
    kht_doi_gd: kh.khtDoiGd.length,
    dot: kh.dot.map((d) => ({
      id: d.id, ma_dot_vai: d.ma_dot_vai, loai: d.ten_loai || d.ma_loai, so_luong: d.so_luong, ready: d.ready, thuoc: d.thuoc,
      sl_moi: d.sl_moi, ma_lenh: d.ma_lenh, co_kht: d.co_kht, lap_duoc: kh.dotLap.includes(d),
    })),
    dich_khong: kh.dichKhong,
    hskt: kh.hskt && { barcode_hskt: kh.hskt.barcode_hskt, phuong_an_in: kh.hskt.phuong_an_in, dung_chung: kh.hskt.dung_chung.map((p) => p.ma_phan) },
    can_pa_in: kh.canPaIn, goi_y_pa: kh.goiYPa,
    chan: kh.chan, canh_bao: kh.canhBao,
  };
}

async function themCongDoan(phanInId, body = {}, actorId) {
  const L = require('../../utils/luongSanXuat');
  const {
    epTruoc = false, dich = 'RELEASE_1', readyKieu = 'READY_QA', paIn, lyDo, xemTruoc = false,
    dotVaiIds, chuyenId, ngayKeHoach, tgBdKh, tgKtKh, soLuong, thoIn, dinhMuc,
  } = body || {};
  const kh = await dungKeHoachThemCongDoan(phanInId, epTruoc);
  if (xemTruoc) return { xem_truoc: true, ...moTaKeHoachThem(kh) };
  if (!DICH_THEM.includes(dich)) throw new AppError(`Màn đích không hợp lệ (${DICH_THEM.join(' · ')})`, { status: 422, errorCode: 'DICH_SAI' });
  const ly = String(lyDo || '').trim();
  if (!ly) throw new AppError('Nhập lý do thêm công đoạn', { status: 422, errorCode: 'NO_LY_DO' });
  if (kh.chan.length) throw new AppError(kh.chan.join(' · '), { status: 409, errorCode: 'KHONG_THEM_DUOC', details: kh.chan });
  if (kh.dichKhong[dich]) throw new AppError(kh.dichKhong[dich], { status: 409, errorCode: 'DICH_KHONG_DUOC' });
  if (dich === 'READY' && !READY_KIEU.includes(readyKieu)) {
    throw new AppError('Chọn READY kỹ thuật làm lại hay chỉ QA xác nhận lại', { status: 422, errorCode: 'READY_KIEU_SAI' });
  }
  let pa = null;
  if (kh.canPaIn) {
    pa = Number(paIn);
    if (!PA_CONG_DOAN_IN.includes(pa)) {
      throw new AppError('Chọn phương án in cho công đoạn In (Bàn / Máy / Robot)', { status: 422, errorCode: 'THIEU_PA_IN' });
    }
  }
  let dotLap = [];
  if (dich === 'TEST_RUN' || dich === 'CHO_CHAY') {
    const hopLe = new Set(kh.dotLap.map((d) => d.id));
    dotLap = Array.isArray(dotVaiIds) && dotVaiIds.length ? [...new Set(dotVaiIds.map(String))] : [...hopLe];
    const sai = dotLap.filter((id) => !hopLe.has(id));
    if (sai.length || !dotLap.length) {
      throw new AppError('Đợt vải chọn không lập được công đoạn mới (chưa Ready / không thuộc công đoạn này)', { status: 422, errorCode: 'DOT_SAI', details: sai });
    }
    if (!chuyenId) throw new AppError('Chọn chuyền sản xuất', { status: 422, errorCode: 'NO_CHUYEN' });
    if (!ngayKeHoach) throw new AppError('Chọn ngày sản xuất kế hoạch', { status: 422, errorCode: 'NO_NGAY' });
  }
  const lyDoGhi = `Thêm công đoạn ${kh.nhanThem} (${kh.pin.ma_phan}): ${ly}`;

  // 1) Đổi luồng + công đoạn lệnh / kế hoạch tạm — 1 transaction, đọc lại sau khi khóa phần in.
  const coCotKht = await L.khtCoCotGd();
  const tx = await withTransaction(async (client) => {
    const { rows: [cu] } = await client.query('SELECT luong_sx, ep_truoc FROM phan_in WHERE id = $1 FOR UPDATE', [phanInId]);
    if (!cu || L.chuanLuong(cu.luong_sx) !== kh.luongCu) {
      throw new AppError('Luồng của phần in vừa bị đổi ở nơi khác — tải lại rồi làm lại', { status: 409, errorCode: 'DA_DOI' });
    }
    let lenhDoi = [];
    if (kh.them === L.GD_IN) {
      lenhDoi = (await repo.lenhTheoCongDoan(phanInId, client)).filter((l) => l.gd === L.GD_IN);
      if (lenhDoi.some((l) => l.so_phan_in > 1)) {
        throw new AppError('Vừa có lệnh gom nhiều phần in — tải lại rồi xem trước lại', { status: 409, errorCode: 'DA_DOI' });
      }
      await repo.doiGdLenhTx(client, lenhDoi.map((l) => l.id), L.GD_EP, actorId);
    }
    const khtDoi = kh.them === L.GD_IN && coCotKht
      ? await repo.doiKeHoachTamGdTx(client, kh.khtDoiGd.map((k) => k.id), L.GD_IN, L.GD_EP) : 0;
    await repo.datLuongPhanInTx(client, phanInId, kh.luongMoi, kh.epT, actorId);
    const d = await danhLaiCongDoanDauTx(client, await repo.lenhTheoCongDoan(phanInId, client), kh.luongMoi, kh.epT, actorId);
    await repo.ghiAudit('phan_in', phanInId, 'THEM_CONG_DOAN', { luong_sx: kh.luongCu, ep_truoc: !!cu.ep_truoc }, {
      them: kh.them, luong_sx: kh.luongMoi, ep_truoc: kh.epT, dich, ly_do: ly,
      lenh_doi_gd: lenhDoi.map((l) => l.id), lenh_doi_gd_ma: lenhDoi.map((l) => l.ma_lenh_san_xuat), kht_doi_gd: khtDoi,
      so_lenh_doi_cong_doan_dau: d.doiLenh, lenh_giu: d.giu, tem_nha_kcs: d.temNha.map((t) => t.ma_tem),
    }, actorId, client);
    return { lenhDoi, khtDoi, ...d };
  });
  sockets.emit('workflow:updated', { phanInId, action: 'them-cong-doan' });
  if (tx.temNha.length) sockets.emit('production:updated', { phanInId, action: 'nha-tem-cong-doan-dau' });

  // 2) Phương án in của công đoạn In (Logo + In).
  let hsktKq = null;
  if (pa) {
    try {
      const r = await require('../hskt/hskt.service').changePhuongAnIn(kh.hskt.id, pa, actorId);
      hsktKq = { doi: true, phuong_an_in: pa, barcode_moi: r.barcode_moi };
    } catch (e) {
      console.error(`[quan-tri-phan-in] ✗ Thêm công đoạn ${kh.pin.ma_phan}: không đổi được PA hồ sơ: ${e.message}`);
      hsktKq = { doi: false, loi: e.message };
    }
  }

  // 3) Đặt công đoạn mới vào màn đích.
  const dichKq = { dich };
  try {
    if (dich === 'READY') {
      dichKq.dot_ready = [];
      for (const d of kh.dot) {
        // eslint-disable-next-line no-await-in-loop
        await datGiaiDoan(d.id, { dich: readyKieu, lyDo: lyDoGhi }, actorId);
        dichKq.dot_ready.push(d.ma_dot_vai);
      }
    } else if (dich === 'TEST_RUN' || dich === 'CHO_CHAY') {
      const sl = soLuong == null || soLuong === '' ? null : Number(soLuong);
      const r = await planningService.createRelease1({
        chuyenId, ngayKeHoach, tgBdKh: tgBdKh || null, tgKtKh: tgKtKh || null, thoIn, dinhMuc, soLuongRelease: sl,
        ...(kh.them === L.GD_EP ? { dotVaiIdsEp: dotLap } : { dotVaiIds: dotLap }),
      }, actorId, { nguonErp: 'THEM_CONG_DOAN' });
      const lenhMoi = r.created_summary || [];
      const sangChoChay = dich === 'CHO_CHAY' && kh.them === L.GD_IN
        ? await dayLenhSangChoChay(lenhMoi, 'THEM_CONG_DOAN', lyDoGhi, actorId) : new Set();
      dichKq.lenh = lenhMoi.map((c) => ({ id: c.id, ma: c.ma_lenh_san_xuat, trang_thai: sangChoChay.has(c.id) ? 'RELEASE_2' : c.trang_thai }));
      dichKq.ke_hoach_tam = r.ke_hoach_tam_count || 0;
    }
  } catch (e) {
    console.error(`[quan-tri-phan-in] ✗ Thêm công đoạn ${kh.pin.ma_phan}: chưa đặt được vào ${dich}: ${e.message}`);
    dichKq.loi = e.message;
  }
  sockets.emit('dashboard:refresh', {});
  return {
    ...moTaKeHoachThem(kh), xem_truoc: false,
    ket_qua: {
      lenh_doi_gd: tx.lenhDoi.map((l) => l.ma_lenh_san_xuat), kht_doi_gd: tx.khtDoi, so_lenh_doi_cong_doan_dau: tx.doiLenh,
      lenh_giu: tx.giu, tem_nha_kcs: tx.temNha.length, hskt: hsktKq, dich: dichKq,
    },
  };
}

// Lệnh vừa lập (RELEASE_1) ⇒ quản trị bỏ Test Run, đưa thẳng Chờ chạy (RELEASE_2) — KHÔNG phải "Không test run" của QA.
//   Dùng chung Thêm công đoạn · Thêm đợt In kiếng. Trả Set id lệnh đã chuyển.
async function dayLenhSangChoChay(lenhMoi, nguon, lyDoGhi, actorId) {
  const daChuyen = new Set();
  for (const c of (lenhMoi || []).filter((x) => x.trang_thai === 'RELEASE_1')) {
    // eslint-disable-next-line no-await-in-loop
    await withTransaction(async (client) => {
      await planningRepo.setLenhTrangThai(client, c.id, 'RELEASE_2', actorId);
      await planningRepo.logPlanChange(client, c.id, 'RELEASE_2', { trang_thai: 'RELEASE_1' },
        { trang_thai: 'RELEASE_2', nguon, bo_test_run_quan_tri: true, ly_do: lyDoGhi }, actorId);
    });
    // eslint-disable-next-line no-await-in-loop
    await tracking.moveByLenh(c.id, 'RELEASE_2', actorId);
    sockets.emit('workflow:updated', { lenhId: c.id, stage: 'RELEASE_2' });
    daChuyen.add(c.id);
  }
  return daChuyen;
}

// ─── THÊM ĐỢT VẢI TAY + ĐẶT VÀO MÀN (19/11/2026, người dùng: "phần in hiện trên MES có ép rồi mà ERP lỗi không lên được phần
//   in … không chỉ kiếng mà logo hay ép hay in đều thêm được, cho nhập nhanh theo code phần") ───
// ERP lỗi không gửi 1 đợt vải ⇒ quản trị TẠO TAY 1 đợt (mã `MAN-…`) cho phần in ĐÃ CÓ (tìm theo code phần — trang Quản trị
//   phần in / Nhập tay › "Thêm đợt theo code phần") rồi đặt vào màn:
//   READY_KT (Kỹ thuật làm — như ERP `KTCankiemtra=1`) · READY_QA (KT coi như xong, chờ QA) · RELEASE_1 (đã Ready — như
//   `KTCankiemtra=0`, `simulateReadyDone`) · TEST_RUN / CHO_CHAY (Ready + `planning.createRelease1` lập lệnh ngay; Chờ chạy
//   = quản trị bỏ Test Run cho lệnh In). Bước đặt màn lỗi KHÔNG xóa đợt đã tạo (trả `ket_qua.dich.loi`).
// ⚠⚠ CÔNG ĐOẠN của đợt CHỌN TỰ DO (25/11/2026, người dùng: "chỗ thêm đợt vải cho phép đánh dấu đợt đó là in hay kiếng hay logo
//   hay ép gì cũng đều được") — trong các công đoạn PHẦN IN ĐANG CÓ (người dùng chốt; thiếu ⇒ "Thêm 1 công đoạn" đổi luồng):
//   FE có 4 nút In · In kiếng · Logo · Ép (+ "Cả 2" với phần in 2 công đoạn), nút ngoài luồng bị khóa. KHÔNG còn phụ thuộc
//   LOẠI đợt (vd đợt 5I bổ sung cho In kiếng, đợt chỉ Logo của In + Logo). Phần in 2 công đoạn ⇒ ghi `dot_vai_ve.cong_doan_dot`
//   (mig 139; chưa chạy mig ⇒ chỉ chọn được đúng công đoạn luật loại đợt cho ra). Body cũ không gửi `congDoanDot` ⇒ luật cũ
//   theo loại đợt (kiếng ủi 4I = In kiếng, loại khác = Ép · In + Logo cả 2).
// ERP sau này gửi đợt thật ⇒ vào như đợt MỚI (người dùng chốt) — đợt tạo tay thừa thì hủy ở tab Hủy đợt vải.
const DICH_DOT_TAY = ['READY_KT', 'READY_QA', 'RELEASE_1', 'TEST_RUN', 'CHO_CHAY'];
const LOAI_DOT_MAC_DINH = 'SO_LUONG';

// Các lựa chọn công đoạn của đợt tay theo luồng phần in. `ma` = giá trị `cong_doan_dot` (null = phần in 1 công đoạn);
//   `nut` = nút FE (IN · KIENG · LOGO · EP · CA_HAI); `loai_goi_y` = loại đợt mặc định khi chọn (kiếng ủi In kiếng ⇒ 4I).
function luaChonCongDoan(L, luong, paEp) {
  const tenEp = luong === 'IN_KIENG' ? 'Ép' : (L.nhanCongDoan(luong, L.GD_EP, paEp) || 'Logo');
  const nutEp = tenEp === 'Ép' ? 'EP' : 'LOGO';
  const mot = (nut, ten) => [{ ma: null, nut, ten, gd: [L.GD_IN], loai_goi_y: LOAI_DOT_MAC_DINH }];
  if (luong === 'IN_KIENG') {
    return [
      { ma: L.GD_IN, nut: 'KIENG', ten: 'In kiếng', gd: [L.GD_IN], loai_goi_y: L.LOAI_DOT_KIENG },
      { ma: L.GD_EP, nut: 'EP', ten: 'Ép', gd: [L.GD_EP], loai_goi_y: LOAI_DOT_MAC_DINH },
      { ma: L.CD_CA_HAI, nut: 'CA_HAI', ten: 'In kiếng + Ép', gd: [L.GD_IN, L.GD_EP], loai_goi_y: LOAI_DOT_MAC_DINH },
    ];
  }
  if (luong === 'IN_EP') {
    return [
      { ma: L.GD_IN, nut: 'IN', ten: 'In', gd: [L.GD_IN], loai_goi_y: LOAI_DOT_MAC_DINH },
      { ma: L.GD_EP, nut: nutEp, ten: tenEp, gd: [L.GD_EP], loai_goi_y: LOAI_DOT_MAC_DINH },
      { ma: L.CD_CA_HAI, nut: 'CA_HAI', ten: `In + ${tenEp}`, gd: [L.GD_IN, L.GD_EP], loai_goi_y: LOAI_DOT_MAC_DINH },
    ];
  }
  if (luong === 'LOGO') return mot(Number(paEp) === L.PAIN_EP ? 'EP' : 'LOGO', Number(paEp) === L.PAIN_EP ? 'Ép' : 'Logo');
  if (luong === 'KIENG_KHONG_EP') return mot('KIENG', 'In kiếng');
  return mot('IN', 'In');
}
// Nhãn công đoạn của 1 đợt đang có — đánh dấu `cong_doan_dot` (mig 139) thắng loại đợt.
function tenCongDoanDot(L, luong, maLoai, cdDot, paEp) {
  if (!L.laHaiCongDoan(luong)) return congDoanCuaDot(L, luong, maLoai, paEp).map((c) => c.ten).join(' + ');
  const g = L.dotGd(luong, maLoai, cdDot);
  return (g ? [g] : [L.GD_IN, L.GD_EP]).map((x) => L.nhanCongDoan(luong, x, paEp)).join(' + ');
}

// Công đoạn (mã gd + nhãn) mà 1 đợt loại `maLoai` mang, theo luồng phần in.
function congDoanCuaDot(L, luong, maLoai, paEp) {
  if (luong === 'IN_KIENG') return L.dotGd(luong, maLoai) === L.GD_IN ? [{ gd: L.GD_IN, ten: 'In kiếng' }] : [{ gd: L.GD_EP, ten: 'Ép' }];
  if (luong === 'IN_EP') return [{ gd: L.GD_IN, ten: 'In' }, { gd: L.GD_EP, ten: L.nhanCongDoan(luong, L.GD_EP, paEp) || 'Logo' }];
  if (luong === 'LOGO') return [{ gd: L.GD_IN, ten: 'Logo/Ép' }];
  if (luong === 'KIENG_KHONG_EP') return [{ gd: L.GD_IN, ten: 'In kiếng' }];
  return [{ gd: L.GD_IN, ten: 'In' }];
}

async function dungKeHoachDotTay(phanInId) {
  const L = require('../../utils/luongSanXuat');
  const pin = await repo.getPhanIn(phanInId);
  if (!pin) throw new AppError('Phần in không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const luong = L.chuanLuong(pin.luong_sx);
  const [{ rows: dots }, { rows: loais }, paEp] = await Promise.all([
    query(`SELECT dv.id::text AS id, dv.ma_dot_vai, ldv.ma_loai, ldv.ten_loai, COALESCE(dv.so_luong_vai_ve,0)::int AS so_luong,
                  to_jsonb(dv)->>'cong_doan_dot' AS cong_doan_dot,
                  to_char(dv.han_giao_hang, 'YYYY-MM-DD') AS han_giao_hang, dv.barcode, dv.nha_gia_cong, dv.du_an,
                  to_char(dv.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY HH24:MI') AS tao_luc
             FROM dot_vai_ve dv LEFT JOIN loai_dot_vai ldv ON ldv.id = dv.loai_dot_vai_id
            WHERE dv.phan_in_id = $1 AND dv.trang_thai NOT IN ('DA_HUY','DA_GOP')
            ORDER BY dv.created_date, dv.ma_dot_vai`.replace(/\s+/g, ' '), [phanInId]),
    query('SELECT id, ma_loai, ten_loai FROM loai_dot_vai ORDER BY ma_loai'),
    Promise.resolve().then(() => L.paCongDoanEp(pin.tinh_chat_in)).catch(() => null),
  ]);
  const loai = loais.map((l) => ({ ...l, cong_doan: congDoanCuaDot(L, luong, l.ma_loai, paEp) }));
  // Nút chọn nhanh theo CÔNG ĐOẠN (FE) ⇒ loại đợt mặc định tương ứng.
  const nhanh = luong === 'IN_KIENG'
    ? [{ ma: 'IN_KIENG', ten: 'In kiếng (đợt 4I)' }, { ma: LOAI_DOT_MAC_DINH, ten: 'Ép (đợt 3I)' }]
    : [{ ma: LOAI_DOT_MAC_DINH, ten: congDoanCuaDot(L, luong, LOAI_DOT_MAC_DINH, paEp).map((c) => c.ten).join(' + ') }];
  const canhBao = [];
  if (!dots.length) canhBao.push('Phần in không còn đợt vải sống — nhập SL + hạn giao tay');
  const chon = luaChonCongDoan(L, luong, paEp).map((c) => ({ ...c, qua_test_run: c.gd.some((g) => !L.boQuaTestRun(luong, g)) }));
  const coCot = await L.coCotCdDot();
  return { pin, luong, tenLuong: (L.LUONG_SX.find((x) => x.ma === luong) || {}).ten || luong, dots, loai, nhanh, paEp, canhBao, chon, coCot };
}

async function themDotVai(phanInId, body = {}, actorId) {
  const L = require('../../utils/luongSanXuat');
  const {
    xemTruoc = false, dotNguonId, loaiDot = LOAI_DOT_MAC_DINH, congDoanLap = 'CA_HAI', soLuong, hanGiao, barcode,
    dich = 'READY_KT', lyDo, chuyenId, ngayKeHoach, tgBdKh, tgKtKh, thoIn, dinhMuc,
  } = body || {};
  const kh = await dungKeHoachDotTay(phanInId);
  const haiCd = L.laHaiCongDoan(kh.luong);
  const moTa = {
    phan_in_id: kh.pin.id, ma_phan: kh.pin.ma_phan, tinh_chat_in: kh.pin.tinh_chat_in, luong_sx: kh.luong, ten_luong: kh.tenLuong,
    dot: kh.dots.map((d) => ({ id: d.id, ma_dot_vai: d.ma_dot_vai, ma_loai: d.ma_loai, loai: d.ten_loai || d.ma_loai,
      so_luong: d.so_luong, han_giao_hang: d.han_giao_hang, barcode: d.barcode, tao_luc: d.tao_luc,
      cong_doan: tenCongDoanDot(L, kh.luong, d.ma_loai, d.cong_doan_dot, kh.paEp) })),
    loai_dot: kh.loai.map((l) => ({ ma: l.ma_loai, ten: l.ten_loai, cong_doan: l.cong_doan.map((c) => c.ten).join(' + '),
      gd: l.cong_doan.map((c) => c.gd), qua_test_run: l.cong_doan.some((c) => !L.boQuaTestRun(kh.luong, c.gd)) })),
    nhanh: kh.nhanh, hai_cong_doan_chung: kh.luong === 'IN_EP',
    // 25/11/2026: lựa chọn công đoạn tự do (4 nút FE) — `co_cot_cong_doan` = đã chạy mig 139 (chưa ⇒ chỉ chọn theo luật loại đợt).
    cong_doan_chon: kh.chon, cong_doan_mac_dinh: (kh.chon.find((c) => c.ma === L.CD_CA_HAI && kh.luong === 'IN_EP') || kh.chon[0]).ma,
    co_cot_cong_doan: kh.coCot,
    goi_y_nguon: kh.dots.length ? kh.dots[kh.dots.length - 1].id : null,
    dich_ho_tro: DICH_DOT_TAY, chan: [], canh_bao: kh.canhBao,
  };
  if (xemTruoc) return { xem_truoc: true, ...moTa };

  if (!DICH_DOT_TAY.includes(dich)) throw new AppError(`Màn đích không hợp lệ (${DICH_DOT_TAY.join(' · ')})`, { status: 422, errorCode: 'DICH_SAI' });
  const ly = String(lyDo || '').trim();
  if (!ly) throw new AppError('Nhập lý do (vd ERP lỗi không gửi đợt vải)', { status: 422, errorCode: 'NO_LY_DO' });
  const loaiGoc = kh.loai.find((l) => l.ma_loai === String(loaiDot));
  if (!loaiGoc) throw new AppError('Loại đợt vải không hợp lệ', { status: 422, errorCode: 'LOAI_DOT_SAI' });
  // Công đoạn chọn (mig 139): có khóa `congDoanDot` ⇒ chọn tự do trong công đoạn của luồng; thiếu khóa ⇒ luật cũ theo loại đợt.
  let cdDot = null;
  let cdChon = null;
  if (haiCd && body && Object.prototype.hasOwnProperty.call(body, 'congDoanDot')) {
    cdChon = kh.chon.find((c) => c.ma === L.chuanCdDot(body.congDoanDot));
    if (!cdChon) {
      throw new AppError(`Phần in ${kh.pin.ma_phan} (${kh.tenLuong}) không có công đoạn này — chọn ${kh.chon.map((c) => c.ten).join(' / ')}, `
        + 'hoặc dùng "Thêm 1 công đoạn" trước', { status: 422, errorCode: 'CONG_DOAN_SAI' });
    }
    cdDot = cdChon.ma;
    // Chưa chạy mig 139 ⇒ chỉ nhận lựa chọn trùng luật loại đợt (khỏi ghi cột) — khác thì báo, đừng âm thầm ra công đoạn khác.
    if (!kh.coCot) {
      if (L.dotGd(kh.luong, loaiGoc.ma_loai) !== L.dotGd(kh.luong, loaiGoc.ma_loai, cdDot)) {
        throw new AppError(`Chưa chạy migration 139 nên đợt loại ${loaiGoc.ten_loai} chỉ là công đoạn ${loaiGoc.cong_doan.map((c) => c.ten).join(' + ')}`,
          { status: 409, errorCode: 'CHUA_MIGRATION_139' });
      }
      cdDot = null;
    }
  }
  const loai = cdChon ? { ...loaiGoc, cong_doan: cdChon.gd.map((g) => ({ gd: g, ten: L.nhanCongDoan(kh.luong, g, kh.paEp) })) } : loaiGoc;
  const nguon = dotNguonId ? kh.dots.find((d) => d.id === String(dotNguonId)) : null;
  if (dotNguonId && !nguon) throw new AppError('Đợt nguồn không thuộc phần in này / đã hủy', { status: 422, errorCode: 'DOT_NGUON_SAI' });
  const sl = soLuong == null || soLuong === '' ? (nguon ? nguon.so_luong : NaN) : Number(soLuong);
  if (!Number.isInteger(sl) || sl <= 0) throw new AppError('SL vải của đợt phải là số nguyên > 0', { status: 422, errorCode: 'SL_SAI' });
  const hg = String(hanGiao || (nguon && nguon.han_giao_hang) || '').slice(0, 10);
  if (hg && !/^\d{4}-\d{2}-\d{2}$/.test(hg)) throw new AppError('Hạn giao không hợp lệ', { status: 422, errorCode: 'HAN_GIAO_SAI' });
  const bc = String(barcode == null ? ((nguon && nguon.barcode) || '') : barcode).trim() || null;

  // Công đoạn lập lệnh (Test Run / Chờ chạy): đợt mang cả 2 công đoạn chọn được 1 hoặc cả 2; còn lại = công đoạn của đợt.
  const gdDot = loai.cong_doan.map((c) => c.gd);
  const gdLap = gdDot.length > 1 && congDoanLap !== 'CA_HAI' ? gdDot.filter((g) => g === congDoanLap) : gdDot;
  const canLenh = dich === 'TEST_RUN' || dich === 'CHO_CHAY';
  if (canLenh) {
    if (!gdLap.length) throw new AppError('Chọn công đoạn lập lệnh', { status: 422, errorCode: 'CONG_DOAN_SAI' });
    if (dich === 'TEST_RUN' && gdLap.every((g) => L.boQuaTestRun(kh.luong, g))) {
      throw new AppError(`Công đoạn ${loai.cong_doan.map((c) => c.ten).join(' + ')} không qua Test Run — chọn Chờ chạy`,
        { status: 422, errorCode: 'KHONG_QUA_TEST_RUN' });
    }
    if (!chuyenId) throw new AppError('Chọn chuyền sản xuất', { status: 422, errorCode: 'NO_CHUYEN' });
    if (!ngayKeHoach) throw new AppError('Chọn ngày sản xuất kế hoạch', { status: 422, errorCode: 'NO_NGAY' });
  }
  const tenCd = loai.cong_doan.map((c) => c.ten).join(' + ');
  const lyDoGhi = `Thêm đợt vải tay ${loai.ten_loai} — ${tenCd} (${kh.pin.ma_phan}): ${ly}`;

  // 1) Tạo đợt — khóa phần in, đọc lại luồng (công đoạn của đợt phụ thuộc luồng).
  const dot = await withTransaction(async (client) => {
    const { rows: [p] } = await client.query('SELECT luong_sx FROM phan_in WHERE id = $1 FOR UPDATE', [phanInId]);
    if (!p || L.chuanLuong(p.luong_sx) !== kh.luong) throw new AppError('Luồng của phần in vừa bị đổi — tải lại', { status: 409, errorCode: 'DA_DOI' });
    const ma = `MAN-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    const ghiCd = !!cdDot; // phần in 2 công đoạn + có cột (mig 139) ⇒ lưu công đoạn chọn
    const { rows: [d] } = await client.query(
      `INSERT INTO dot_vai_ve (phan_in_id, ma_dot_vai, so_luong_vai_ve, ngay_vai_ve, han_giao_hang, loai_dot_vai_id, barcode,
         nha_gia_cong, du_an, kt_can_kiem_tra, ghi_chu, trang_thai, tg_chuyen_ready, created_by${ghiCd ? ', cong_doan_dot' : ''})
       VALUES ($1, $2, $3, (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, $4::date, $5, $6, $7, $8, $9, $10, 'NHAN_VAI', clock_timestamp(), $11${ghiCd ? ', $12' : ''})
       RETURNING id::text AS id, ma_dot_vai`.replace(/\s+/g, ' '),
      [phanInId, ma, sl, hg || null, loai.id, bc, nguon ? nguon.nha_gia_cong : null, nguon ? nguon.du_an : null,
        dich === 'READY_KT', `[Quản trị phần in] ${lyDoGhi}`, actorId, ...(ghiCd ? [cdDot] : [])]);
    const ghi = {
      dot_vai_id: d.id, ma_dot_vai: d.ma_dot_vai, loai_dot: loai.ma_loai, cong_doan: tenCd, cong_doan_dot: cdDot, so_luong: sl,
      han_giao_hang: hg || null, barcode: bc, dot_nguon: nguon ? nguon.ma_dot_vai : null, dich, cong_doan_lap: canLenh ? gdLap : null, ly_do: ly,
    };
    await repo.ghiAudit('phan_in', phanInId, 'THEM_DOT_VAI_TAY', null, ghi, actorId, client);
    await repo.ghiAudit('dot_vai_ve', d.id, 'TAO_TAY_DOT_VAI', null, { ...ghi, phan_in_id: phanInId, ma_phan: kh.pin.ma_phan }, actorId, client);
    return d;
  });
  try { await erpsyncRepo.moLaiPhanInCoDotMoi(phanInId, [dot.id], actorId); } catch (e) { /* phần in đang sống — bỏ qua */ }
  await tracking.moveDotVaiTo([dot.id], 'READY', actorId);

  // 2) Đặt vào màn đích.
  const dichKq = { dich };
  try {
    if (dich === 'READY_KT') {
      if (await erpsyncRepo.canLamLaiReady(phanInId, [dot.id])) await erpsyncRepo.flagLamLaiReady(phanInId);
    } else {
      await erpsyncRepo.simulateReadyDone(phanInId, [dot.id]);
      if (dich === 'READY_QA') {
        await datGiaiDoan(dot.id, { dich: 'READY_QA', lyDo: lyDoGhi }, actorId);
      } else if (canLenh) {
        const r = await planningService.createRelease1({
          chuyenId, ngayKeHoach, tgBdKh: tgBdKh || null, tgKtKh: tgKtKh || null, thoIn, dinhMuc, soLuongRelease: null,
          ...(gdLap.includes(L.GD_IN) ? { dotVaiIds: [dot.id] } : {}),
          ...(gdLap.includes(L.GD_EP) ? { dotVaiIdsEp: [dot.id] } : {}),
        }, actorId, { nguonErp: 'THEM_DOT_VAI_TAY' });
        const lenhMoi = r.created_summary || [];
        // Chờ chạy: lệnh còn ở Release 1 (công đoạn In qua Test Run) ⇒ quản trị bỏ Test Run. Lệnh Ép/Logo vốn đã ở Chờ chạy.
        const sang = dich === 'CHO_CHAY' ? await dayLenhSangChoChay(lenhMoi, 'THEM_DOT_VAI_TAY', lyDoGhi, actorId) : new Set();
        dichKq.lenh = lenhMoi.map((c) => ({ id: c.id, ma: c.ma_lenh_san_xuat, trang_thai: sang.has(c.id) ? 'RELEASE_2' : c.trang_thai }));
        dichKq.ke_hoach_tam = r.ke_hoach_tam_count || 0;
        if (r.ep_loi) dichKq.loi = `Lệnh công đoạn ép: ${r.ep_loi}`;
      }
    }
  } catch (e) {
    console.error(`[quan-tri-phan-in] ✗ Thêm đợt tay ${kh.pin.ma_phan}: chưa đặt được vào ${dich}: ${e.message}`);
    dichKq.loi = e.message;
  }
  sockets.emit('ready:confirmed', { phanInId });
  sockets.emit('workflow:updated', { phanInId, action: 'them-dot-vai' });
  sockets.emit('dashboard:refresh', {});
  return {
    ...moTa, xem_truoc: false,
    ket_qua: { dot_vai_id: dot.id, ma_dot_vai: dot.ma_dot_vai, so_luong: sl, loai: loai.ten_loai, cong_doan: tenCd, dich: dichKq },
  };
}

// ⚠⚠ ĐÁNH DẤU CÔNG ĐOẠN CỦA ĐỢT ĐANG CÓ (mig 139, 25/11/2026 — người dùng chốt "đợt cũ thiếu công đoạn thì đánh dấu riêng từng
//   đợt ở Quản trị phần in"): `cong_doan_dot` IN · EP_UI · CA_HAI · '' (= theo loại đợt). Chỉ phần in 2 công đoạn. Đổi công
//   đoạn (kể cả đổi LOẠI đợt của kiếng ủi khi đợt chưa đánh dấu — loại quyết định công đoạn) mà BỎ MẤT công đoạn đang có lệnh
//   sống / kế hoạch tạm của đợt ⇒ 409 `CONG_DOAN_DANG_DUNG` (hủy lệnh / KH tạm trước). Thêm công đoạn (vd Ép → Cả 2) luôn được —
//   READY theo đợt dùng chung nên công đoạn mới thừa hưởng trạng thái Ready của đợt. Giá trị không đổi ⇒ gỡ khóa khỏi patch
//   (form gửi đủ mọi trường mỗi lần lưu). Trả patch đã chuẩn hóa.
async function kiemCongDoanDot(truoc, patch, { xetLoai = false } = {}) {
  const L = require('../../utils/luongSanXuat');
  const coCd = Object.prototype.hasOwnProperty.call(patch, 'cong_doan_dot');
  const cdTruoc = L.chuanCdDot(truoc.cong_doan_dot);
  let cdSau = cdTruoc;
  if (coCd) {
    const raw = patch.cong_doan_dot == null ? '' : String(patch.cong_doan_dot).trim();
    if (raw && !L.chuanCdDot(raw)) throw new AppError('Công đoạn của đợt không hợp lệ (IN · EP_UI · CA_HAI)', { status: 422, errorCode: 'CONG_DOAN_SAI' });
    cdSau = L.chuanCdDot(raw);
    if (cdSau === cdTruoc) delete patch.cong_doan_dot;
    else patch.cong_doan_dot = cdSau;
  }
  const doiLoai = xetLoai && 'loai_dot_vai_id' in patch && String(patch.loai_dot_vai_id || '') !== String(truoc.loai_dot_vai_id || '');
  if (!('cong_doan_dot' in patch) && !doiLoai) return patch;

  const { rows: [p] } = await query('SELECT luong_sx, ma_phan, tinh_chat_in FROM phan_in WHERE id = $1', [truoc.phan_in_id]);
  const luong = L.chuanLuong(p && p.luong_sx);
  if ('cong_doan_dot' in patch) {
    if (!(await L.coCotCdDot())) throw new AppError('Chưa chạy migration 139 nên chưa đánh dấu được công đoạn của đợt', { status: 409, errorCode: 'CHUA_MIGRATION_139' });
    if (cdSau && !L.laHaiCongDoan(luong)) {
      throw new AppError(`Phần in ${p ? p.ma_phan : ''} chỉ có 1 công đoạn — muốn thêm công đoạn dùng "Thêm 1 công đoạn"`, { status: 422, errorCode: 'MOT_CONG_DOAN' });
    }
  }
  if (!L.laHaiCongDoan(luong)) return patch;
  const maLoai = async (id) => {
    if (!id) return null;
    const { rows } = await query('SELECT ma_loai FROM loai_dot_vai WHERE id = $1', [id]);
    return rows[0] ? rows[0].ma_loai : null;
  };
  const gds = (g) => (g ? [g] : [L.GD_IN, L.GD_EP]);
  const gTruoc = L.dotGd(luong, await maLoai(truoc.loai_dot_vai_id), cdTruoc);
  const gSau = L.dotGd(luong, await maLoai(doiLoai ? patch.loai_dot_vai_id : truoc.loai_dot_vai_id), cdSau);
  const bo = gds(gTruoc).filter((g) => !gds(gSau).includes(g));
  if (!bo.length) return patch;
  const dung = (await repo.congDoanDangDungCuaDot(truoc.id)).filter((x) => bo.includes(x.gd));
  if (dung.length) {
    const paEp = await L.paCongDoanEp(p && p.tinh_chat_in).catch(() => null);
    const ten = (g) => L.nhanCongDoan(luong, g, paEp) || g;
    throw new AppError(`Đợt ${truoc.ma_dot_vai} đang có ${[...new Set(dung.map((x) => `${x.ma} (${ten(x.gd)})`))].join(', ')} — đổi sẽ bỏ công đoạn `
      + `${bo.map(ten).join(' + ')} của đợt. Hủy lệnh / kế hoạch tạm của công đoạn đó trước`, { status: 409, errorCode: 'CONG_DOAN_DANG_DUNG' });
  }
  return patch;
}

async function datKhoaErp(phanInId, khoa, actorId) {
  const pin = await repo.getPhanIn(phanInId);
  if (!pin) throw new AppError('Phần in không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const doi = await khoaErp.datKhoa(phanInId, !!khoa, actorId,
    { lyDo: khoa ? 'Khóa tay ở Quản trị phần in' : 'Mở khóa ở Quản trị phần in' });
  return { phan_in_id: phanInId, khoa_erp: !!khoa, doi };
}

async function suaDotVai(dotVaiId, patchVao, actorId, opts = {}) {
  const truoc = await repo.getDotVaiRaw(dotVaiId);
  if (!truoc) throw new AppError('Đợt vải không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  // Đổi loại đợt chỉ chặn ở trang Quản trị phần in (`opts.khoa`) — đường GN / ERP dùng chung hàm này giữ hành vi cũ.
  const patch = await kiemCongDoanDot(truoc, { ...(patchVao || {}) }, { xetLoai: !!opts.khoa });

  // ⚠ Guard SL vải về (25/11/2026 — `repo.mucToiThieuDotVai`): không hạ xuống dưới
  //   · SL ĐÃ RELEASE của chính đợt (mỗi công đoạn, chia số đầu BTP) — hạ nữa là release vượt sức chứa;
  //   · SL ĐÃ IN TEM của lệnh mà đợt nằm MỘT MÌNH (tem không lưu đợt ⇒ lệnh gộp nhiều đợt giữ "đã in" ở mức lệnh).
  //   Bản cũ cộng mọi tem của lệnh gộp cho từng đợt ⇒ không hạ được đợt bổ sung (ca TN-2611-009-A06-F03-C01).
  if ('so_luong_vai_ve' in (patch || {})) {
    const moiSl = Number(patch.so_luong_vai_ve);
    if (!Number.isFinite(moiSl) || moiSl < 0) {
      throw new AppError('SL vải về phải là số ≥ 0', { status: 422, errorCode: 'INVALID_QTY' });
    }
    const ds = await repo.mucToiThieuDotVai(dotVaiId);
    const soDau = Math.max(1, Math.floor(Number(truoc.so_dau_btp) || (truoc.btp_khac_kh ? 2 : 1)));
    const relTheoCd = {};
    ds.forEach((l) => { const g = l.giai_doan === 'EP_UI' ? 'EP_UI' : 'IN'; relTheoCd[g] = (relTheoCd[g] || 0) + l.da_release; });
    const daRelease = Math.max(0, ...Object.values(relTheoCd));
    const minRelease = Math.ceil(daRelease / soDau);
    const lenhIn = ds.filter((l) => l.da_in > 0).sort((a, b) => b.da_in - a.da_in)[0];
    if (lenhIn && moiSl < lenhIn.da_in) {
      throw new AppError(`SL vải về (${moiSl}) nhỏ hơn SL đã in tem (${lenhIn.da_in}) của lệnh ${lenhIn.ma_lenh_san_xuat} (chỉ có đợt này)`,
        { status: 409, errorCode: 'DUOI_SL_DA_IN' });
    }
    if (moiSl < minRelease) {
      const dsLenh = ds.map((l) => `${l.ma_lenh_san_xuat} ${l.da_release}`).join(', ');
      throw new AppError(`SL vải về (${moiSl}) nhỏ hơn SL đã release của đợt này (${daRelease}${soDau > 1 ? ` ÷ ${soDau} đầu BTP = ${minRelease}` : ''} — `
        + `${dsLenh}) — giảm SL release trước ở Hệ thống › Cập nhật SL nhận vải / release`,
      { status: 409, errorCode: 'DUOI_SL_DA_RELEASE' });
    }
  }

  const kq = await repo.updateDotVai(dotVaiId, patch || {}, actorId);
  if (!kq) throw new AppError('Không có trường nào hợp lệ để sửa', { status: 422, errorCode: 'NO_FIELD' });
  const cu = {}; const moi = {};
  kq.cols.forEach((c) => { cu[c] = truoc[c]; moi[c] = kq.row[c]; });
  await repo.ghiAudit('dot_vai_ve', dotVaiId, 'QUAN_TRI_SUA_DOT_VAI', cu, moi, actorId);

  // ⚠⚠ ĐỔI LOẠI ĐỢT VẢI / SL VẢI VỀ ⇒ TÍNH LẠI PHƯƠNG ÁN IN (người dùng chốt 16/09/2026).
  //   · loại → BỔ SUNG  ⇒ hồ sơ phải về in BÀN ngay, không chờ job ERP 5 phút.
  //   · đổi SL vải về  ⇒ tổng của hồ sơ đổi ⇒ ngưỡng 2000 có thể lật (vốn là gap sẵn có của màn này:
  //     trước đây sửa SL ở đây thì PA in chỉ được tính lại khi job ERP chạm tới hồ sơ đó).
  // ⚠ Tái dùng ĐÚNG `erpsync.applyPainTheoSanLuong` — hàm mà job ERP và Nhập tay đang gọi; tuyệt đối
  //   đừng chép luật ra chỗ mới (nó còn lo tạo phiên bản HSKT + đổi số cuối barcode + ghi lịch sử).
  // ⚠ BEST-EFFORT: hỏng bước này KHÔNG được làm hỏng việc sửa đợt vải vừa ghi xong.
  let painMoi = null;
  if (kq.cols.includes('loai_dot_vai_id') || kq.cols.includes('so_luong_vai_ve')) {
    try {
      const hs = await hsktRepo.activeHsktOfPhanIn(truoc.phan_in_id);
      if (hs) {
        const r = await erpsyncRepo.applyPainTheoSanLuong(hs.id, actorId);
        if (r && r.doi) painMoi = r;
      }
    } catch (e) {
      console.error(`[quan-tri-phan-in] ✗ Tính lại phương án in sau khi sửa đợt vải ${dotVaiId}: ${e.message}`);
    }
  }
  const daKhoa = opts.khoa ? await khoaSauKhiSua(truoc.phan_in_id, actorId) : false;
  sockets.emit('dashboard:refresh', {});
  sockets.emit('workflow:updated', { dotVaiId });
  if (painMoi) sockets.emit('ready:confirmed', { phanInId: truoc.phan_in_id, doi_phuong_an_in: true });
  return { id: dotVaiId, cols: kq.cols, phuong_an_in_moi: painMoi, khoa_erp: daKhoa };
}

// ─── ĐẶT LẠI GIAI ĐOẠN CHO 1 ĐỢT VẢI ────────────────────────────────────────
// ⚠⚠ Giai đoạn KHÔNG phải cột — muốn đưa đợt về chặng nào thì phải dựng lại trạng thái runtime của
//   chặng đó. Bảng ánh xạ dưới đây bám đúng `utils/stage.js`:
//     READY_KT  : hủy lệnh + hủy QC + hủy CẢ Khuôn/Film/Mực   → kỹ thuật làm lại từ đầu
//     READY_QA  : hủy lệnh + hủy QC (giữ 3 mục KT)            → chỉ QC xác nhận lại
//     RELEASE_1 : hủy lệnh, GIỮ xác nhận READY                → đợt về pool Release 1
//     TEST_RUN  : hạ lệnh RELEASE_2 → RELEASE_1               → quay lại chờ test
//   Xa hơn (Release 2 / Sản xuất trở đi) CỐ Ý KHÔNG cho đặt bằng tay: chặng đó đòi phiếu/tem/sổ cái
//   số lượng, dựng tay sẽ tạo dữ liệu không có thật. Muốn tiến tới thì thao tác ở đúng màn của nó.
const DICH = {
  READY_KT: { target: 'READY', huyMucKt: true, nhan: 'READY (Kỹ thuật)' },
  READY_QA: { target: 'READY', huyMucKt: false, nhan: 'READY (QA)' },
  RELEASE_1: { target: 'RELEASE_1', huyMucKt: false, nhan: 'Release 1' },
  TEST_RUN: { target: 'TEST_RUN', huyMucKt: false, nhan: 'Test Run' },
};

async function datGiaiDoan(dotVaiId, { dich, lyDo }, actorId) {
  const cfg = DICH[dich];
  if (!cfg) {
    throw new AppError(`Đích không hợp lệ. Chỉ nhận: ${Object.keys(DICH).join(' · ')}`,
      { status: 422, errorCode: 'DICH_KHONG_HOP_LE' });
  }
  if (!String(lyDo || '').trim()) {
    throw new AppError('Phải nhập lý do', { status: 422, errorCode: 'NO_LY_DO' });
  }
  const dv = await repo.getDotVaiRaw(dotVaiId);
  if (!dv) throw new AppError('Đợt vải không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (dv.trang_thai === 'DA_HUY') {
    throw new AppError('Đợt vải đang bị hủy — mở lại đợt trước rồi mới đặt giai đoạn', { status: 409, errorCode: 'DA_HUY' });
  }

  const ds = await repo.getDotVaiList(dv.phan_in_id);
  const hang = ds.find((r) => r.id === dotVaiId);
  const lenhId = hang?.lenh_id || null;
  const truoc = hang?.giai_doan || null;

  if (cfg.target === 'TEST_RUN' && (!lenhId || hang.lenh_trang_thai !== 'RELEASE_2')) {
    throw new AppError('Chỉ hạ về Test Run được khi lệnh đang ở Release 2', { status: 409, errorCode: 'NOT_RELEASE_2' });
  }

  // 1) Đổi trạng thái lệnh (nếu đợt đang thuộc lệnh nào) — dùng CHÍNH hàm của tab Hủy lệnh sản xuất,
  //    nên mọi guard sẵn có (đã in tem / tem đã qua KCS…) vẫn được tôn trọng.
  let ketQuaLenh = null;
  if (lenhId) {
    ketQuaLenh = await planningService.rollbackLenh(
      lenhId, { target: cfg.target, lyDo: `[Quản trị phần in] ${lyDo}` }, actorId
    );
  } else if (cfg.target === 'TEST_RUN') {
    throw new AppError('Đợt vải chưa thuộc lệnh nào', { status: 409, errorCode: 'NO_LENH' });
  }

  // 2) READY (Kỹ thuật): hủy thêm 3 mục Khuôn/Film/Mực + gắn cờ làm lại.
  //    ⚠ Tái dùng `erpsync.reopenReadyForPhanIn` — đúng hàm mà luồng ERP/`traVeKyThuat` đang dùng.
  if (cfg.huyMucKt) {
    await erpsyncRepo.reopenReadyForPhanIn(dv.phan_in_id);
  }
  // 2b) READY (QA) cho đợt CHƯA có lệnh (19/10/2026 — trước đó không hủy gì): hủy QC của chính đợt; QC nằm ở dòng
  //     tổng của phần in thì hủy dòng tổng (`technical.cancelItem` — cùng guard / audit của tab Hủy xác nhận READY).
  if (!lenhId && dich === 'READY_QA') {
    try { await technicalService.cancelItem(dv.phan_in_id, 'QC_XAC_NHAN', actorId, dotVaiId); } catch (e) {
      if (e.errorCode === 'O_DONG_TONG') await technicalService.cancelItem(dv.phan_in_id, 'QC_XAC_NHAN', actorId);
      else if (e.errorCode !== 'NOT_CONFIRMED') throw e;
    }
  }

  await repo.ghiAudit('dot_vai_ve', dotVaiId, 'QUAN_TRI_DAT_GIAI_DOAN',
    { giai_doan: truoc, lenh: hang?.ma_lenh_san_xuat || null, lenh_trang_thai: hang?.lenh_trang_thai || null },
    { dich, nhan: cfg.nhan, huy_muc_kt: cfg.huyMucKt, ly_do: String(lyDo).trim() }, actorId);

  sockets.emit('ready:confirmed', { phanInId: dv.phan_in_id });
  sockets.emit('workflow:updated', { dotVaiId, stage: dich });
  sockets.emit('dashboard:refresh', {});
  return { dot_vai_id: dotVaiId, tu: truoc, den: dich, nhan: cfg.nhan, lenh: ketQuaLenh };
}

// ─── HỦY / MỞ ĐỢT VẢI (tái dùng nguyên service của tab Hủy/Mở đợt vải) ───────
async function huyDotVai(dotVaiIds, lyDo, actorId) {
  return ordersService.softDeleteDotVai(dotVaiIds, lyDo, actorId);
}
async function moDotVai(dotVaiIds, actorId) {
  return ordersService.reopenDotVai(dotVaiIds, actorId);
}

// Hủy xác nhận READY lẻ từng mục (Khuôn/Film/Mực/QC) — tiện khi chỉ cần làm lại 1 mục.
// ⚠ Gọi thẳng `technical.cancelItem`: nó đã mang sẵn guard `ALREADY_RELEASED` (mọi đợt đã release thì
//   phải hủy lệnh ở trạm sau trước), luật cascade "hủy mục KT ⇒ hủy luôn QC", audit và socket.
//   Đợt đã release mà vẫn muốn về READY thì dùng "Đặt lại giai đoạn → READY (Kỹ thuật)" — đường đó
//   hủy lệnh trước nên không vướng guard.
async function huyMucReady(phanInId, maList, actorId) {
  const ma = (Array.isArray(maList) ? maList : []).filter((m) => ['KHUON', 'FILM', 'MUC', 'QC_XAC_NHAN'].includes(m));
  if (!ma.length) throw new AppError('Chọn ít nhất một mục', { status: 422, errorCode: 'NO_ITEM' });
  const huy = []; const boQua = [];
  for (const m of ma) {
    try { await technicalService.cancelItem(phanInId, m, actorId); huy.push(m); } catch (e) {
      // Mục chưa xác nhận / đã bị cascade hủy theo mục trước → bỏ qua, không làm hỏng cả lượt.
      if (e.errorCode === 'NOT_CONFIRMED') boQua.push(m);
      else throw e;
    }
  }
  await repo.ghiAudit('phan_in', phanInId, 'QUAN_TRI_HUY_MUC_READY', {}, { muc_huy: huy, bo_qua: boQua }, actorId);
  return { phan_in_id: phanInId, muc_huy: huy, bo_qua: boQua };
}

// ═════════════════════════════════════════════════════════════════════════════
// LÙI VỀ TRẠM BẤT KỲ — THEO LỆNH (19/10/2026, người dùng chốt "lùi về bất kỳ trạm", KHÔNG tiến).
//
// Trang dựng DANH SÁCH BƯỚC HỦY từ hiện trạng của lệnh (xem trước) rồi chạy LẦN LƯỢT từ bước SAU CÙNG ngược về —
// mỗi bước gọi ĐÚNG service hủy đang chạy ngoài giao diện (cùng guard, cùng audit, cùng báo ERP hủy như các nút Hủy):
//   CHO_GIAO     ← hủy phiếu giao                           (`delivery.huyPhieuGiao`)
//   OQC          ← + bỏ tích tem giao · hủy lượt OQC          (`delivery.boTichTem` · `quality.cancelOqc`)
//   SUA          ← + hủy lượt Sửa (tự đảo tem 17)             (`quality.cancelSua`)
//   KCS          ← + hủy phân loại lỗi · hủy lượt KCS         (`phanloailoi.huy` · `quality.cancelKcs`)
//   SAN_XUAT     ← + mở lại phiếu đã hoàn tất (không có phiếu đang chạy)   (`production.reopenProduction` bỏ hạn 2 ngày)
//   CHO_SAN_XUAT ← + hủy MỌI tem in · hủy xác nhận chạy MỌI phiếu (phiếu hoàn tất: mở lại rồi hủy)
//                  (`production.cancelPrintTem` / `planning.cancelGiaCongTem` · `production.undoStartProduction`)
//   TEST_RUN · RELEASE_1 · READY_QA · READY_KT ← + `planning.rollbackLenh` (force — đã dọn sạch tem/phiếu ở trên;
//                  guard "tem đã qua KCS/OQC/giao" của nó vẫn giữ) · READY_KT thêm `erpsync.reopenReadyForPhanIn`.
// Chạy dừng ở bước lỗi đầu tiên (bước trước đó đã ghi thật — mỗi service một transaction); bấm lại là dựng kế hoạch
// MỚI từ hiện trạng nên chạy tiếp được (idempotent). Lệnh gom set cũ (nhiều phần in) ⇒ cảnh báo, ảnh hưởng cả lệnh.
// ═════════════════════════════════════════════════════════════════════════════
const DICH_LUI = [
  { v: 'CHO_GIAO', ten: 'Chờ giao (đã qua OQC)', mo_ta: 'Hủy phiếu giao' },
  { v: 'OQC', ten: 'OQC (chờ OQC)', mo_ta: 'Hủy phiếu giao · bỏ tích tem · hủy lượt OQC' },
  { v: 'SUA', ten: 'Sửa (chờ sửa)', mo_ta: '… + hủy lượt Sửa (tem 17)' },
  { v: 'KCS', ten: 'KCS (chờ kiểm)', mo_ta: '… + hủy phân loại lỗi · hủy lượt KCS' },
  { v: 'SAN_XUAT', ten: 'Đang sản xuất (giữ tem)', mo_ta: '… + mở lại phiếu đã chạy hoàn tất' },
  { v: 'CHO_SAN_XUAT', ten: 'Chờ chạy / Release 2 (chưa in tem)', mo_ta: '… + hủy MỌI tem · hủy xác nhận chạy' },
  { v: 'TEST_RUN', ten: 'Test Run', mo_ta: '… + gỡ duyệt Release 2 + gỡ kết quả test (giữ lệnh)' },
  { v: 'RELEASE_1', ten: 'Release 1', mo_ta: '… + hủy lệnh, giữ xác nhận READY' },
  { v: 'READY_QA', ten: 'READY (QA)', mo_ta: '… + hủy lệnh + hủy QC READY' },
  { v: 'READY_KT', ten: 'READY (Kỹ thuật)', mo_ta: '… + hủy lệnh + hủy QC + hủy Khuôn/Film/Mực' },
];
const THU_TU_LUI = DICH_LUI.map((d) => d.v);
const LY = (lyDo) => `[Quản trị phần in] ${lyDo}`;
const moiTruoc = (a, b) => new Date(b.created_date || b.tg) - new Date(a.created_date || a.tg); // mới nhất trước

// Hàm THUẦN: kế hoạch các bước hủy để đưa lệnh `lenhId` về `dich`, từ ảnh chụp `tc` (= `repo.toanCanh`).
function dungBuocLui(tc, lenhId, dich) {
  const i = THU_TU_LUI.indexOf(dich);
  if (i < 0) throw new AppError(`Đích không hợp lệ. Chỉ nhận: ${THU_TU_LUI.join(' · ')}`, { status: 422, errorCode: 'DICH_KHONG_HOP_LE' });
  const tu = (d) => i >= THU_TU_LUI.indexOf(d);
  const lenh = tc.lenh.find((l) => l.id === lenhId);
  if (!lenh) throw new AppError('Lệnh không thuộc phần in này (hoặc đã hủy)', { status: 404, errorCode: 'NOT_FOUND' });
  const giaCong = lenh.trang_thai === 'GIA_CONG' || lenh.ma_loai_chuyen === 'GIA_CONG';
  if (giaCong && ['SAN_XUAT', 'TEST_RUN'].includes(dich)) {
    throw new AppError('Lệnh gia công không có trạm Sản xuất / Test Run', { status: 422, errorCode: 'GIA_CONG' });
  }
  const tems = tc.tem.filter((t) => t.lenh_san_xuat_id === lenhId && t.trang_thai !== 'HUY');
  const temSet = new Set(tems.map((t) => t.id));
  const maTem = new Map(tems.map((t) => [t.id, t.ma_tem]));
  const phieu = tc.phieu.filter((p) => p.lenh_san_xuat_id === lenhId);
  const b = [];
  if (tu('CHO_GIAO')) {
    tc.giao.filter((g) => (g.tem_ids || []).some((id) => temSet.has(id))).sort(moiTruoc)
      .forEach((g) => b.push({ loai: 'PHIEU_GIAO', id: g.id, nhan: `Hủy phiếu giao ${g.ma_phieu_giao} (${g.so_luong} pcs)` }));
  }
  if (tu('OQC')) {
    tems.filter((t) => t.da_tich_giao).forEach((t) => b.push({ loai: 'TICH_GIAO', id: t.id, nhan: `Bỏ tích giao tem ${t.ma_tem}` }));
    tc.oqc.filter((o) => temSet.has(o.tem_id)).sort(moiTruoc)
      .forEach((o) => b.push({ loai: 'OQC', id: o.id, nhan: `Hủy OQC tem ${maTem.get(o.tem_id)} (qua giao ${o.sl_qua_giao ?? o.so_luong_dat ?? 0})` }));
  }
  if (tu('SUA')) {
    tc.sua.filter((s) => temSet.has(s.tem_id)).sort(moiTruoc)
      .forEach((s) => b.push({ loai: 'SUA', id: s.id, nhan: `Hủy lượt Sửa tem ${maTem.get(s.tem_id)} (đạt ${s.so_luong_sua_dat || 0}, hủy ${s.so_luong_sua_huy || 0})` }));
  }
  if (tu('KCS')) {
    tc.pll.filter((p) => temSet.has(p.tem_id))
      .forEach((p) => b.push({ loai: 'PLL', id: p.tem_id, nhan: `Hủy phân loại lỗi tem ${maTem.get(p.tem_id)}` }));
    tc.kcs.filter((k) => temSet.has(k.tem_id)).sort(moiTruoc)
      .forEach((k) => b.push({ loai: 'KCS', id: k.id, nhan: `Hủy lượt KCS tem ${maTem.get(k.tem_id)} (kiểm ${k.so_luong_kiem || 0})` }));
  }
  if (dich === 'SAN_XUAT' && !phieu.some((p) => p.trang_thai === 'DANG_CHAY')) {
    const xong = phieu.filter((p) => p.trang_thai === 'HOAN_TAT').sort(moiTruoc)[0];
    if (xong) b.push({ loai: 'MO_LAI_PHIEU', id: xong.id, nhan: `Mở lại phiếu ${xong.ma_phieu_san_xuat || ''} (về đang chạy)` });
  }
  if (tu('CHO_SAN_XUAT')) {
    tems.filter((t) => !t.tem_goc_id).sort(moiTruoc)
      .forEach((t) => b.push({ loai: giaCong ? 'TEM_GIA_CONG' : 'TEM', id: t.id, nhan: `Hủy tem ${t.ma_tem} (${t.so_luong} pcs)` }));
    if (!giaCong) {
      phieu.filter((p) => p.trang_thai === 'DANG_CHAY')
        .forEach((p) => b.push({ loai: 'HUY_CHAY', id: p.id, nhan: `Hủy xác nhận chạy phiếu ${p.ma_phieu_san_xuat || ''}` }));
      phieu.filter((p) => p.trang_thai === 'HOAN_TAT').sort(moiTruoc).forEach((p) => {
        b.push({ loai: 'MO_LAI_PHIEU', id: p.id, nhan: `Mở lại phiếu ${p.ma_phieu_san_xuat || ''}` });
        b.push({ loai: 'HUY_CHAY', id: p.id, nhan: `Hủy xác nhận chạy phiếu ${p.ma_phieu_san_xuat || ''}` });
      });
    }
  }
  if (tu('TEST_RUN')) {
    const target = dich === 'TEST_RUN' ? 'TEST_RUN' : dich === 'RELEASE_1' ? 'RELEASE_1' : 'READY';
    // Về Test Run: chỉ khi còn gì để gỡ (đã duyệt R2 / đã có kết quả test) — không thì lệnh vốn đang ở Test Run.
    const canGo = target !== 'TEST_RUN' || lenh.trang_thai !== 'RELEASE_1' || lenh.test_dat || tems.length || phieu.length;
    if (canGo) b.push({ loai: 'LENH', id: lenhId, target, nhan: `Lệnh ${lenh.ma_lenh_san_xuat} → ${DICH_LUI.find((d) => d.v === dich).ten}` });
    if (dich === 'READY_KT') b.push({ loai: 'MO_READY_KT', id: lenhId, nhan: 'Hủy Khuôn/Film/Mực — kỹ thuật làm lại' });
  }
  const canhBao = [];
  if (lenh.so_phan_in > 1) canhBao.push(`Lệnh ${lenh.ma_lenh_san_xuat} gom ${lenh.so_phan_in} phần in (${lenh.phan_in_khac}) — lùi lệnh là lùi CẢ các phần in đó`);
  return { lenh, buoc: b, canh_bao: canhBao };
}

// Chạy 1 bước — map loại → service hủy đang có.
async function chayBuoc(bu, lyDo, actorId, phanInId) {
  const ly = LY(lyDo);
  const quality = require('../quality/quality.service');
  const production = require('../production/production.service');
  switch (bu.loai) {
    case 'PHIEU_GIAO': return require('../delivery/delivery.service').huyPhieuGiao(bu.id, ly, actorId);
    case 'TICH_GIAO': return require('../delivery/delivery.service').boTichTem([bu.id], actorId);
    case 'OQC': return quality.cancelOqc(bu.id, ly, actorId);
    case 'SUA': return quality.cancelSua(bu.id, ly, actorId);
    case 'PLL': return require('../quality/phanloailoi.service').huy(bu.id, ly, actorId);
    case 'KCS': return quality.cancelKcs(bu.id, ly, actorId);
    case 'MO_LAI_PHIEU': return production.reopenProduction(bu.id, actorId, { boQuaHan: true });
    // Màn quản trị bỏ qua khóa tem 48 giờ (17/11/2026, `utils/khoaTem.js`) — như `boQuaHan` mở lại phiếu.
    case 'TEM': return production.cancelPrintTem(bu.id, ly, actorId, { boQuaKhoa: true });
    case 'TEM_GIA_CONG': return planningService.cancelGiaCongTem(bu.id, { lyDo: ly }, actorId);
    case 'HUY_CHAY': return production.undoStartProduction(bu.id, actorId);
    case 'LENH': return planningService.rollbackLenh(bu.id, { target: bu.target, lyDo: ly, force: true }, actorId);
    case 'MO_READY_KT': {
      // Mọi phần in của lệnh (lệnh gom set cũ có thể nhiều) — gọi SAU khi lệnh đã hủy (thứ tự bắt buộc, xem traVeKyThuat).
      const { rows } = await query('SELECT DISTINCT dv.phan_in_id FROM lenh_sx_dot_vai l JOIN dot_vai_ve dv ON dv.id = l.dot_vai_ve_id WHERE l.lenh_san_xuat_id = $1', [bu.id]);
      for (const r of (rows.length ? rows : [{ phan_in_id: phanInId }])) await erpsyncRepo.reopenReadyForPhanIn(r.phan_in_id);
      return { phan_in: rows.length };
    }
    default: throw new AppError(`Bước không hỗ trợ: ${bu.loai}`, { status: 422, errorCode: 'BUOC_LA' });
  }
}

async function luiVe(phanInId, lenhId, { dich, lyDo, xemTruoc = false } = {}, actorId) {
  const tc = await repo.toanCanh(phanInId);
  const ke = dungBuocLui(tc, lenhId, dich);
  if (xemTruoc) return { xem_truoc: true, dich, ...ke };
  if (!String(lyDo || '').trim()) throw new AppError('Phải nhập lý do', { status: 422, errorCode: 'NO_LY_DO' });
  if (!ke.buoc.length) throw new AppError('Lệnh đã ở đúng trạm này — không có gì để hủy', { status: 409, errorCode: 'NOOP' });
  const xong = [];
  let loi = null;
  for (const bu of ke.buoc) {
    try { await chayBuoc(bu, String(lyDo).trim(), actorId, phanInId); xong.push(bu); } catch (e) {
      loi = { buoc: bu, message: e.message, errorCode: e.errorCode || null };
      break;
    }
  }
  await repo.ghiAudit('lenh_san_xuat', lenhId, 'QUAN_TRI_LUI_VE',
    { lenh: ke.lenh.ma_lenh_san_xuat, trang_thai: ke.lenh.trang_thai },
    { phan_in_id: phanInId, dich, ly_do: String(lyDo).trim(), so_buoc: ke.buoc.length, da_xong: xong.map((x) => x.nhan), loi }, actorId);
  sockets.emit('workflow:updated', { lenhId, stage: dich });
  sockets.emit('production:updated', { lenhId, action: 'quan-tri-lui' });
  sockets.emit('quality:updated', { lenhId });
  sockets.emit('dashboard:refresh', {});
  return { dich, tong: ke.buoc.length, xong, loi };
}

// ─── HỦY LẺ 1 BẢN GHI (tem · lượt KCS/Sửa/OQC · phân loại lỗi · phiếu giao · tích tem · phiếu · lần test) ───────
// Kiểm bản ghi THUỘC phần in này (qua `toanCanh`) rồi gọi đúng service hủy / mở lại đang có.
const HUY_LE = {
  PHIEU_GIAO: (tc, id) => tc.giao.some((g) => g.id === id),
  TICH_GIAO: (tc, id) => tc.tem.some((t) => t.id === id && t.da_tich_giao),
  OQC: (tc, id) => tc.oqc.some((x) => x.id === id),
  SUA: (tc, id) => tc.sua.some((x) => x.id === id),
  PLL: (tc, id) => tc.pll.some((x) => x.tem_id === id),
  KCS: (tc, id) => tc.kcs.some((x) => x.id === id),
  TEM: (tc, id) => tc.tem.some((t) => t.id === id && t.trang_thai !== 'HUY'),
  TEM_GIA_CONG: (tc, id) => tc.tem.some((t) => t.id === id && t.trang_thai !== 'HUY'),
  MO_LAI_TEM: (tc, id) => tc.tem.some((t) => t.id === id && t.mo_lai_duoc),
  HUY_CHAY: (tc, id) => tc.phieu.some((p) => p.id === id && p.trang_thai === 'DANG_CHAY'),
  CHAY_HOAN_TAT: (tc, id) => tc.phieu.some((p) => p.id === id && p.trang_thai === 'DANG_CHAY'),
  MO_LAI_PHIEU: (tc, id) => tc.phieu.some((p) => p.id === id && p.trang_thai === 'HOAN_TAT'),
  TEST_RUN: (tc, id) => tc.test.some((x) => x.id === id),
};
async function huyLe(phanInId, { loai, id, lyDo } = {}, actorId) {
  const kiem = HUY_LE[loai];
  if (!kiem) throw new AppError('Loại thao tác không hợp lệ', { status: 422, errorCode: 'LOAI_LA' });
  const ly = String(lyDo || '').trim();
  if (!ly) throw new AppError('Phải nhập lý do', { status: 422, errorCode: 'NO_LY_DO' });
  const tc = await repo.toanCanh(phanInId);
  if (!kiem(tc, id)) throw new AppError('Bản ghi không thuộc phần in này hoặc không còn ở trạng thái làm được thao tác này', { status: 404, errorCode: 'NOT_FOUND' });
  const production = require('../production/production.service');
  let kq;
  if (loai === 'MO_LAI_TEM') kq = await production.reopenPrintTem(id, LY(ly), actorId, { boQuaKhoa: true });
  else if (loai === 'CHAY_HOAN_TAT') kq = await production.closeProduction(id, LY(ly), actorId);
  else if (loai === 'TEST_RUN') kq = await planningService.huyLanTest(id, { lyDo: LY(ly) }, actorId);
  else kq = await chayBuoc({ loai, id }, ly, actorId, phanInId);
  await repo.ghiAudit('phan_in', phanInId, 'QUAN_TRI_HUY_LE', {}, { loai, id, ly_do: ly }, actorId);
  sockets.emit('dashboard:refresh', {});
  return { loai, id, ket_qua: kq || null };
}

// ─── PHÂN CÔNG của 1 phiếu (sửa / xóa) ───────────────────────────────────────
// Phiếu ĐANG CHẠY ⇒ `production.savePhanCong` (luật phân công đầu ca theo chuyền: áp cả lệnh khác cùng chuyền trong ca);
// phiếu đã xong ⇒ chỉ ghi phiếu đó (`suaPhanCongPhieuXong`). Xóa = gửi các ô rỗng.
async function luuPhanCong(phanInId, phieuId, body, actorId) {
  const tc = await repo.toanCanh(phanInId);
  const p = tc.phieu.find((x) => x.id === phieuId);
  if (!p) throw new AppError('Phiếu không thuộc phần in này', { status: 404, errorCode: 'NOT_FOUND' });
  const b = {
    caTruongId: body.caTruongId || null, chuyenTruong: String(body.chuyenTruong || '').trim(),
    thoIn: String(body.thoIn || '').trim(), toInId: body.toInId || null,
  };
  const production = require('../production/production.service');
  if (p.trang_thai === 'DANG_CHAY') await production.savePhanCong(phieuId, b, actorId);
  else await production.suaPhanCongPhieuXong(phieuId, b, actorId);
  await repo.ghiAudit('phieu_san_xuat', phieuId, 'QUAN_TRI_PHAN_CONG',
    { ca_truong_id: p.ca_truong_id, chuyen_truong: p.chuyen_truong, tho_in: p.tho_in, to_in_id: p.to_in_id },
    { ...b, phan_in_id: phanInId }, actorId);
  return { phieu_id: phieuId, dang_chay: p.trang_thai === 'DANG_CHAY' };
}

// ─── SỬA KẾ HOẠCH (26/10/2026, người dùng: "Quản trị phần in cho sửa thông tin của kế hoạch") ───────────────────
// Lệnh: gọi CHÍNH `planning.replan` (Lập lại kế hoạch — dời giờ, trần SL theo vải, không dưới SL đã in, audit REPLAN,
//   báo ERP kế hoạch) với `choDaChay` ⇒ nhận cả lệnh in đã xác nhận chạy (chỉ sửa thông tin, không đổi chặng, không qua
//   gia công). Kế hoạch tạm (đợt chưa Ready): gọi CHÍNH `planning.updateKeHoachTam`. Lý do bắt buộc (như mọi thao tác
//   ở trang này), ghi kèm audit `QUAN_TRI_SUA_KE_HOACH`.
async function xemKeHoachLenh(phanInId, lenhId) {
  const tc = await repo.toanCanh(phanInId);
  if (!tc.lenh.some((l) => l.id === lenhId)) throw new AppError('Lệnh không thuộc phần in này (hoặc đã hủy)', { status: 404, errorCode: 'NOT_FOUND' });
  return planningService.getReplanDetail(lenhId);
}

async function suaKeHoachLenh(phanInId, lenhId, body = {}, actorId) {
  const ly = String(body.lyDo || '').trim();
  if (!ly) throw new AppError('Phải nhập lý do', { status: 422, errorCode: 'NO_LY_DO' });
  const tc = await repo.toanCanh(phanInId);
  const l = tc.lenh.find((x) => x.id === lenhId);
  if (!l) throw new AppError('Lệnh không thuộc phần in này (hoặc đã hủy)', { status: 404, errorCode: 'NOT_FOUND' });
  const kq = await planningService.replan(lenhId, {
    chuyenId: body.chuyenId || null, ngayKeHoach: body.ngayKeHoach, tgBdKh: body.tgBdKh || null, tgKtKh: body.tgKtKh || null,
    slRelease: body.slRelease || null, thoIn: body.thoIn, dinhMuc: body.dinhMuc, lyDo: LY(ly),
    btp: typeof body.btp === 'boolean' ? body.btp : undefined,
  }, actorId, { choDaChay: true, nguon: 'QUAN_TRI_PHAN_IN' });
  await repo.ghiAudit('lenh_san_xuat', lenhId, 'QUAN_TRI_SUA_KE_HOACH',
    { chuyen_id: l.chuyen_id, ngay_ke_hoach: l.ngay_ke_hoach, tg_bd_kh: l.tg_bd_kh, tg_kt_kh: l.tg_kt_kh, tho_in_kh: l.tho_in_kh, so_luong_release: l.so_luong_release },
    { phan_in_id: phanInId, chuyen_id: body.chuyenId || l.chuyen_id, ngay_ke_hoach: body.ngayKeHoach, tg_bd_kh: body.tgBdKh || null,
      tg_kt_kh: body.tgKtKh || null, tho_in_kh: body.thoIn, so_luong_release: kq.so_luong_release, ly_do: ly }, actorId);
  return kq;
}

async function suaKeHoachTam(phanInId, ktId, body = {}, actorId) {
  const ly = String(body.lyDo || '').trim();
  if (!ly) throw new AppError('Phải nhập lý do', { status: 422, errorCode: 'NO_LY_DO' });
  const tc = await repo.toanCanh(phanInId);
  const kt = (tc.ke_hoach_tam || []).find((x) => x.id === ktId);
  if (!kt) throw new AppError('Kế hoạch tạm không thuộc phần in này (hoặc đã xác nhận / xóa)', { status: 404, errorCode: 'NOT_FOUND' });
  if (!body.chuyenId) throw new AppError('Chọn chuyền', { status: 422, errorCode: 'NO_CHUYEN' });
  if (!body.ngayKeHoach) throw new AppError('Chọn ngày sản xuất theo kế hoạch', { status: 422, errorCode: 'NO_NGAY' });
  const kq = await planningService.updateKeHoachTam(ktId, {
    chuyenId: body.chuyenId, ngayKeHoach: body.ngayKeHoach, soLuong: body.soLuong,
    tgBdKh: body.tgBdKh || null, tgKtKh: body.tgKtKh || null, thoIn: body.thoIn, dinhMuc: body.dinhMuc,
  }, actorId);
  await repo.ghiAudit('ke_hoach_tam', ktId, 'QUAN_TRI_SUA_KE_HOACH',
    { chuyen_id: kt.chuyen_id, ngay_ke_hoach: kt.ngay_ke_hoach, tg_bd_kh: kt.tg_bd_kh, tg_kt_kh: kt.tg_kt_kh, so_luong: kt.so_luong, tho_in_kh: kt.tho_in_kh },
    { phan_in_id: phanInId, dot_vai_ve_id: kt.dot_vai_ve_id, chuyen_id: body.chuyenId, ngay_ke_hoach: body.ngayKeHoach,
      tg_bd_kh: body.tgBdKh || null, tg_kt_kh: body.tgKtKh || null, so_luong: body.soLuong ?? null, tho_in_kh: body.thoIn, ly_do: ly }, actorId);
  return kq;
}

// ─── HỦY / MỞ CẢ PHẦN IN (tái dùng tab Hủy / Mở phần in) ────────────────────────
async function huyPhanIn(phanInId, lyDo, actorId) {
  if (!String(lyDo || '').trim()) throw new AppError('Phải nhập lý do', { status: 422, errorCode: 'NO_LY_DO' });
  return ordersService.softDeletePhanIn([phanInId], LY(String(lyDo).trim()), actorId);
}
async function moPhanIn(phanInId, actorId) {
  return ordersService.reopenPhanIn([phanInId], actorId);
}

module.exports = {
  traCuu, chiTiet, suaPhanIn, suaDotVai, datGiaiDoan, huyDotVai, moDotVai, huyMucReady, DICH,
  datKhoaErp, datLuongSx, boCongDoan, themCongDoan, themDotVai, luiVe, dungBuocLui, huyLe, luuPhanCong, huyPhanIn, moPhanIn, DICH_LUI,
  xemKeHoachLenh, suaKeHoachLenh, suaKeHoachTam,
};
