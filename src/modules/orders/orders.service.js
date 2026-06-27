'use strict';

const repo = require('./orders.repository');
const AppError = require('../../utils/AppError');
const { buildMeta } = require('../../utils/pagination');

async function listPhanIn({ search, missingProfit, page, limit, offset }) {
  const { rows, total } = await repo.list({ search, missingProfit, offset, limit });
  return { items: rows, meta: buildMeta(page, limit, total) };
}

async function getPhanIn(id) {
  const phanIn = await repo.findById(id);
  if (!phanIn) throw new AppError('Phần in không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const dotVai = await repo.listDotVai(id);
  return { ...phanIn, dot_vai: dotVai };
}

async function setLoiNhuan(id, loiNhuan, actorId) {
  const ok = await repo.setLoiNhuan(id, loiNhuan, actorId);
  if (!ok) throw new AppError('Phần in không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  return getPhanIn(id);
}

module.exports = { listPhanIn, getPhanIn, setLoiNhuan };
