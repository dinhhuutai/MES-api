'use strict';

const { withTransaction } = require('../../config/db');
const repo = require('./quality.repository');
const AppError = require('../../utils/AppError');
const sockets = require('../../sockets');
const tracking = require('../workflow/tracking.service');
const planningRepo = require('../planning/planning.repository');
const { caFromParts } = require('../../utils/ca');

const num = (x) => Math.max(0, Number(x) || 0);

async function requireTem(temId, expectStatus) {
  const tem = await repo.getTemBasic(temId);
  if (!tem) throw new AppError('Tem không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (tem.trang_thai !== expectStatus) {
    throw new AppError(`Tem không ở trạng thái ${expectStatus}`, { status: 409, errorCode: 'WRONG_STAGE' });
  }
  return tem;
}

// ----- KCS (đầu vào: tem DA_KHO) -----
const prodRepo = require('../production/production.repository');
async function listKcsCandidates({ search, filters }) {
  // Tem hết giờ phơi → tự động sang DA_KHO (chờ KCS) trước khi liệt kê.
  try { await prodRepo.promoteFinishedDrying(); } catch (e) { /* bỏ qua */ }
  const rows = await repo.listKcsCand({ search, filters }); // còn phần chưa kiểm (con_kcs > 0)
  // Đánh dấu tem bị OQC trả về (badge + lọc).
  const rm = await repo.activeReturnsMap('OQC', rows.map((r) => r.tem_id));
  rows.forEach((r) => { r.tra_ve = rm[r.tem_id] || null; r.tra_ve_ly_do = rm[r.tem_id]?.ly_do || null; });
  await attachPrevConfirmer(rows, 'nguoi_in'); // trạm trước của KCS = in tem
  return rows;
}

// Gắn "người xác nhận trạm trước" vào từng dòng (field `nguoi_truoc`) — query nhẹ theo tem_id.
async function attachPrevConfirmer(rows, key) {
  if (!rows || rows.length === 0) return;
  const pc = await repo.prevConfirmerByTems(rows.map((r) => r.tem_id));
  const map = new Map(pc.map((x) => [x.tem_id, x]));
  // Tem GIA CÔNG không có KCS/Sửa/in tem → người xác nhận trạm trước = người Release 1 (người gửi gia công).
  rows.forEach((r) => {
    const x = map.get(r.tem_id) || {};
    r.nguoi_truoc = x.la_gia_cong ? (x.nguoi_release1 || null) : (x[key] || null);
    r.la_gia_cong = !!x.la_gia_cong; // FE hiện nguồn "Gia công" thay "KCS" cho tem gia công
  });
}

// OQC trả tem về trạm trước THEO NGUỒN của phần chờ OQC (kèm lý do bắt buộc) — mig 047:
//   nguồn KCS (tem 15-) → phần chờ OQC quay lại CHƯA KIỂM (con_kcs) → tem về màn KCS.
//   nguồn SỬA (tem 17-) → phần chờ OQC quay lại CHỜ SỬA  (con_sua) → tem về màn Sửa.
// (Trả nguồn Sửa mà giảm sl_kcs_dat thì sổ cái không đổi ⇒ tem nằm lại OQC — lỗi cũ.)
async function returnOqcToKcs(temId, body, actorId) {
  const nguon = body.nguon === 'SUA' ? 'SUA' : 'KCS';
  const tram = nguon === 'SUA' ? 'Sửa' : 'KCS';
  const lyDo = (body.lyDo || '').trim();
  if (!lyDo) throw new AppError(`Nhập lý do trả về ${tram}`, { status: 422, errorCode: 'NO_LY_DO' });
  const tem = await repo.getTemLedger(temId);
  if (!tem) throw new AppError('Tem không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });

  // Phần chờ OQC tách theo nguồn (mig 047 bắt buộc ⇒ 2 sub-counter luôn có giá trị).
  const con = Number(nguon === 'SUA' ? tem.con_oqc_sua : tem.con_oqc_kcs) || 0;
  if (con <= 0) {
    const nhan = nguon === 'SUA' ? 'đã sửa (tem 17-)' : 'đạt từ KCS (tem 15-)';
    throw new AppError(`Tem không còn phần chờ OQC nguồn ${nhan} để trả về`, { status: 409, errorCode: 'NO_OQC' });
  }

  // Trả về KCS ⇒ tem kiểm lại từ đầu ⇒ TỰ HỦY tem sửa 16- đang chờ của tem đó (nếu có): nhãn cũ hết hiệu lực,
  // bộ phận Sửa không làm nữa, KCS kiểm lại sẽ quyết định lại phần hư. Trả về nguồn SỬA thì KHÔNG hủy —
  // chính phần sửa đó mới là thứ cần làm lại. Chạy CÙNG transaction để sổ cái không áp dụng nửa vời.
  let temSuaHuy = null;
  await withTransaction(async (client) => {
    if (nguon === 'SUA') await repo.reduceSuaDat(client, temId, con, actorId); // chờ OQC → về chờ sửa
    else await repo.reduceKcsDat(client, temId, con, actorId);                 // chờ OQC → về chưa kiểm

    if (nguon === 'KCS') {
      // Đọc SAU khi đã trừ sl_kcs_dat: trả hết phần đạt về ⇒ sl_kcs_dat=0 ⇒ SL sửa quay lại chờ kiểm
      // (thay vì bị dồn sang hủy) — đúng nghĩa "kiểm lại toàn bộ tem".
      const t = (await repo.getTemSuaRows([temId], client))[0];
      if (t && (Number(t.con_sua) || 0) > 0) {
        const plans = [planHuy(t)];
        await applyHuyTemSua(client, plans, `Tự động: OQC trả tem về KCS — ${lyDo}`, actorId, true);
        temSuaHuy = temSuaResult(plans).items[0];
      }
    }
    await repo.recomputeTemStageMany(client, [temId], actorId);
  });
  // loai 'OQC_SUA' → badge/lý do hiện ở màn Sửa; 'OQC' → màn KCS (như cũ).
  await repo.insertQcTraVe({ loai: nguon === 'SUA' ? 'OQC_SUA' : 'OQC', temId, lyDo }, actorId);
  await tracking.moveByTem(temId, nguon === 'SUA' ? 'SUA' : 'KIEM', actorId);

  const next = nguon === 'SUA' ? 'TRA_VE_SUA' : 'TRA_VE_KCS';
  sockets.emit('quality:updated', { temId, stage: 'OQC', next });
  sockets.emit('dashboard:refresh', {});
  return { tem_id: temId, nguon, so_luong: con, next, tem_sua_huy: temSuaHuy };
}

// Lịch sử QC trả về theo loại + ngày (cho trang toggle 3 loại).
// Tab OQC gộp cả 2 đích trả về: 'OQC' (→ KCS) và 'OQC_SUA' (→ Sửa).
async function qcTraVeHistory(loai, date) {
  const L = ['READY', 'TEST_RUN', 'OQC'].includes(loai) ? loai : 'READY';
  return repo.listQcTraVe(L === 'OQC' ? ['OQC', 'OQC_SUA'] : [L], date);
}

async function recordKcs(temId, body, actorId) {
  const tem = await repo.getTemLedger(temId);
  if (!tem) throw new AppError('Tem không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (['IN', 'DANG_PHOI'].includes(tem.trang_thai)) throw new AppError('Tem chưa khô', { status: 409, errorCode: 'WRONG_STAGE' });
  const conKcs = Number(tem.con_kcs) || 0;
  if (conKcs <= 0) throw new AppError('Tem không còn phần chờ KCS', { status: 409, errorCode: 'DONE' });

  const dat = num(body.soLuongDat);                          // đạt → chờ OQC
  const hu = num(body.soLuongHu);                            // hư (khuyết tật)
  const quyetDinhSua = Math.min(num(body.soLuongSua), hu);   // ≤ hư (mặc định = hư) → chờ sửa
  const huyTrucTiep = num(body.soLuongHuy);                  // hủy nhập trực tiếp → loại
  const mau = num(body.soLuongMau);                          // mẫu: ghi nhận tham khảo, KHÔNG tính vào SL kiểm
  const thieu = num(body.soLuongThieu);
  const du = num(body.soLuongDu);
  const chenh = du - thieu;                                  // dư(+)/thiếu(−) → đổi TỔNG CẦN KIỂM = so_luong + Σchênh

  const huyTaiKcs = (hu - quyetDinhSua) + huyTrucTiep;       // phần hư không sửa + hủy trực tiếp → loại
  // SL kiểm được lần này = đạt + hư + hủy (= đạt + sửa + hủyTạiKcs). Mẫu không tính; ≤ SL còn lại (± chênh lệch).
  const kiem = dat + hu + huyTrucTiep;
  if (kiem <= 0) throw new AppError('Nhập số lượng kiểm (đạt/hư/hủy)', { status: 422, errorCode: 'EMPTY' });
  const conSauChenh = conKcs + chenh; // dư làm tăng, thiếu làm giảm phần còn được kiểm
  if (kiem > conSauChenh) {
    throw new AppError(`SL kiểm lần này (${kiem}) vượt SL còn lại (${conSauChenh}${chenh ? ` = còn ${conKcs} ${chenh > 0 ? '+ dư ' + chenh : '− thiếu ' + -chenh}` : ''})`,
      { status: 422, errorCode: 'OVER' });
  }

  const data = {
    soLuongKiem: kiem, soLuongMau: mau, soLuongDat: dat, soLuongLoi: hu,
    soLuongHuy: huyTaiKcs, soLuongChenhLech: chenh,
    ketQua: (hu > 0 || huyTrucTiep > 0) ? 'CO_LOI' : 'DAT', ghiChu: body.ghiChu,
  };

  await withTransaction(async (client) => {
    await repo.insertKcs(client, temId, data, actorId);
    // Cộng dồn sổ cái: đạt → chờ OQC; quyết định sửa → chờ sửa; (hư không sửa + hủy) → loại; chênh lệch → tổng cần kiểm.
    await repo.addKcsLedger(client, temId, { dat, sua: quyetDinhSua, huy: huyTaiKcs, chenh }, actorId);
    await repo.recomputeTemStage(client, temId, actorId);
  });
  await tracking.moveByTem(temId, 'KIEM', actorId);
  await repo.resolveReturns('OQC', temId); // KCS làm lại xong → tắt cờ "bị OQC trả về"
  sockets.emit('quality:updated', { temId, stage: 'KCS' });
  sockets.emit('dashboard:refresh', {});
  const conLai = conSauChenh - kiem; // SL chưa kiểm còn lại (đã tính chênh lệch)
  return { tem_id: temId, next: 'KCS', so_luong_dat: dat, so_luong_sua: quyetDinhSua, so_luong_huy: huyTaiKcs, con_kcs: conLai };
}

// ----- GỘP TEM (KCS) — do in dư tem vì nhập thiếu SL: dồn SL các tem về tem ĐẦU TIÊN, hủy các tem còn lại -----
// Điều kiện: tất cả tem CÙNG PHẦN IN, CHƯA kiểm/giao (sổ cái = 0), chưa HỦY. Tem đích nhận thêm Σ SL các tem nguồn.
async function gopTem({ targetTemId, sourceTemIds }, actorId) {
  const sources = [...new Set((sourceTemIds || []).filter((id) => id && id !== targetTemId))];
  if (!targetTemId) throw new AppError('Thiếu tem đích', { status: 422, errorCode: 'NO_TARGET' });
  if (sources.length === 0) throw new AppError('Chọn ít nhất 2 tem để gộp', { status: 422, errorCode: 'NEED_2' });

  const rows = await repo.getTemsForMerge([targetTemId, ...sources]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const target = byId.get(targetTemId);
  if (!target) throw new AppError('Tem đích không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (sources.some((id) => !byId.get(id))) throw new AppError('Có tem nguồn không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });

  const all = [target, ...sources.map((id) => byId.get(id))];
  // Cùng phần in.
  const pin = target.phan_in_id;
  if (all.some((t) => t.phan_in_id !== pin || !pin)) {
    throw new AppError('Chỉ gộp các tem CÙNG PHẦN IN', { status: 409, errorCode: 'DIFF_PHAN_IN' });
  }
  // Chưa hủy + chưa kiểm/giao (giữ đúng sổ cái, không mất dữ liệu đã ghi).
  for (const t of all) {
    if (t.trang_thai === 'HUY') throw new AppError(`Tem ${t.ma_tem} đã hủy`, { status: 409, errorCode: 'CANCELLED' });
    if (Number(t.da_xu_ly) > 0) throw new AppError(`Tem ${t.ma_tem} đã có KCS/OQC/giao — không thể gộp`, { status: 409, errorCode: 'ALREADY_PROCESSED' });
  }

  const addQty = sources.reduce((s, id) => s + (Number(byId.get(id).so_luong) || 0), 0);
  const anyPhoi = sources.some((id) => byId.get(id).da_qua_phoi);

  await withTransaction(async (client) => {
    await repo.addTemSoLuong(client, targetTemId, addQty, anyPhoi, actorId);
    for (const id of sources) await prodRepo.cancelTem(client, id, actorId); // hủy tem nguồn + gỡ xe phơi
    await repo.recomputeTemStage(client, targetTemId, actorId);
    await repo.logGopTem(client, targetTemId, target.ma_tem,
      sources.map((id) => ({ ma_tem: byId.get(id).ma_tem, so_luong: byId.get(id).so_luong })), actorId);
  });
  sockets.emit('quality:updated', { temId: targetTemId, stage: 'KCS', action: 'GOP_TEM' });
  sockets.emit('production:updated', {});
  sockets.emit('dashboard:refresh', {});
  return {
    target_tem_id: targetTemId, ma_tem: target.ma_tem,
    so_tem_gop: sources.length, sl_gop_them: addQty, so_luong_moi: (Number(target.so_luong) || 0) + addQty,
  };
}

// ----- SỬA (còn phần chờ sửa: con_sua > 0) -----
async function listSuaCandidates({ search, filters }) {
  const rows = await repo.listSuaCand({ search, filters });
  if (rows.length === 0) return rows;
  // Suy ca sản xuất: giờ/tuần VN (query nhẹ riêng) + loại ca của tuần (Ngắn/Dài).
  const [parts, map] = await Promise.all([
    repo.caPartsForTems(rows.map((r) => r.tem_id)),
    planningRepo.caModeMap(),
  ]);
  const partMap = new Map(parts.map((p) => [p.tem_id, p]));
  const out = rows.map((r) => {
    const p = partMap.get(r.tem_id) || {};
    return { ...r, ca: caFromParts(p.ca_gio, p.ca_phut, p.ca_nam, p.ca_tuan, map) };
  });
  // Đánh dấu tem bị OQC trả về SỬA (badge + lý do) — giống badge "Bị OQC trả về" ở KCS.
  const rm = await repo.activeReturnsMap('OQC_SUA', out.map((r) => r.tem_id));
  out.forEach((r) => { r.tra_ve = rm[r.tem_id] || null; r.tra_ve_ly_do = rm[r.tem_id]?.ly_do || null; });
  await attachPrevConfirmer(out, 'nguoi_kcs'); // trạm trước của Sửa = KCS
  return out;
}

async function recordSua(temId, body, actorId) {
  const tem = await repo.getTemLedger(temId);
  if (!tem) throw new AppError('Tem không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const conSua = Number(tem.con_sua) || 0;
  if (conSua <= 0) throw new AppError('Tem không còn phần chờ sửa', { status: 409, errorCode: 'DONE' });

  const huyThang = num(body.soLuongHuyThang);
  const suaDat = num(body.soLuongSuaDat);
  const suaHuy = num(body.soLuongSuaHuy) + huyThang;
  const total = suaDat + suaHuy; // SL xử lý lần này
  if (total <= 0) throw new AppError('Nhập số lượng sửa', { status: 422, errorCode: 'EMPTY' });
  if (total > conSua) throw new AppError(`SL sửa lần này (${total}) vượt SL cần sửa còn lại (${conSua})`, { status: 422, errorCode: 'OVER' });

  const ghiChu = [body.ghiChu, huyThang > 0 ? `Hủy thẳng: ${huyThang}` : null].filter(Boolean).join(' · ') || null;

  await withTransaction(async (client) => {
    await repo.insertSua(client, temId, { soLuongSua: total, soLuongSuaDat: suaDat, soLuongSuaHuy: suaHuy, ghiChu }, actorId);
    // Sửa đạt → quay lại pool OQC; sửa hủy → hủy.
    await repo.addSuaLedger(client, temId, { dat: suaDat, huy: suaHuy }, actorId);
    await repo.recomputeTemStage(client, temId, actorId);
  });
  await tracking.moveByTem(temId, 'SUA', actorId);
  await repo.resolveReturns('OQC_SUA', temId); // Sửa làm lại xong → tắt cờ "bị OQC trả về"
  sockets.emit('quality:updated', { temId, stage: 'SUA' });
  sockets.emit('dashboard:refresh', {});
  return { tem_id: temId, next: 'SUA', so_luong_sua_dat: suaDat, con_sua: conSua - total };
}

// ----- HỦY TEM SỬA — trang "Hủy lệnh xác nhận" -----
// "Tem sửa" (nhãn 16-) = PHẦN CHỜ SỬA của tem (`con_sua`), không phải dòng tem riêng. Hủy = XÓA SL sửa:
//   · KCS đã có SL đạt (`sl_kcs_dat > 0`) → SL sửa dồn sang **hủy** (`sl_kcs_huy`), tem KHÔNG về màn KCS.
//   · Chưa có SL đạt (`sl_kcs_dat = 0`)   → **chỉ xóa** SL sửa ⇒ SL quay lại `con_kcs` (KCS kiểm lại).
// Cả 2 nhánh đều giữ `so_luong` tem không đổi; `con_sua`→0 nên tem tự rời màn Sửa (không cần cờ ẩn).
const listTemSuaCancelable = ({ search } = {}) => repo.listTemSua({ search });
const listTemSuaDeleted = ({ search } = {}) => repo.listTemSuaDaHuy({ search });

// Hủy: dồn con_sua sang hủy khi đã có SL đạt KCS, ngược lại chỉ trừ SL sửa.
const planHuy = (t) => {
  const x = Number(t.con_sua) || 0;
  const daCongHuy = (Number(t.sl_kcs_dat) || 0) > 0;
  return { temId: t.tem_id, ma_tem: t.ma_tem, sl: x, da_cong_huy: daCongHuy, dSua: -x, dHuy: daCongHuy ? x : 0 };
};

// Đọc + validate cả lô TRƯỚC khi ghi (không áp dụng một phần khi 1 tem trong lô hỏng); 1 query đọc cho cả lô.
async function loadTemSuaBatch(temIds, verb) {
  const ids = [...new Set((temIds || []).filter(Boolean))];
  if (ids.length === 0) throw new AppError(`Chọn tem sửa cần ${verb}`, { status: 422, errorCode: 'EMPTY' });
  const rows = await repo.getTemSuaRows(ids);
  if (rows.length !== ids.length) throw new AppError('Tem không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  return rows;
}

async function huyTemSua(temIds, lyDo, actorId, tuDong = false) {
  const reason = (lyDo || '').trim();
  if (!reason) throw new AppError('Nhập lý do hủy tem sửa', { status: 422, errorCode: 'NO_LY_DO' });
  const rows = await loadTemSuaBatch(temIds, 'hủy');
  for (const t of rows) {
    if ((Number(t.con_sua) || 0) <= 0) {
      throw new AppError(`Tem ${t.ma_tem} không còn phần chờ sửa để hủy`, { status: 409, errorCode: 'NO_SUA' });
    }
  }
  const plans = rows.map(planHuy);
  await withTransaction(async (client) => { await applyHuyTemSua(client, plans, reason, actorId, tuDong); });
  sockets.emit('quality:updated', { stage: 'SUA', action: 'HUY_TEM_SUA' });
  sockets.emit('dashboard:refresh', {});
  return temSuaResult(plans);
}

// Áp dụng hủy trong 1 transaction ĐANG MỞ (dùng chung cho tab Hủy tem sửa + OQC trả về KCS tự hủy).
async function applyHuyTemSua(client, plans, reason, actorId, tuDong) {
  await repo.applyTemSuaLedgerMany(client, plans, actorId);
  await repo.recomputeTemStageMany(client, plans.map((p) => p.temId), actorId);
  // Snapshot delta để "Mở lại tem sửa" đảo ngược chính xác.
  await repo.logTemSuaMany(client, 'HUY_TEM_SUA', plans.map((p) => ({
    temId: p.temId,
    payload: { ma_tem: p.ma_tem, ly_do: reason, tu_dong: !!tuDong, sl: p.sl, da_cong_huy: p.da_cong_huy },
  })), actorId);
}

const temSuaResult = (plans) => ({
  so_tem: plans.length,
  items: plans.map((p) => ({ tem_id: p.temId, ma_tem: p.ma_tem, sl: p.sl, da_cong_huy: p.da_cong_huy })),
});

// Mở lại tem sửa đã hủy — đảo đúng 2 delta của lần hủy gần nhất (đọc snapshot từ audit_log).
async function moTemSua(temIds, lyDo, actorId) {
  const ids = [...new Set((temIds || []).filter(Boolean))];
  if (ids.length === 0) throw new AppError('Chọn tem sửa cần mở lại', { status: 422, errorCode: 'EMPTY' });
  const all = await repo.listTemSuaDaHuy({});
  const byId = new Map(all.map((r) => [r.tem_id, r]));

  const plans = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) throw new AppError('Tem sửa không ở trạng thái đã hủy', { status: 409, errorCode: 'NOT_CANCELLED' });
    const x = Number(r.sl_huy) || 0;
    if (x <= 0) throw new AppError(`Tem ${r.ma_tem}: lần hủy không có số lượng để mở lại`, { status: 409, errorCode: 'NO_QTY' });
    // Guard đảo sổ cái: SL phải còn nguyên ở nơi lần hủy đã đẩy nó tới.
    if (r.da_cong_huy && (Number(r.sl_kcs_huy) || 0) < x) {
      throw new AppError(`Tem ${r.ma_tem}: SL hủy đã đổi — không mở lại được`, { status: 409, errorCode: 'LEDGER' });
    }
    if (!r.da_cong_huy && (Number(r.con_kcs) || 0) < x) {
      throw new AppError(`Tem ${r.ma_tem}: ${x} pcs đã được KCS kiểm lại — không mở lại được`, { status: 409, errorCode: 'LEDGER' });
    }
    plans.push({ temId: id, ma_tem: r.ma_tem, sl: x, da_cong_huy: r.da_cong_huy, dSua: x, dHuy: r.da_cong_huy ? -x : 0 });
  }

  await withTransaction(async (client) => {
    await repo.applyTemSuaLedgerMany(client, plans, actorId);
    await repo.recomputeTemStageMany(client, plans.map((p) => p.temId), actorId);
    await repo.logTemSuaMany(client, 'MO_TEM_SUA', plans.map((p) => ({
      temId: p.temId,
      payload: { ma_tem: p.ma_tem, ly_do: (lyDo || '').trim() || null, sl: p.sl, da_cong_huy: p.da_cong_huy },
    })), actorId);
  });
  sockets.emit('quality:updated', { stage: 'SUA', action: 'MO_TEM_SUA' });
  sockets.emit('dashboard:refresh', {});
  return temSuaResult(plans);
}

// ----- OQC (còn phần chờ kiểm cuối: con_oqc > 0) -----
async function listOqcCandidates({ search, filters }) {
  const rows = await repo.listOqcCand({ search, filters });
  await attachPrevConfirmer(rows, 'nguoi_kcs_sua'); // trạm trước của OQC = KCS hoặc Sửa (mới nhất)
  return rows;
}

// OQC = kiểm BỐC MẪU theo từng NGUỒN (KCS-đạt = tem 15- / Sửa-đạt = tem 17-):
//  - so_luong_kiem = SL BỐC MẪU (mẫu lấy ra), so_luong_dat ≤ bốc mẫu.
//  - Kết quả ĐẠT (hoặc cho giao ngoại lệ) → TOÀN BỘ phần chờ OQC của nguồn đó qua Giao (không phải kiểm bao nhiêu qua bấy nhiêu).
//  - Không đạt & không cho giao → nằm lại OQC (cả lô).
async function recordOqc(temId, body, actorId) {
  const tem = await repo.getTemLedger(temId);
  if (!tem) throw new AppError('Tem không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const nguon = body.nguon === 'SUA' ? 'SUA' : 'KCS';
  const pending = nguon === 'SUA' ? (Number(tem.con_oqc_sua) || 0) : (Number(tem.con_oqc_kcs) || 0);
  const nhan = nguon === 'SUA' ? 'đã sửa (tem 17-)' : 'đạt từ KCS (tem 15-)';
  if (pending <= 0) throw new AppError(`Tem không còn phần chờ OQC nguồn ${nhan}`, { status: 409, errorCode: 'DONE' });

  const bocMau = num(body.soLuongKiem);   // SL bốc mẫu
  const dat = num(body.soLuongDat);        // đạt trong mẫu
  if (bocMau <= 0) throw new AppError('Nhập SL bốc mẫu', { status: 422, errorCode: 'EMPTY' });
  if (dat > bocMau) throw new AppError(`SL đạt (${dat}) không vượt SL bốc mẫu (${bocMau})`, { status: 422, errorCode: 'DAT_OVER' });
  if (bocMau > pending) throw new AppError(`SL bốc mẫu (${bocMau}) vượt SL chờ OQC của nguồn ${nhan} (${pending})`, { status: 422, errorCode: 'OVER' });
  const loi = bocMau - dat;
  const ketQua = body.ketQua === 'KHONG_DAT' ? 'KHONG_DAT' : 'DAT';
  const lanKiem = await repo.nextOqcRound(temId);

  const ownerChoGiaoId = body.ownerChoGiaoId || null;
  const lyDoChoGiao = (body.lyDoChoGiao || '').trim() || null;
  const truongHopGiaoId = body.truongHopGiaoId || null;
  let choGiao = false;
  let next;

  if (ketQua === 'DAT') {
    next = 'OQC_DAT'; // đạt → sẵn sàng giao (cả lô nguồn)
  } else if (ownerChoGiaoId) {
    // Không đạt nhưng CHO GIAO NGOẠI LỆ — chỉ cần OWNER chịu trách nhiệm + LÝ DO.
    // (Bỏ yêu cầu chọn "trường hợp giao đặc biệt"; cột truong_hop_giao_id giữ lại cho dữ liệu cũ.)
    if (!lyDoChoGiao) throw new AppError('Cho giao ngoại lệ cần nhập lý do', { status: 422, errorCode: 'NO_LY_DO' });
    choGiao = true;
    next = 'CHO_GIAO_NGOAI_LE';
  } else {
    next = 'GIU_OQC'; // không đạt & chưa có owner cho giao → NẰM LẠI OQC (cả lô)
  }

  // ĐẠT / cho giao ngoại lệ → TOÀN BỘ phần chờ OQC của nguồn qua "chờ giao".
  const quaGiao = (ketQua === 'DAT' || choGiao) ? pending : 0;
  await withTransaction(async (client) => {
    await repo.insertOqc(client, temId, {
      lanKiem, soLuongKiem: bocMau, soLuongDat: dat, soLuongLoi: loi,
      ketQua, choGiao, lyDoChoGiao, ownerChoGiaoId, truongHopGiaoId, ghiChu: body.ghiChu,
      nguon, slQuaGiao: quaGiao,
    }, actorId);
    if (quaGiao > 0) await repo.addOqcLedger(client, temId, quaGiao, actorId, nguon === 'SUA');
    await repo.recomputeTemStage(client, temId, actorId);
  });
  await tracking.moveByTem(temId, 'OQC', actorId);
  if (quaGiao > 0) await tracking.moveByTem(temId, 'FINISH', actorId);
  sockets.emit('quality:updated', { temId, stage: 'OQC', next });
  sockets.emit('dashboard:refresh', {});
  return { tem_id: temId, next, nguon, qua_giao: quaGiao };
}

const q0 = (v) => (v === null || v === undefined ? 0 : v);

async function kcsHistory(date) {
  const rows = await repo.kcsHistoryByDate(date);
  return rows.map((r) => {
    const cl = q0(r.so_luong_chenh_lech);
    const chenh = cl ? ` · Chênh ${cl > 0 ? '+' + cl : cl}` : '';
    return {
      tg: r.tg, nguoi: r.nguoi || '—',
      hanh_dong: `KCS${r.ket_qua ? ' · ' + r.ket_qua : ''}`,
      doi_tuong: r.ma_tem || '',
      chi_tiet: `Đạt ${q0(r.so_luong_dat)} · Hư ${q0(r.so_luong_loi)} · Hủy ${q0(r.so_luong_huy)}${chenh}`,
    };
  });
}

async function suaHistory(date) {
  const rows = await repo.suaHistoryByDate(date);
  return rows.map((r) => ({
    tg: r.tg, nguoi: r.nguoi || '—', hanh_dong: 'Sửa',
    doi_tuong: r.ma_tem || '',
    chi_tiet: `Sửa ${q0(r.so_luong_sua)} · Đạt ${q0(r.so_luong_sua_dat)} · Hủy ${q0(r.so_luong_sua_huy)}`,
  }));
}

async function oqcHistory(date) {
  const rows = await repo.oqcHistoryByDate(date);
  const src = (n) => (n === 'SUA' ? 'Sửa' : 'KCS');
  const pre = (n) => (n === 'SUA' ? '17-' : '15-');
  return rows.map((r) => ({
    tg: r.tg, nguoi: r.nguoi || '—',
    hanh_dong: `OQC${r.ket_qua ? ' · ' + r.ket_qua : ''}`,
    doi_tuong: `${pre(r.nguon)}${r.ma_tem || ''}`,
    // Thêm NGUỒN (KCS/Sửa) + SL từ nguồn đó chuyền qua giao (sl_qua_giao).
    chi_tiet: `Nguồn ${src(r.nguon)} · Bốc mẫu ${q0(r.so_luong_kiem)} · Đạt ${q0(r.so_luong_dat)} · Qua giao ${q0(r.sl_qua_giao)}`,
  }));
}

// ----- HỦY XÁC NHẬN KCS / SỬA / OQC (lỡ xác nhận lộn / nhập sai số) -----
// Đảo sổ cái tem về trước lần xác nhận + đánh dấu bản ghi đã hủy (audit_log). Chỉ hủy được khi phần
// SL của lần đó CHƯA đi tiếp công đoạn sau (đạt chưa lên OQC, sửa chưa xử lý, OQC chưa giao).
async function listCancelKcs(date) { return repo.listCancelKcs(date); }
async function listCancelSua(date) { return repo.listCancelSua(date); }
async function listCancelOqc(date) { return repo.listCancelOqc(date); }

const N = (v) => Number(v) || 0;

async function cancelKcs(kcsId, lyDo, actorId) {
  const r = await repo.getCancelKcsRow(kcsId);
  if (!r) throw new AppError('Bản ghi KCS không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (r.da_huy) throw new AppError('Lần xác nhận này đã bị hủy', { status: 409, errorCode: 'ALREADY' });
  const dat = N(r.so_luong_dat);
  const sua = N(r.so_luong_kiem) - N(r.so_luong_dat) - N(r.so_luong_huy); // = quyết định sửa lần đó
  const huy = N(r.so_luong_huy);
  const chenh = N(r.so_luong_chenh_lech);
  const newDat = N(r.sl_kcs_dat) - dat;
  const newSua = N(r.sl_kcs_sua) - sua;
  const newHuy = N(r.sl_kcs_huy) - huy;
  if (newDat < 0 || newSua < 0 || newHuy < 0) {
    throw new AppError('Không thể đảo sổ cái (số liệu đã đổi) — không hủy được lần KCS này', { status: 409, errorCode: 'LEDGER' });
  }
  if (newDat + N(r.sl_sua_dat) < N(r.sl_oqc_dat)) {
    throw new AppError('Phần đạt của lần KCS này đã đi tiếp OQC — hủy xác nhận OQC trước', { status: 409, errorCode: 'CONSUMED_OQC' });
  }
  if (newSua < N(r.sl_sua_dat) + N(r.sl_sua_huy)) {
    throw new AppError('Phần sửa của lần KCS này đã được xử lý ở màn Sửa — hủy xác nhận Sửa trước', { status: 409, errorCode: 'CONSUMED_SUA' });
  }
  await withTransaction(async (client) => {
    await repo.addKcsLedger(client, r.tem_id, { dat: -dat, sua: -sua, huy: -huy, chenh: -chenh }, actorId);
    await repo.recomputeTemStage(client, r.tem_id, actorId);
  });
  await repo.logCancelQc('kcs', kcsId, r.tem_id, r.ma_tem, lyDo, actorId);
  await tracking.moveByTem(r.tem_id, 'KIEM', actorId);
  sockets.emit('quality:updated', { temId: r.tem_id, stage: 'KCS', huy: true });
  sockets.emit('dashboard:refresh', {});
  return { tem_id: r.tem_id, ma_tem: r.ma_tem };
}

async function cancelSua(suaId, lyDo, actorId) {
  const r = await repo.getCancelSuaRow(suaId);
  if (!r) throw new AppError('Bản ghi Sửa không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (r.da_huy) throw new AppError('Lần xác nhận này đã bị hủy', { status: 409, errorCode: 'ALREADY' });
  const dat = N(r.so_luong_sua_dat);
  const huy = N(r.so_luong_sua_huy);
  const newDat = N(r.sl_sua_dat) - dat;
  const newHuy = N(r.sl_sua_huy) - huy;
  if (newDat < 0 || newHuy < 0) {
    throw new AppError('Không thể đảo sổ cái (số liệu đã đổi) — không hủy được lần Sửa này', { status: 409, errorCode: 'LEDGER' });
  }
  if (N(r.sl_kcs_dat) + newDat < N(r.sl_oqc_dat)) {
    throw new AppError('Phần sửa đạt của lần này đã đi tiếp OQC — hủy xác nhận OQC trước', { status: 409, errorCode: 'CONSUMED_OQC' });
  }
  await withTransaction(async (client) => {
    await repo.addSuaLedger(client, r.tem_id, { dat: -dat, huy: -huy }, actorId);
    await repo.recomputeTemStage(client, r.tem_id, actorId);
  });
  await repo.logCancelQc('sua', suaId, r.tem_id, r.ma_tem, lyDo, actorId);
  await tracking.moveByTem(r.tem_id, 'SUA', actorId);
  sockets.emit('quality:updated', { temId: r.tem_id, stage: 'SUA', huy: true });
  sockets.emit('dashboard:refresh', {});
  return { tem_id: r.tem_id, ma_tem: r.ma_tem };
}

async function cancelOqc(oqcId, lyDo, actorId) {
  const r = await repo.getCancelOqcRow(oqcId);
  if (!r) throw new AppError('Bản ghi OQC không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (r.da_huy) throw new AppError('Lần xác nhận này đã bị hủy', { status: 409, errorCode: 'ALREADY' });
  const nguonSua = r.nguon === 'SUA';
  // SL đã cộng vào "chờ giao" ở lần này = sl_qua_giao (mig 047). Dữ liệu cũ (null) suy theo công thức cũ.
  const oqcDatInc = r.sl_qua_giao != null && r.nguon != null
    ? N(r.sl_qua_giao)
    : N(r.so_luong_dat) + (r.cho_giao ? N(r.so_luong_loi) : 0);
  const newOqcDat = N(r.sl_oqc_dat) - oqcDatInc;
  if (newOqcDat < 0) {
    throw new AppError('Không thể đảo sổ cái (số liệu đã đổi) — không hủy được lần OQC này', { status: 409, errorCode: 'LEDGER' });
  }
  if (newOqcDat < N(r.sl_da_giao)) {
    throw new AppError('Phần OQC đạt của lần này đã được GIAO — không thể hủy xác nhận OQC', { status: 409, errorCode: 'DELIVERED' });
  }
  // Nguồn SỬA: đảm bảo không âm sl_oqc_dat_sua khi đảo.
  if (nguonSua && N(r.sl_oqc_dat_sua) - oqcDatInc < 0) {
    throw new AppError('Không thể đảo sổ cái nguồn sửa — không hủy được lần OQC này', { status: 409, errorCode: 'LEDGER' });
  }
  await withTransaction(async (client) => {
    if (oqcDatInc > 0) await repo.addOqcLedger(client, r.tem_id, -oqcDatInc, actorId, nguonSua);
    await repo.recomputeTemStage(client, r.tem_id, actorId);
  });
  await repo.logCancelQc('oqc', oqcId, r.tem_id, r.ma_tem, lyDo, actorId);
  await tracking.moveByTem(r.tem_id, 'OQC', actorId);
  sockets.emit('quality:updated', { temId: r.tem_id, stage: 'OQC', huy: true });
  sockets.emit('dashboard:refresh', {});
  return { tem_id: r.tem_id, ma_tem: r.ma_tem };
}

// Hành trình 1 tem (gộp KCS/Sửa/OQC/Giao) — cho panel "Hành trình theo tem".
async function temHanhTrinh(temId) {
  const tem = await repo.getTemLedger(temId);
  if (!tem) throw new AppError('Tem không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const rows = await repo.temTimeline(temId);
  const events = rows.map((r) => {
    const n = (v) => q0(v);
    let chi_tiet = '';
    if (r.loai === 'KCS') {
      const cl = n(r.n5);
      chi_tiet = `Kiểm ${n(r.n1)} · Đạt ${n(r.n2)} · Hư ${n(r.n3)} · Hủy ${n(r.n4)}`
        + (cl ? ` · Chênh ${cl > 0 ? '+' + cl : cl}` : '') + (r.txt ? ` · ${r.txt}` : '');
    } else if (r.loai === 'SUA') {
      chi_tiet = `Sửa ${n(r.n1)} · Đạt ${n(r.n2)} · Hủy ${n(r.n3)}`;
    } else if (r.loai === 'OQC') {
      chi_tiet = `Kiểm ${n(r.n1)} · Đạt ${n(r.n2)} · Lỗi ${n(r.n3)}` + (r.txt ? ` · ${r.txt}` : '');
    } else if (r.loai === 'GIAO') {
      chi_tiet = `Giao ${n(r.n1)}` + (r.txt ? ` · Phiếu ${r.txt}` : '');
    }
    return { loai: r.loai, tg: r.tg, nguoi: r.nguoi || '—', so_luong: n(r.n1), chi_tiet };
  });
  return {
    tem: {
      tem_id: tem.id, ma_tem: tem.ma_tem, so_luong: tem.so_luong, trang_thai: tem.trang_thai,
      con_kcs: tem.con_kcs, con_sua: tem.con_sua, con_oqc: tem.con_oqc, con_giao: tem.con_giao,
    },
    events,
  };
}

// ----- Danh sách "đã hoàn thành" theo ngày (cho DonePanel bên trái) -----
async function kcsDone(date) { return repo.temDoneByDate('kcs', date); }
async function suaDone(date) { return repo.temDoneByDate('sua', date); }
async function oqcDone(date) { return repo.temDoneByDate('oqc', date); }
async function inlineDone(date) { return repo.inlineDoneByDate(date); }

// ----- QC IN-LINE (kiểm tại chuyền — phiếu đang chạy) -----
async function listInlineCandidates(search) { return repo.listInlineCandidates({ search }); }
async function listLoaiLoi() { return repo.listLoaiLoiActive(); }

async function recordQcInline(phieuId, body, actorId) {
  const phieu = await repo.getPhieuRun(phieuId);
  if (!phieu) throw new AppError('Phiếu sản xuất không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (phieu.trang_thai !== 'DANG_CHAY') {
    throw new AppError('Chỉ QC in-line phiếu đang chạy', { status: 409, errorCode: 'WRONG_STAGE' });
  }
  const soLuongMau = num(body.soLuongMau);
  const soLuongLoi = num(body.soLuongLoi);
  if (soLuongMau <= 0) throw new AppError('Nhập số lượng mẫu kiểm', { status: 422, errorCode: 'INVALID_QTY' });
  if (soLuongLoi > soLuongMau) throw new AppError('SL mẫu lỗi không vượt SL mẫu kiểm', { status: 422, errorCode: 'INVALID_QTY' });
  const ketQua = body.ketQua === 'KHONG_DAT' ? 'KHONG_DAT' : 'DAT';
  const loiList = Array.isArray(body.loi) ? body.loi.filter((x) => x && x.loaiLoiId) : [];

  const lanKiem = await repo.nextInlineRound(phieuId);
  await withTransaction(async (client) => {
    const qcId = await repo.insertQcInline(client, {
      phieuId, lenhId: phieu.lenh_san_xuat_id, lanKiem, soLuongMau, soLuongLoi, ketQua,
      nguyenNhan: body.nguyenNhan, khacPhuc: body.khacPhuc, ghiChu: body.ghiChu,
    }, actorId);
    for (const l of loiList) {
      await repo.insertQcInlineLoi(client, qcId, { loaiLoiId: l.loaiLoiId, soLuong: l.soLuong, ghiChu: l.ghiChu }, actorId);
    }
  });
  sockets.emit('quality:updated', { phieuId, stage: 'QC_INLINE', ketQua });
  return { phieu_id: phieuId, lan_kiem: lanKiem, ket_qua: ketQua };
}

async function inlineHistory(date) {
  const rows = await repo.inlineHistoryByDate(date);
  return rows.map((r) => ({
    tg: r.tg, nguoi: r.nguoi || '—',
    hanh_dong: `QC in-line${r.ket_qua ? ' · ' + (r.ket_qua === 'DAT' ? 'Đạt' : 'Không đạt') : ''}`,
    doi_tuong: `${r.ma_phan || r.ma_phieu_san_xuat || ''}`,
    chi_tiet: [
      `Mẫu ${q0(r.so_luong_mau)} · Lỗi ${q0(r.so_luong_loi)}`,
      r.loi_list ? `Loại: ${r.loi_list}` : null,
      r.nguyen_nhan ? `NN: ${r.nguyen_nhan}` : null,
      r.khac_phuc ? `KP: ${r.khac_phuc}` : null,
    ].filter(Boolean).join(' · '),
  }));
}

// ----- DANH MỤC LỖI -----
async function listLoaiLoiAll(search) { return repo.listLoaiLoiAll(search || ''); }

async function createLoaiLoi(body, actorId) {
  if (!body.maLoi || !body.tenLoi) throw new AppError('Nhập mã lỗi và tên lỗi', { status: 422, errorCode: 'MISSING' });
  const id = await repo.insertLoaiLoi({ maLoi: body.maLoi.trim(), tenLoi: body.tenLoi.trim(), nhomLoi: body.nhomLoi }, actorId);
  return { id };
}

async function updateLoaiLoi(id, body, actorId) {
  if (!body.tenLoi) throw new AppError('Nhập tên lỗi', { status: 422, errorCode: 'MISSING' });
  await repo.updateLoaiLoi(id, { tenLoi: body.tenLoi.trim(), nhomLoi: body.nhomLoi }, actorId);
  return { id };
}

async function toggleLoaiLoi(id, active, actorId) {
  await repo.setLoaiLoiActive(id, !!active, actorId);
  return { id };
}

// ----- DANH MỤC TRƯỜNG HỢP GIAO ĐẶC BIỆT -----
async function listGiaoDacBiet() { return repo.listGiaoDacBietActive(); }
async function listGiaoDacBietAll(search) { return repo.listGiaoDacBietAll(search || ''); }

async function createGiaoDacBiet(body, actorId) {
  if (!body.ma || !body.ten) throw new AppError('Nhập mã và tên trường hợp', { status: 422, errorCode: 'MISSING' });
  const id = await repo.insertGiaoDacBiet({ ma: body.ma.trim().toUpperCase(), ten: body.ten.trim() }, actorId);
  return { id };
}

async function updateGiaoDacBiet(id, body, actorId) {
  if (!body.ten) throw new AppError('Nhập tên trường hợp', { status: 422, errorCode: 'MISSING' });
  await repo.updateGiaoDacBiet(id, { ten: body.ten.trim() }, actorId);
  return { id };
}

async function toggleGiaoDacBiet(id, active, actorId) {
  await repo.setGiaoDacBietActive(id, !!active, actorId);
  return { id };
}

module.exports = {
  listKcsCandidates, recordKcs, gopTem, listSuaCandidates, recordSua, listOqcCandidates, recordOqc,
  listCancelKcs, listCancelSua, listCancelOqc, cancelKcs, cancelSua, cancelOqc,
  listTemSuaCancelable, listTemSuaDeleted, huyTemSua, moTemSua,
  kcsHistory, suaHistory, oqcHistory, temHanhTrinh,
  kcsDone, suaDone, oqcDone, inlineDone,
  listInlineCandidates, listLoaiLoi, recordQcInline, inlineHistory,
  listLoaiLoiAll, createLoaiLoi, updateLoaiLoi, toggleLoaiLoi,
  listGiaoDacBiet, listGiaoDacBietAll, createGiaoDacBiet, updateGiaoDacBiet, toggleGiaoDacBiet,
  returnOqcToKcs, qcTraVeHistory,
};
