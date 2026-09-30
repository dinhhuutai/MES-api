'use strict';

const { withTransaction } = require('../../config/db');
const repo = require('./wfconfig.repository');
const AppError = require('../../utils/AppError');
const sockets = require('../../sockets');
const wfCache = require('../../utils/wfCache');
const flowCache = require('../../utils/flowCache');
const sla = require('../../utils/slaTheoGio');

function validateJson(str) {
  if (str === undefined || str === null || str === '') return null;
  try {
    JSON.parse(str);
    return str;
  } catch {
    throw new AppError('cau_hinh_json không phải JSON hợp lệ', { status: 422, errorCode: 'INVALID_JSON' });
  }
}

// ⚠⚠ MỌI thao tác GHI cấu hình workflow phải đi qua đây: ngoài việc bắn socket, nó **xóa cache RAM**
//   (`utils/wfCache.js`) mà `technical.loadConfig` / `planning.loadTestConfig` đang dùng — không xóa
//   thì sửa workflow phải chờ hết TTL (60s) mới có hiệu lực. Thêm hàm ghi mới thì nhớ gọi `emit()`.
const emit = () => {
  wfCache.xoaCache();
  sockets.emit('workflow:config-updated', {});
};

// ─── SLA THEO GIỜ (mig 109) — khối ghi chú + sửa ở trang Checkpoint & Checklist ───
// Trả 4 luật: cấu hình ĐANG CHẠY (RAM, = DB hoặc mặc định) + mặc định + người/giờ sửa + SLA dự phòng.
async function listSlaGio() {
  await sla.napCauHinh();
  const [luu, duPhong] = await Promise.all([
    repo.listSlaGio().catch(() => null), // null = chưa chạy mig 109
    repo.slaDuPhong().catch(() => []),
  ]);
  const cfg = sla.layCauHinh();
  const theoMa = new Map((luu || []).map((r) => [r.ma, r]));
  return {
    co_bang: luu !== null,
    du_phong: duPhong,
    items: sla.MA_SLA.map((ma) => {
      const r = theoMa.get(ma) || {};
      return { ma, bat: cfg[ma].bat, gia_tri: cfg[ma].gia_tri, mac_dinh: sla.MAC_DINH[ma].gia_tri,
        ghi_chu: r.ghi_chu || null, nguoi_sua: r.nguoi_sua || null, tg_sua: r.updated_date || null };
    }),
  };
}

async function saveSlaGio(ma, b, actor) {
  if (!sla.MA_SLA.includes(ma)) throw new AppError('Luật SLA không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  let giaTri;
  try { giaTri = sla.chuanHoa(ma, b.giaTri); } catch (e) {
    throw new AppError(e.message, { status: 422, errorCode: 'SLA_KHONG_HOP_LE' });
  }
  try {
    await repo.saveSlaGio({ ma, bat: b.bat !== false, giaTri, ghiChu: b.ghiChu }, actor);
  } catch (e) {
    if (/cai_dat_sla_gio/.test(e.message || '')) {
      throw new AppError('Chưa chạy migration 109 (bảng cai_dat_sla_gio) — chưa lưu được', { status: 409, errorCode: 'CHUA_MIGRATION' });
    }
    throw e;
  }
  await sla.napCauHinh(); // có hiệu lực NGAY ở tiến trình này
  flowCache.xoaCache();
  emit();
  sockets.emit('dashboard:refresh', {});
  return listSlaGio();
}

module.exports = {
  listSlaGio, saveSlaGio,
  // Version
  listVersions: () => repo.listVersions(),
  createVersion: (b, a) => repo.createVersion(b, a).then((id) => { emit(); return { id }; }),
  updateVersion: async (id, b, a) => { await repo.updateVersion(id, b, a); emit(); return { id }; },
  setHienHanh: async (id, a) => {
    await withTransaction(async (c) => { await repo.clearHienHanh(c, a); await repo.setHienHanh(c, id, a); });
    emit();
    return { id };
  },
  // Tram
  listTrams: (vId) => repo.listTrams(vId),
  allTrams: (vId) => repo.allTrams(vId),
  createTram: (b, a) => repo.createTram(b, a).then((id) => (emit(), { id })),
  updateTram: async (id, b, a) => { await repo.updateTram(id, b, a); emit(); return { id }; },
  setTramActive: async (id, v, a) => { await repo.setTramActive(id, v, a); emit(); return { id }; },
  // Checkpoint
  listCheckpoints: (tId) => repo.listCheckpoints(tId),
  createCheckpoint: (b, a) => repo.createCheckpoint({ ...b, cauHinhJson: validateJson(b.cauHinhJson) }, a).then((id) => (emit(), { id })),
  updateCheckpoint: async (id, b, a) => { await repo.updateCheckpoint(id, { ...b, cauHinhJson: validateJson(b.cauHinhJson) }, a); emit(); return { id }; },
  setCheckpointActive: async (id, v, a) => { await repo.setCheckpointActive(id, v, a); emit(); return { id }; },
  // Rules
  listRules: (vId) => repo.listRules(vId),
  createRule: (b, a) => repo.createRule(b, a).then((id) => (emit(), { id })),
  updateRule: async (id, b, a) => { await repo.updateRule(id, b, a); emit(); return { id }; },
  setRuleActive: async (id, v, a) => { await repo.setRuleActive(id, v, a); emit(); return { id }; },
  // Conditions
  listConditions: (rId) => repo.listConditions(rId),
  createCondition: (b, a) => repo.createCondition(b, a).then((id) => (emit(), { id })),
  deleteCondition: async (id) => { await repo.deleteCondition(id); emit(); return {}; },
  // Owners
  listTramOwners: (tId) => repo.listTramOwners(tId),
  addTramOwner: async (b, a) => { await repo.addTramOwner(b, a); emit(); return {}; },
  removeTramOwner: async (id) => { await repo.removeTramOwner(id); emit(); return {}; },
  listCheckpointOwners: (cId) => repo.listCheckpointOwners(cId),
  addCheckpointOwner: async (b, a) => { await repo.addCheckpointOwner(b, a); emit(); return {}; },
  removeCheckpointOwner: async (id) => { await repo.removeCheckpointOwner(id); emit(); return {}; },
  // Status
  listStatuses: (q) => repo.listStatuses(q),
  createStatus: (b, a) => repo.createStatus(b, a).then((id) => ({ id })),
  updateStatus: async (id, b, a) => { await repo.updateStatus(id, b, a); return { id }; },
  setStatusActive: async (id, v, a) => { await repo.setStatusActive(id, v, a); return { id }; },
};
