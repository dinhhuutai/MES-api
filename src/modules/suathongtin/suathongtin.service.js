'use strict';

const { withTransaction } = require('../../config/db');
const repo = require('./suathongtin.repository');
// Sửa trường phần in / đợt vải: TÁI DÙNG đúng đường ghi của *Quản trị phần in* (whitelist cột cứng,
// guard hạ SL vải dưới SL đã in, tính lại phương án in khi đổi loại/SL, audit). ⚠ Đừng viết UPDATE riêng.
const phanInAdmin = require('../phaninadmin/phaninadmin.service');
// "Hủy vải không in" = XÓA MỀM ĐỢT: gọi lại CHÍNH hàm của tab Hủy đợt vải (dọn tồn trạm / gom set / ẩn phần in
// hết đợt + audit `HUY_DOT_VAI` để "Mở đợt vải" khôi phục được).
const ordersService = require('../orders/orders.service');
const { THONG_TIN_GN, TEN_THEO_MA, NGUON_TRA_VE_GN, dsManQuayVe } = require('../../utils/traVeGn');
const AppError = require('../../utils/AppError');
const sockets = require('../../sockets');
const gnErp = require('./gnErp');

const NGUON_HOP_LE = NGUON_TRA_VE_GN;

// Phần in rời/về lại MỌI màn có thể đang chứa nó (READY · Release 1 · Test Run · Release 2 · Chờ chạy)
//   ⇒ bắn đủ 3 sự kiện mà các màn đó đang nghe để tải lại ngầm.
function baoCacMan(payload) {
  sockets.emit('ready:confirmed', payload);
  sockets.emit('workflow:updated', payload);
  sockets.emit('production:updated', payload);
}
const ngayHopLe = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);

function danhMuc() {
  return { thong_tin: THONG_TIN_GN, nguon: NGUON_HOP_LE };
}

async function danhSach(q) {
  const trangThai = ['CHO', 'DA', ''].includes(q.trangThai) ? q.trangThai : 'CHO';
  const rows = await repo.danhSach({
    search: q.search || '', trangThai, tuNgay: ngayHopLe(q.tuNgay), denNgay: ngayHopLe(q.denNgay),
  });
  // Badge "Đề nghị hủy vải" (mục `HUY_VAI` lúc trả về) — GN quyết trên ERP (không xác nhận lại đợt).
  return rows.map((r) => ({ ...r, co_ly_do_huy: coLyDoHuy([r]) }));
}

// ─── "HỦY VẢI KHÔNG IN" = XÓA MỀM ĐỢT VẢI (11/10/2026, người dùng chốt) ─────────────────────────
// Trả về GN mà tích mục `HUY_VAI` ⇒ KHÔNG nằm chờ ở trang *Phần in chờ sửa thông tin* nữa: các đợt trong phạm
// vi trả về bị xóa mềm ngay (`orders.softDeleteDotVai` — hết đợt sống thì phần in ẩn theo), lượt đóng luôn
// (audit `GN_HUY_DOT_VAI`). Đợt đang nằm trong lệnh CHƯA CHẠY (trả về từ Test Run / Release 2 / Chờ chạy) ⇒ hủy
// lệnh trước bằng `planning.rollbackLenh` đích Release 1 (lệnh chứa phần in KHÁC — gom set cũ — thì không tự
// hủy: báo lỗi, lượt nằm chờ để xử lý tay). ERP vẫn được báo hủy đợt READY (`gnErp.huyBenErp`, chạy ngầm).
// ERP về sau gửi đợt MỚI của code phần đó ⇒ đi đường đợt mới bình thường (phần in tự hiện lại).
const LY_DO_HUY_VAI = 'Trả về GN — hủy vải không in';
async function huyVaiTheoPhamVi({ phanInId, maPhan, phamVi }, actorId) {
  const loi = []; const lenhHuy = []; const chan = new Set();
  const coLenh = phamVi.filter((d) => d.lenh_ids.length);
  if (coLenh.length) {
    const planning = require('../planning/planning.service'); // lazy — tránh vòng require
    const daHuy = new Set();
    for (const d of coLenh) {
      if (!d.lenh_rieng) {
        chan.add(d.id);
        loi.push({ id: d.id, ma: d.ma_dot_vai, ly_do: 'Đợt nằm trong lệnh có phần in khác — hủy lệnh ở Hủy lệnh xác nhận trước' });
        continue;
      }
      for (const lid of d.lenh_ids) {
        if (daHuy.has(lid)) continue;
        try {
          await planning.rollbackLenh(lid, { target: 'RELEASE_1', lyDo: `${LY_DO_HUY_VAI} (${maPhan})` }, actorId);
          daHuy.add(lid); lenhHuy.push(lid);
        } catch (e) {
          chan.add(d.id);
          loi.push({ id: d.id, ma: d.ma_dot_vai, ly_do: `Không hủy được lệnh: ${e.message}` });
        }
      }
    }
  }
  const ids = phamVi.filter((d) => !chan.has(d.id)).map((d) => d.id);
  let daHuyDot = [];
  if (ids.length) {
    const r = await ordersService.softDeleteDotVai(ids, LY_DO_HUY_VAI, actorId);
    daHuyDot = r.items || [];
    loi.push(...(r.loi || []));
  }
  if (!phamVi.length) loi.push({ ly_do: 'Không có đợt vải nào chưa vào sản xuất để hủy' });
  // Đóng lượt khi đã hủy được ít nhất 1 đợt và không còn đợt nào bị chặn.
  let daDong = false;
  if (daHuyDot.length && !loi.length) {
    await withTransaction(async (client) => {
      const xs = await repo.xuLyHet(client, phanInId, actorId);
      for (const id of xs) {
        await repo.ghiAudit(client, id, 'GN_HUY_DOT_VAI', {
          phan_in_id: phanInId, ma_phan: maPhan, xoa_mem: true,
          ghi_chu: `Hủy vải không in — đã xóa mềm ${daHuyDot.length} đợt vải${lenhHuy.length ? `, hủy ${lenhHuy.length} lệnh chưa chạy` : ''}`,
          dot_vai: daHuyDot.map((d) => ({ id: d.id, ma_dot_vai: d.ma })), lenh_huy: lenhHuy,
          phan_in_an: daHuyDot.some((d) => d.phan_in_da_huy),
        }, actorId);
      }
      daDong = xs.length > 0;
    });
  }
  return {
    ok: daDong, so_dot: daHuyDot.length, so_lenh_huy: lenhHuy.length, loi,
    phan_in_an: daHuyDot.some((d) => d.phan_in_da_huy),
  };
}

// Lượt ĐANG CHỜ mang đề nghị hủy vải (trả về trước 11/10/2026, hoặc lần hủy trước bị chặn) ⇒ xóa mềm đợt + đóng.
async function huyVaiDangCho(phanInId, actorId) {
  const pin = await repo.getPhanInCoBan(phanInId);
  if (!pin) throw new AppError('Phần in không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const cho = await repo.dangCho(phanInId);
  if (!cho.length) throw new AppError('Phần in không còn chờ Giao nhận sửa', { status: 409, errorCode: 'KHONG_O_GN' });
  if (!coLyDoHuy(cho)) {
    throw new AppError('Lượt trả về này không có mục "Hủy vải không in"', { status: 409, errorCode: 'KHONG_HUY_VAI' });
  }
  const pv = await repo.phamViCuaLuot(cho[0].id);
  const phamVi = await repo.dotPhamVi(phanInId, { dotVaiIds: pv });
  const kq = await huyVaiTheoPhamVi({ phanInId, maPhan: pin.ma_phan, phamVi }, actorId);
  if (!kq.ok) {
    throw new AppError(`Chưa hủy được vải của ${pin.ma_phan}: ${kq.loi.map((x) => x.ly_do).join(' · ') || 'không rõ lý do'}`,
      { status: 409, errorCode: 'HUY_VAI_LOI', details: kq });
  }
  baoCacMan({ phanInId, gn_huy_vai: true });
  sockets.emit('gn:updated', { phanInId });
  sockets.emit('dashboard:refresh', {});
  return { phan_in_id: phanInId, ma_phan: pin.ma_phan, ...kq };
}

async function chiTiet(phanInId) {
  const [ct, dangCho, lichSu] = await Promise.all([
    phanInAdmin.chiTiet(phanInId), repo.dangCho(phanInId), repo.lichSu(phanInId),
  ]);
  return { ...ct, tra_ve_dang_cho: dangCho, lich_su: lichSu, co_ly_do_huy: coLyDoHuy(dangCho) };
}

// Đề nghị hủy vải nằm ở mục `HUY_VAI` (tên trong `checklist_list`) hoặc câu lý do `traVe` sinh ra.
const TEN_HUY_VAI = TEN_THEO_MA.HUY_VAI;
function coLyDoHuy(dsTraVe = []) {
  return dsTraVe.some((q) => String(q.checklist_list || '').split(',').map((s) => s.trim()).includes(TEN_HUY_VAI)
    || /Đề nghị HỦY VẢI/i.test(String(q.ly_do || '')));
}

// READY (Kỹ thuật / QC) · Release 1 · Test Run · Release 2 · Chờ chạy trả phần in về GN
//   (`nguon` ∈ `NGUON_TRA_VE_GN`; lệnh giữ nguyên — xem `utils/traVeGn.js`). `lenhId` (tùy chọn) chỉ để ghi vết.
// ⚠ Guard chạy TRƯỚC khi ghi: phần in phải còn hoạt động, chưa đang ở GN, và phải chọn ÍT NHẤT 1 mục
//   (hoặc gõ ô "Khác") — lý do rỗng thì GN không biết phải sửa gì.
async function traVe({ phanInId, thongTin, khac, nguon, lenhId, dotVaiIds }, actorId) {
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
  // Mục "Hủy vải không in" không phải thông tin SAI ⇒ tách riêng cho câu lý do đọc đúng nghĩa.
  const tenSai = ma.filter((x) => x !== 'HUY_VAI').map((x) => TEN_THEO_MA[x]);
  if (khacSach) tenSai.push(`Khác: ${khacSach}`);
  const lyDo = [
    ma.includes('HUY_VAI') ? 'Đề nghị HỦY VẢI — không in' : null,
    tenSai.length ? `Sai thông tin: ${tenSai.join(' · ')}` : null,
  ].filter(Boolean).join(' · ');

  // PHẠM VI ĐỢT bị trả về (11/10/2026): dòng đợt của màn READY / QC / Release 1 (`dotVaiIds`), đợt trong lệnh
  //   (`lenhId`), không có ⇒ mọi đợt chưa vào sản xuất. Ghi vào vết để (1) "hủy vải" xóa mềm đúng đợt,
  //   (2) báo ERP hủy đúng đợt, (3) ERP gửi đợt mới thì thay đúng đợt cũ (`gnErp.thayDotCu`).
  const phamVi = await repo.dotPhamVi(phanInId, { dotVaiIds, lenhId });
  const kq = await withTransaction(async (client) => {
    const r = await repo.insertTraVe(client, { phanInId, checklistList: ten.join(', '), lyDo }, actorId);
    await repo.ghiAudit(client, r.id, 'TRA_VE_GN',
      { phan_in_id: phanInId, ma_phan: pin.ma_phan, nguon: nguonSach, nguon_ten: NGUON_HOP_LE[nguonSach],
        lenh_id: lenhId || null, thong_tin: ma, khac: khacSach || null,
        dot_vai_ids: phamVi.map((d) => d.id) }, actorId);
    return r;
  });
  // Cặp `code phần, IDDotReady` chốt TRƯỚC khi xóa mềm (đợt đã hủy thì không còn trong câu đọc đợt sống).
  const cap = phamVi.map((d) => ({ dot_vai_ve_id: d.id, ma_dot_vai: d.ma_dot_vai, id_dot_ready: d.id_dot_ready }));
  let huyVai = null;
  if (ma.includes('HUY_VAI')) {
    try {
      huyVai = await huyVaiTheoPhamVi({ phanInId, maPhan: pin.ma_phan, phamVi }, actorId);
    } catch (e) {
      // Xóa mềm hỏng ⇒ lượt vẫn nằm chờ như một lần trả về thường (không mất yêu cầu), báo rõ cho người bấm.
      huyVai = { ok: false, so_dot: 0, so_lenh_huy: 0, loi: [{ ly_do: e.message }] };
    }
  }
  baoCacMan({ phanInId, tra_ve_gn: true });
  sockets.emit('gn:updated', { phanInId });
  if (huyVai && huyVai.ok) sockets.emit('dashboard:refresh', {});
  // 07/10/2026: HỦY ĐỢT READY bên ERP ngay (chạy NGẦM sau commit — ERP chậm/lỗi không giữ người bấm; kết
  //   quả hiện ở cột ERP của trang chờ sửa thông tin). Xem `gnErp.js`.
  gnErp.huyBenErp(kq.id, { phanInId, maPhan: pin.ma_phan, cap }, actorId).catch(() => {});
  return { id: kq.id, phan_in_id: phanInId, ma_phan: pin.ma_phan, ly_do: lyDo, huy_vai: huyVai };
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

// ĐÓNG lượt trả về ⇒ tắt cờ ⇒ phần in QUAY LẠI ĐÚNG MÀN ĐÃ BẤM TRẢ VỀ (READY · QC READY · Release 1 · Test Run ·
// Release 2 · Chờ chạy): lệnh/đợt/xác nhận giữ nguyên lúc trả về nên chỉ cần gỡ cờ là mọi danh sách hết lọc
// (`utils/traVeGn.js`). `ve_man` = tên màn quay về (dòng cũ không có nguồn ⇒ READY). Trả null nếu không còn lượt.
// `tuDong` = hệ thống đóng vì ERP gửi lại đợt (07/10/2026, `gnErp`) — người NULL, ghi kèm tóm tắt thông tin đã áp.
async function dongLuot(phanInId, { ghiChu = null, tuDong = false, capNhat = null } = {}, actorId = null) {
  const pin = await repo.getPhanInCoBan(phanInId);
  if (!pin) throw new AppError('Phần in không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const veMan = dsManQuayVe(await repo.dangCho(phanInId));
  const ids = await withTransaction(async (client) => {
    const xs = await repo.xuLyHet(client, phanInId, actorId);
    for (const id of xs) {
      await repo.ghiAudit(client, id, 'GN_XAC_NHAN_LAI', {
        phan_in_id: phanInId, ma_phan: pin.ma_phan, ghi_chu: ghiChu, ve_man: veMan,
        ...(tuDong ? { tu_dong: true, cap_nhat_erp: capNhat } : {}),
      }, actorId);
    }
    return xs;
  });
  if (!ids.length) return null;
  // Phần in hiện lại ĐÚNG màn nó đã rời (READY / Release 1 / Test Run / Release 2 / Chờ chạy).
  baoCacMan({ phanInId, gn_xac_nhan: true });
  sockets.emit('gn:updated', { phanInId });
  sockets.emit('dashboard:refresh', {});
  return { phan_in_id: phanInId, ma_phan: pin.ma_phan, so_luot: ids.length, ve_man: veMan };
}

// Hệ thống đóng lượt khi ERP gửi lại đợt đã hủy (gọi từ `gnErp.sauDongBo`, sau vòng đồng bộ ERP).
function xacNhanTuDong(phanInId, capNhat = null) {
  return dongLuot(phanInId, { ghiChu: 'ERP gửi lại đợt sau khi GN xác nhận trên ERP', tuDong: true, capNhat }, null);
}

// ĐƯỜNG DỰ PHÒNG — GN "Xác nhận lại" TAY chỉ khi lệnh hủy CHƯA tới được ERP (chưa gửi / API tắt / ERP lỗi /
// không có đợt mang IDDotReady): khi đó ERP không bao giờ gửi lại nên luồng tự động không thể đóng lượt.
// ⚠ ERP ĐÃ nhận lệnh hủy ⇒ 409 `CHO_ERP`: phải xác nhận lại TRÊN ERP (người dùng chốt 07/10/2026 — bỏ nút
//   "Xác nhận lại"); đóng tay ở MES thì đợt bên ERP vẫn đang bị hủy, hai bên lệch nhau.
async function xacNhanLai(phanInId, { ghiChu } = {}, actorId) {
  const { cho, daHuy } = await gnErp.trangThaiDangCho(phanInId);
  if (!cho.length) {
    throw new AppError('Phần in không còn chờ Giao nhận sửa (đã xác nhận lại)', { status: 409, errorCode: 'ALREADY' });
  }
  if (daHuy) {
    throw new AppError('ERP đã hủy đợt READY của phần in này — GN xác nhận lại TRÊN ERP, phần in sẽ tự quay về màn cũ khi ERP gửi lại',
      { status: 409, errorCode: 'CHO_ERP' });
  }
  const kq = await dongLuot(phanInId, { ghiChu: String(ghiChu || '').trim().slice(0, 500) || null }, actorId);
  if (!kq) throw new AppError('Phần in không còn chờ Giao nhận sửa (đã có người xác nhận lại)', { status: 409, errorCode: 'ALREADY' });
  return kq;
}

// Gửi (lại) lệnh hủy đợt READY sang ERP cho lượt đang chờ — lượt trước 07/10/2026 chưa gửi, API tắt, ERP lỗi.
// Có `await` (người bấm chờ kết quả). ERP đã nhận rồi ⇒ 409, khỏi gửi trùng.
async function guiHuyErp(phanInId, actorId) {
  const pin = await repo.getPhanInCoBan(phanInId);
  if (!pin) throw new AppError('Phần in không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const { cho, daHuy } = await gnErp.trangThaiDangCho(phanInId);
  if (!cho.length) throw new AppError('Phần in không còn chờ Giao nhận sửa', { status: 409, errorCode: 'KHONG_O_GN' });
  if (daHuy) throw new AppError('ERP đã nhận lệnh hủy của lượt này rồi', { status: 409, errorCode: 'DA_HUY_ERP' });
  // Lượt mới nhất mang lệnh hủy (traVe chặn trả về lần 2 khi còn lượt chờ ⇒ thường chỉ có 1).
  const kq = await gnErp.huyBenErp(cho[0].id, { phanInId, maPhan: pin.ma_phan }, actorId);
  return { phan_in_id: phanInId, ma_phan: pin.ma_phan, ...kq };
}

module.exports = {
  danhMuc, danhSach, chiTiet, traVe, suaPhanIn, suaDotVai, xacNhanLai, xacNhanTuDong, guiHuyErp, huyVaiDangCho,
};
