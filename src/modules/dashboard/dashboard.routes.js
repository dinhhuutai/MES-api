'use strict';

const express = require('express');
const repo = require('./dashboard.repository');
const reportService = require('../reports/reports.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const auth = require('../../middlewares/auth');

const router = express.Router();
router.use(auth);

router.get('/summary', asyncHandler(async (req, res) => ok(res, await repo.summary())));
router.get('/activity', asyncHandler(async (req, res) => ok(res, await repo.activity())));
router.get('/stage-counts', asyncHandler(async (req, res) => ok(res, await repo.stageCounts())));

// ---- Dòng chảy + SLA (theo dõi chủ động — migration 029) ----
// Tính nghẽn on-the-fly theo SLA trạm.
function slaStatus(phutDaO, slaPhut, canhBao) {
  const sla = Number(slaPhut) || 0;
  const cb = Number(canhBao) || 0;
  const p = Number(phutDaO) || 0;
  if (sla <= 0) return 'OK';
  if (p > sla) return 'NGHEN';
  if (p >= sla - cb) return 'SAP_NGHEN';
  return 'OK';
}

// Gộp danh sách owner theo khóa (ma_tram / ma_checkpoint) + phân loại.
function groupOwners(rows, key) {
  const m = {};
  rows.forEach((o) => {
    const g = (m[o[key]] = m[o[key]] || { chiu_trach_nhiem: [], xu_ly: [] });
    if (o.ten) (o.loai === 'CHIU_TRACH_NHIEM' ? g.chiu_trach_nhiem : g.xu_ly).push(o.ten);
  });
  return m;
}

// GET /dashboard/owners — owner theo trạm & checkpoint (workflow hiện hành) cho "ai cần xử lý".
router.get('/owners', asyncHandler(async (req, res) => {
  const [tramOwners, cpOwners] = await Promise.all([repo.tramOwnersActive(), repo.checkpointOwnersActive()]);
  return ok(res, { tram: groupOwners(tramOwners, 'ma_tram'), checkpoint: groupOwners(cpOwners, 'ma_checkpoint') });
}));

// ---- KIOSK: tình trạng đơn hàng theo trạm ----
// GET /dashboard/tinh-trang/summary — đếm phần in đang chạy chưa giao / sắp nghẽn / nghẽn.
router.get('/tinh-trang/summary', asyncHandler(async (req, res) => {
  const rows = await repo.tinhTrangActiveRows();
  const dangChay = new Set(); const sap = new Set(); const nghen = new Set();
  rows.forEach((r) => {
    const st = slaStatus(r.phut_da_o, r.sla_phut, r.canh_bao_truoc_phut);
    // "đang chạy chưa giao" = chưa ở trạm giao xong.
    if (r.ma_tram !== 'DONE_DELIVERY') dangChay.add(r.phan_in_id);
    if (st === 'SAP_NGHEN') sap.add(r.phan_in_id);
    if (st === 'NGHEN') nghen.add(r.phan_in_id);
  });
  return ok(res, { dang_chay_chua_giao: dangChay.size, sap_nghen: sap.size, nghen: nghen.size });
}));

// GET /dashboard/tinh-trang/phan-in?search= — danh sách phần in để xoay vòng.
router.get('/tinh-trang/phan-in', asyncHandler(async (req, res) => {
  const rows = await repo.tinhTrangPhanInList(req.query.search || '');
  return ok(res, { items: rows, total: rows.length });
}));

// GET /dashboard/tinh-trang/phan-in/:id — đồ thị dòng chảy phân nhánh của 1 phần in.
router.get('/tinh-trang/phan-in/:id', asyncHandler(async (req, res) => {
  const data = await repo.tinhTrangDetail(req.params.id);
  if (!data) return ok(res, null);
  data.dot_vai.forEach((d) => {
    if (d.current) {
      const phut = d.current.tg_vao ? Math.floor((Date.now() - new Date(d.current.tg_vao).getTime()) / 60000) : 0;
      d.current.sla_status = slaStatus(phut, d.current.sla_phut, d.current.canh_bao_truoc_phut);
    }
  });
  return ok(res, data);
}));

// GET /dashboard/flow?tram=&filter=  (filter: all|NGHEN|SAP_NGHEN)
router.get('/flow', asyncHandler(async (req, res) => {
  const tram = req.query.tram || '';
  const filter = req.query.filter || 'all';
  const [rows, owners] = await Promise.all([repo.flowRows(tram), repo.tramOwnersActive()]);
  const ownerByTram = groupOwners(owners, 'ma_tram');

  let items = rows.map((r) => ({
    ...r,
    sla_status: slaStatus(r.phut_da_o, r.sla_phut, r.canh_bao_truoc_phut),
    owner_trach_nhiem: (ownerByTram[r.ma_tram]?.chiu_trach_nhiem || []).join(', ') || null,
    owner_xu_ly: r.owner_ho_ten || (ownerByTram[r.ma_tram]?.xu_ly || []).join(', ') || null,
  }));
  if (filter === 'NGHEN' || filter === 'SAP_NGHEN') items = items.filter((i) => i.sla_status === filter);
  return ok(res, items);
}));

// GET /dashboard/flow/:dotVaiId  — timeline dòng chảy của 1 đợt vải.
router.get('/flow/:dotVaiId', asyncHandler(async (req, res) => {
  const data = await repo.flowTimeline(req.params.dotVaiId);
  if (data.current) data.current.sla_status = slaStatus(data.current.phut_da_o, data.current.sla_phut, data.current.canh_bao_truoc_phut);
  return ok(res, data);
}));

// GET /dashboard/sla-tong-quan — tổng quan nghẽn theo trạm cho BGĐ.
router.get('/sla-tong-quan', asyncHandler(async (req, res) => {
  const rows = await repo.flowRows('');
  const byTram = {};
  let dangChay = 0; let nghen = 0; let sapNghen = 0;
  rows.forEach((r) => {
    const st = slaStatus(r.phut_da_o, r.sla_phut, r.canh_bao_truoc_phut);
    dangChay += 1;
    if (st === 'NGHEN') nghen += 1;
    if (st === 'SAP_NGHEN') sapNghen += 1;
    const g = (byTram[r.ma_tram] = byTram[r.ma_tram] || {
      ma_tram: r.ma_tram, ten_tram: r.ten_tram, thu_tu: r.thu_tu, tong: 0, nghen: 0, sap_nghen: 0,
    });
    g.tong += 1;
    if (st === 'NGHEN') g.nghen += 1;
    if (st === 'SAP_NGHEN') g.sap_nghen += 1;
  });
  const trams = Object.values(byTram).sort((a, b) => (a.thu_tu ?? 99) - (b.thu_tu ?? 99));
  return ok(res, { tong: { dang_chay: dangChay, nghen, sap_nghen: sapNghen }, trams });
}));

// Báo cáo (gắn dưới /dashboard cho gọn; module BAO_CAO)
router.get('/reports', asyncHandler(async (req, res) => ok(res, reportService.listReports())));
router.get('/reports/:ma', asyncHandler(async (req, res) => ok(res, await reportService.getReport(req.params.ma))));

module.exports = router;
