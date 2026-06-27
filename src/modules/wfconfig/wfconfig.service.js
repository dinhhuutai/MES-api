'use strict';

const { withTransaction } = require('../../config/db');
const repo = require('./wfconfig.repository');
const AppError = require('../../utils/AppError');
const sockets = require('../../sockets');

function validateJson(str) {
  if (str === undefined || str === null || str === '') return null;
  try {
    JSON.parse(str);
    return str;
  } catch {
    throw new AppError('cau_hinh_json không phải JSON hợp lệ', { status: 422, errorCode: 'INVALID_JSON' });
  }
}

const emit = () => sockets.emit('workflow:config-updated', {});

module.exports = {
  // Version
  listVersions: () => repo.listVersions(),
  createVersion: (b, a) => repo.createVersion(b, a).then((id) => ({ id })),
  updateVersion: async (id, b, a) => { await repo.updateVersion(id, b, a); return { id }; },
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
