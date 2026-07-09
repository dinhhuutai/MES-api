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
  rows.forEach((r) => { r.tra_ve_ly_do = rm[r.tem_id] || null; });
  await attachPrevConfirmer(rows, 'nguoi_in'); // trạm trước của KCS = in tem
  return rows;
}

// Gắn "người xác nhận trạm trước" vào từng dòng (field `nguoi_truoc`) — query nhẹ theo tem_id.
async function attachPrevConfirmer(rows, key) {
  if (!rows || rows.length === 0) return;
  const pc = await repo.prevConfirmerByTems(rows.map((r) => r.tem_id));
  const map = new Map(pc.map((x) => [x.tem_id, x]));
  rows.forEach((r) => { r.nguoi_truoc = (map.get(r.tem_id) || {})[key] || null; });
}

// OQC trả tem về KCS (kèm lý do bắt buộc). Đưa phần đang CHỜ OQC (con_oqc) quay lại chưa kiểm (con_kcs).
async function returnOqcToKcs(temId, body, actorId) {
  const lyDo = (body.lyDo || '').trim();
  if (!lyDo) throw new AppError('Nhập lý do trả về KCS', { status: 422, errorCode: 'NO_LY_DO' });
  const tem = await repo.getTemLedger(temId);
  if (!tem) throw new AppError('Tem không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const con = Number(tem.con_oqc) || 0;
  if (con <= 0) throw new AppError('Tem không còn phần chờ OQC để trả về', { status: 409, errorCode: 'NO_OQC' });
  await withTransaction(async (client) => {
    await repo.reduceKcsDat(client, temId, con, actorId); // phần chờ OQC → về chưa kiểm (KCS)
    await repo.recomputeTemStage(client, temId, actorId);
  });
  await repo.insertQcTraVe({ loai: 'OQC', temId, lyDo }, actorId);
  await tracking.moveByTem(temId, 'KIEM', actorId);
  sockets.emit('quality:updated', { temId, stage: 'OQC', next: 'TRA_VE_KCS' });
  sockets.emit('dashboard:refresh', {});
  return { tem_id: temId, next: 'TRA_VE_KCS' };
}

// Lịch sử QC trả về theo loại + ngày (cho trang toggle 3 loại).
async function qcTraVeHistory(loai, date) {
  const L = ['READY', 'TEST_RUN', 'OQC'].includes(loai) ? loai : 'READY';
  return repo.listQcTraVe(L, date);
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
    return { ...r, ca: caFromParts(p.ca_gio, p.ca_nam, p.ca_tuan, map) };
  });
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
  sockets.emit('quality:updated', { temId, stage: 'SUA' });
  return { tem_id: temId, next: 'SUA', so_luong_sua_dat: suaDat, con_sua: conSua - total };
}

// ----- OQC (còn phần chờ kiểm cuối: con_oqc > 0) -----
async function listOqcCandidates({ search, filters }) {
  const rows = await repo.listOqcCand({ search, filters });
  await attachPrevConfirmer(rows, 'nguoi_kcs_sua'); // trạm trước của OQC = KCS hoặc Sửa (mới nhất)
  return rows;
}

async function recordOqc(temId, body, actorId) {
  const tem = await repo.getTemLedger(temId);
  if (!tem) throw new AppError('Tem không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const conOqc = Number(tem.con_oqc) || 0;
  if (conOqc <= 0) throw new AppError('Tem không còn phần chờ OQC', { status: 409, errorCode: 'DONE' });
  const dat = num(body.soLuongDat);
  const loi = num(body.soLuongLoi);
  const kiem = dat + loi;
  if (kiem <= 0) throw new AppError('Nhập số lượng kiểm', { status: 422, errorCode: 'EMPTY' });
  if (kiem > conOqc) throw new AppError(`SL kiểm lần này (${kiem}) vượt SL chờ OQC (${conOqc})`, { status: 422, errorCode: 'OVER' });
  const ketQua = body.ketQua === 'KHONG_DAT' ? 'KHONG_DAT' : 'DAT';
  const lanKiem = await repo.nextOqcRound(temId);

  const ownerChoGiaoId = body.ownerChoGiaoId || null;
  const lyDoChoGiao = (body.lyDoChoGiao || '').trim() || null;
  const truongHopGiaoId = body.truongHopGiaoId || null;
  let choGiao = false;
  let next;

  if (ketQua === 'DAT') {
    next = 'OQC_DAT'; // đạt → sẵn sàng giao
  } else if (ownerChoGiaoId) {
    // Không đạt nhưng CHO GIAO NGOẠI LỆ — bắt buộc có TRƯỜNG HỢP giao đặc biệt + lý do + owner.
    if (!truongHopGiaoId) throw new AppError('Cho giao ngoại lệ cần chọn trường hợp giao đặc biệt', { status: 422, errorCode: 'NO_TRUONG_HOP' });
    if (!lyDoChoGiao) throw new AppError('Cho giao ngoại lệ cần nhập lý do', { status: 422, errorCode: 'NO_LY_DO' });
    choGiao = true;
    next = 'CHO_GIAO_NGOAI_LE'; // tem → OQC_DAT (đánh dấu cho giao ngoại lệ)
  } else {
    next = 'GIU_OQC'; // không đạt & chưa có owner cho giao → NẰM LẠI OQC
  }

  // SL cộng vào "chờ giao": phần đạt; nếu cho giao ngoại lệ thì cả phần lỗi cũng cho giao.
  const oqcDatInc = dat + (choGiao ? loi : 0);
  await withTransaction(async (client) => {
    await repo.insertOqc(client, temId, {
      lanKiem, soLuongKiem: kiem, soLuongDat: dat, soLuongLoi: loi,
      ketQua, choGiao, lyDoChoGiao, ownerChoGiaoId, truongHopGiaoId, ghiChu: body.ghiChu,
    }, actorId);
    if (oqcDatInc > 0) await repo.addOqcLedger(client, temId, oqcDatInc, actorId); // → chờ giao
    // GIU_OQC (lỗi không cho giao): không cộng → phần lỗi vẫn nằm ở con_oqc (nằm lại OQC)
    await repo.recomputeTemStage(client, temId, actorId);
  });
  await tracking.moveByTem(temId, 'OQC', actorId); // theo dõi dòng chảy: OQC kiểm cuối
  if (oqcDatInc > 0) await tracking.moveByTem(temId, 'FINISH', actorId); // có phần cho giao → FINISH
  sockets.emit('quality:updated', { temId, stage: 'OQC', next });
  sockets.emit('dashboard:refresh', {});
  return { tem_id: temId, next };
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
    chi_tiet: `Sửa ${q0(r.so_luong_sua)} · Đạt ${q0(r.so_luong_sua_dat)}`,
  }));
}

async function oqcHistory(date) {
  const rows = await repo.oqcHistoryByDate(date);
  return rows.map((r) => ({
    tg: r.tg, nguoi: r.nguoi || '—',
    hanh_dong: `OQC${r.ket_qua ? ' · ' + r.ket_qua : ''}`,
    doi_tuong: r.ma_tem || '',
    chi_tiet: `Đạt ${q0(r.so_luong_dat)} · Lỗi ${q0(r.so_luong_loi)}`,
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
  const oqcDatInc = N(r.so_luong_dat) + (r.cho_giao ? N(r.so_luong_loi) : 0); // phần đã cộng vào "chờ giao"
  const newOqcDat = N(r.sl_oqc_dat) - oqcDatInc;
  if (newOqcDat < 0) {
    throw new AppError('Không thể đảo sổ cái (số liệu đã đổi) — không hủy được lần OQC này', { status: 409, errorCode: 'LEDGER' });
  }
  if (newOqcDat < N(r.sl_da_giao)) {
    throw new AppError('Phần OQC đạt của lần này đã được GIAO — không thể hủy xác nhận OQC', { status: 409, errorCode: 'DELIVERED' });
  }
  await withTransaction(async (client) => {
    if (oqcDatInc > 0) await repo.addOqcLedger(client, r.tem_id, -oqcDatInc, actorId);
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
  listKcsCandidates, recordKcs, listSuaCandidates, recordSua, listOqcCandidates, recordOqc,
  listCancelKcs, listCancelSua, listCancelOqc, cancelKcs, cancelSua, cancelOqc,
  kcsHistory, suaHistory, oqcHistory, temHanhTrinh,
  kcsDone, suaDone, oqcDone, inlineDone,
  listInlineCandidates, listLoaiLoi, recordQcInline, inlineHistory,
  listLoaiLoiAll, createLoaiLoi, updateLoaiLoi, toggleLoaiLoi,
  listGiaoDacBiet, listGiaoDacBietAll, createGiaoDacBiet, updateGiaoDacBiet, toggleGiaoDacBiet,
  returnOqcToKcs, qcTraVeHistory,
};
