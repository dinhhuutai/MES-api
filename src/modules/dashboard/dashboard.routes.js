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
router.get('/chart-detail', asyncHandler(async (req, res) => ok(res, await repo.chartDetail())));

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

// GET /dashboard/bang-2 — 3 thẻ (hoàn thành hôm nay / sắp nghẽn / nghẽn theo PHẦN IN) + nhóm drill-down.
const RANK = { OK: 0, SAP_NGHEN: 1, NGHEN: 2 };
router.get('/bang-2', asyncHandler(async (req, res) => {
  const [rows, tramOwners, todayGroups] = await Promise.all([
    repo.flowRows(''), repo.tramOwnersActive(), repo.confirmTodayGroups(),
  ]);
  const owners = groupOwners(tramOwners, 'ma_tram');

  const worst = {};                       // phan_in_id -> rank xấu nhất
  const groups = { NGHEN: {}, SAP_NGHEN: {} };
  rows.forEach((r) => {
    const st = slaStatus(r.phut_da_o, r.sla_phut, r.canh_bao_truoc_phut);
    const pr = RANK[st];
    if (!(r.phan_in_id in worst) || pr > worst[r.phan_in_id]) worst[r.phan_in_id] = pr;
    if (st === 'NGHEN' || st === 'SAP_NGHEN') {
      const g = (groups[st][r.ma_tram] = groups[st][r.ma_tram]
        || { ma_tram: r.ma_tram, ten_tram: r.ten_tram, sla_phut: r.sla_phut, phan_ins: {} });
      const p = g.phan_ins[r.phan_in_id];
      if (!p || (r.phut_da_o || 0) > (p.phut_da_o || 0)) {
        g.phan_ins[r.phan_in_id] = {
          phan_in_id: r.phan_in_id, ma_phan: r.ma_phan, ma_hang: r.ma_hang, ma_don_hang: r.ma_don_hang,
          ten_khach_hang: r.ten_khach_hang, mau_vai: r.mau_vai, kich_vai: r.kich_vai, kich_phim: r.kich_phim,
          phut_da_o: r.phut_da_o, sla_phut: r.sla_phut,
        };
      }
    }
  });
  const toArr = (obj) => Object.values(obj).map((g) => {
    const o = owners[g.ma_tram] || {};
    return {
      ma_tram: g.ma_tram, ten_tram: g.ten_tram, sla_phut: g.sla_phut,
      owner_trach_nhiem: (o.chiu_trach_nhiem || []).join(', ') || null,
      owner_xu_ly: (o.xu_ly || []).join(', ') || null,
      phan_ins: Object.values(g.phan_ins).sort((a, b) => (b.phut_da_o || 0) - (a.phut_da_o || 0)),
      count: Object.keys(g.phan_ins).length,
    };
  }).sort((a, b) => b.count - a.count);

  return ok(res, {
    hoan_thanh_hom_nay: todayGroups.reduce((s, g) => s + (g.n || 0), 0),
    nghen: Object.values(worst).filter((v) => v === 2).length,
    sap_nghen: Object.values(worst).filter((v) => v === 1).length,
    nhom_hoan_thanh: todayGroups,
    nhom_nghen: toArr(groups.NGHEN),
    nhom_sap: toArr(groups.SAP_NGHEN),
  });
}));

// GET /dashboard/hoan-thanh-hom-nay — chi tiết các lượt xác nhận hôm nay (đối tượng + người) cho drill-down.
router.get('/hoan-thanh-hom-nay', asyncHandler(async (req, res) => ok(res, await repo.confirmTodayDetail())));

// GET /dashboard/nghen-map — bản đồ nghẽn/sắp nghẽn theo đợt vải + phần in (dùng tô màu các trang xác nhận).
router.get('/nghen-map', asyncHandler(async (req, res) => {
  const rows = await repo.flowRows('');
  const dot = {}; const phan = {}; const lenh = {};
  const worse = (map, key, st) => { if (key && (!map[key] || RANK[st] > RANK[map[key]])) map[key] = st; };
  rows.forEach((r) => {
    const st = slaStatus(r.phut_da_o, r.sla_phut, r.canh_bao_truoc_phut);
    if (st === 'OK') return;
    dot[r.dot_vai_ve_id] = st;
    worse(phan, r.phan_in_id, st);
    worse(lenh, r.lenh_id, st);
  });
  return ok(res, { dot_vai: dot, phan_in: phan, lenh });
}));

// ---- KIOSK: tình trạng đơn hàng theo trạm ----
// GET /dashboard/tinh-trang/summary — đếm phần in đang chạy chưa giao / sắp nghẽn / nghẽn + danh sách nghẽn.
const SLA_RANK = { NGHEN: 2, SAP_NGHEN: 1, OK: 0 };
router.get('/tinh-trang/summary', asyncHandler(async (req, res) => {
  const rows = await repo.tinhTrangActiveRows();
  const dangChay = new Set();
  // Gộp theo phần in → giữ trạng thái SLA xấu nhất trong các đợt vải của nó.
  const byPhanIn = {};
  rows.forEach((r) => {
    const st = slaStatus(r.phut_da_o, r.sla_phut, r.canh_bao_truoc_phut);
    if (r.ma_tram !== 'DONE_DELIVERY') dangChay.add(r.phan_in_id);
    const cur = byPhanIn[r.phan_in_id];
    if (!cur || SLA_RANK[st] > SLA_RANK[cur.sla_status]) {
      byPhanIn[r.phan_in_id] = {
        id: r.phan_in_id, sla_status: st, ten_tram: r.ten_tram,
        ma_phan: r.ma_phan, ma_hang: r.ma_hang, ten_khach_hang: r.ten_khach_hang,
        ma_don_hang: r.ma_don_hang, mau_vai: r.mau_vai, kich_vai: r.kich_vai, kich_phim: r.kich_phim,
      };
    }
  });
  const items = Object.values(byPhanIn);
  const danhSachNghen = items.filter((i) => i.sla_status === 'NGHEN');
  const danhSachSap = items.filter((i) => i.sla_status === 'SAP_NGHEN');
  return ok(res, {
    dang_chay_chua_giao: dangChay.size,
    sap_nghen: danhSachSap.length,
    nghen: danhSachNghen.length,
    danh_sach: { NGHEN: danhSachNghen, SAP_NGHEN: danhSachSap },
  });
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
