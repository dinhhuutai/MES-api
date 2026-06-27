'use strict';

const s = require('./wfconfig.service');
const h = require('../../utils/asyncHandler');
const { ok, created } = require('../../utils/response');

const uid = (req) => req.user.id;

module.exports = {
  // Version
  listVersions: h(async (req, res) => ok(res, await s.listVersions())),
  createVersion: h(async (req, res) => created(res, await s.createVersion(req.body, uid(req)))),
  updateVersion: h(async (req, res) => ok(res, await s.updateVersion(req.params.id, req.body, uid(req)), 'Đã cập nhật')),
  setHienHanh: h(async (req, res) => ok(res, await s.setHienHanh(req.params.id, uid(req)), 'Đã đặt phiên bản hiện hành')),

  // Tram
  listTrams: h(async (req, res) => ok(res, await s.listTrams(req.query.versionId))),
  tramOptions: h(async (req, res) => ok(res, await s.allTrams(req.query.versionId))),
  createTram: h(async (req, res) => created(res, await s.createTram(req.body, uid(req)))),
  updateTram: h(async (req, res) => ok(res, await s.updateTram(req.params.id, req.body, uid(req)), 'Đã cập nhật')),
  setTramActive: h(async (req, res) => ok(res, await s.setTramActive(req.params.id, req.body.dangHoatDong === true, uid(req)), 'Đã cập nhật')),

  // Checkpoint
  listCheckpoints: h(async (req, res) => ok(res, await s.listCheckpoints(req.query.tramId))),
  createCheckpoint: h(async (req, res) => created(res, await s.createCheckpoint(req.body, uid(req)))),
  updateCheckpoint: h(async (req, res) => ok(res, await s.updateCheckpoint(req.params.id, req.body, uid(req)), 'Đã cập nhật')),
  setCheckpointActive: h(async (req, res) => ok(res, await s.setCheckpointActive(req.params.id, req.body.dangHoatDong === true, uid(req)), 'Đã cập nhật')),

  // Rules
  listRules: h(async (req, res) => ok(res, await s.listRules(req.query.versionId))),
  createRule: h(async (req, res) => created(res, await s.createRule(req.body, uid(req)))),
  updateRule: h(async (req, res) => ok(res, await s.updateRule(req.params.id, req.body, uid(req)), 'Đã cập nhật')),
  setRuleActive: h(async (req, res) => ok(res, await s.setRuleActive(req.params.id, req.body.dangHoatDong === true, uid(req)), 'Đã cập nhật')),

  // Conditions
  listConditions: h(async (req, res) => ok(res, await s.listConditions(req.query.ruleId))),
  createCondition: h(async (req, res) => created(res, await s.createCondition(req.body, uid(req)))),
  deleteCondition: h(async (req, res) => ok(res, await s.deleteCondition(req.params.id), 'Đã xóa điều kiện')),

  // Owners
  listTramOwners: h(async (req, res) => ok(res, await s.listTramOwners(req.query.tramId))),
  addTramOwner: h(async (req, res) => created(res, await s.addTramOwner(req.body, uid(req)), 'Đã thêm owner')),
  removeTramOwner: h(async (req, res) => ok(res, await s.removeTramOwner(req.params.id), 'Đã xóa owner')),
  listCheckpointOwners: h(async (req, res) => ok(res, await s.listCheckpointOwners(req.query.checkpointId))),
  addCheckpointOwner: h(async (req, res) => created(res, await s.addCheckpointOwner(req.body, uid(req)), 'Đã thêm owner')),
  removeCheckpointOwner: h(async (req, res) => ok(res, await s.removeCheckpointOwner(req.params.id), 'Đã xóa owner')),

  // Status
  listStatuses: h(async (req, res) => ok(res, await s.listStatuses({ search: req.query.search || '', nhom: req.query.nhom || '' }))),
  createStatus: h(async (req, res) => created(res, await s.createStatus(req.body, uid(req)))),
  updateStatus: h(async (req, res) => ok(res, await s.updateStatus(req.params.id, req.body, uid(req)), 'Đã cập nhật')),
  setStatusActive: h(async (req, res) => ok(res, await s.setStatusActive(req.params.id, req.body.dangHoatDong === true, uid(req)), 'Đã cập nhật')),
};
