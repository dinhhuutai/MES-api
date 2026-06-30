'use strict';

const service = require('./technical.service');
const asyncHandler = require('../../utils/asyncHandler');
const AppError = require('../../utils/AppError');
const { ok } = require('../../utils/response');
const { getPaging } = require('../../utils/pagination');

// Map mục kỹ thuật → quyền tương ứng (xác nhận theo từng bộ phận).
const ITEM_PERM = { KHUON: 'READY_KHUON', FILM: 'READY_FILM', MUC: 'READY_MUC', HSKT: 'READY_HSKT' };

const config = asyncHandler(async (req, res) => ok(res, await service.getConfig()));

const candidates = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  const data = await service.listCandidates({ search: req.query.search || '', page, limit, offset });
  return ok(res, data);
});

const qcCandidates = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  const data = await service.listCandidates({ search: req.query.search || '', page, limit, offset, onlyQcReady: true });
  return ok(res, data);
});

const detail = asyncHandler(async (req, res) => ok(res, await service.getDetail(req.params.phanInId)));

const history = asyncHandler(async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const scope = req.query.scope === 'qc' ? 'qc' : 'tech';
  return ok(res, await service.history(date, scope));
});

const confirmItem = asyncHandler(async (req, res) => {
  const ma = String(req.params.ma || '').toUpperCase();
  const perm = ITEM_PERM[ma];
  if (!perm) throw new AppError('Mục kỹ thuật không hợp lệ', { status: 400, errorCode: 'INVALID_ITEM' });
  const perms = (req.user && req.user.permissions) || [];
  if (!perms.includes('*') && !perms.includes(perm)) {
    throw new AppError(`Không có quyền xác nhận mục này (${perm})`, { status: 403, errorCode: 'FORBIDDEN', details: [perm] });
  }
  const data = await service.confirmItem(req.params.phanInId, ma, req.body.value, req.user.id);
  return ok(res, data, 'Đã xác nhận');
});

const confirmItemsBatch = asyncHandler(async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const perms = (req.user && req.user.permissions) || [];
  // Kiểm tra quyền chính xác cho từng mục trong batch.
  for (const it of items) {
    const ma = String(it.ma || '').toUpperCase();
    const perm = ITEM_PERM[ma];
    if (!perm) throw new AppError(`Mục không hợp lệ: ${it.ma}`, { status: 400, errorCode: 'INVALID_ITEM' });
    if (!perms.includes('*') && !perms.includes(perm)) {
      throw new AppError(`Không có quyền xác nhận mục ${ma} (${perm})`, { status: 403, errorCode: 'FORBIDDEN', details: [perm] });
    }
  }
  const data = await service.confirmItemsBatch(req.params.phanInId, items, req.user.id);
  return ok(res, data, 'Đã xác nhận các mục đã chọn');
});

const confirmBulk = asyncHandler(async (req, res) => {
  const ma = String(req.body.ma || '').toUpperCase();
  const perm = ITEM_PERM[ma];
  if (!perm) throw new AppError(`Mục không hợp lệ: ${req.body.ma}`, { status: 400, errorCode: 'INVALID_ITEM' });
  const perms = (req.user && req.user.permissions) || [];
  if (!perms.includes('*') && !perms.includes(perm)) {
    throw new AppError(`Không có quyền xác nhận mục ${ma} (${perm})`, { status: 403, errorCode: 'FORBIDDEN', details: [perm] });
  }
  const ids = Array.isArray(req.body.phanInIds) ? req.body.phanInIds : [];
  const data = await service.confirmItemBulk(ids, ma, req.body.value, req.user.id);
  return ok(res, data, `Đã xác nhận ${data.okCount} phần in`);
});

const confirmQC = asyncHandler(async (req, res) =>
  ok(res, await service.confirmQC(req.params.phanInId, req.user.id), 'Đã QC xác nhận — READY hoàn thành'));

const qcConfirmBatch = asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.phanInIds) ? req.body.phanInIds : [];
  const data = await service.confirmQcBatch(ids, req.user.id);
  return ok(res, data, `Đã QC xác nhận ${data.okCount} phần in`);
});

module.exports = {
  config, candidates, qcCandidates, detail, history,
  confirmItem, confirmItemsBatch, confirmBulk, confirmQC, qcConfirmBatch,
};
