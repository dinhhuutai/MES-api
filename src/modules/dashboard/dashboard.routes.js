'use strict';

const express = require('express');
const repo = require('./dashboard.repository');
const reportService = require('../reports/reports.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const auth = require('../../middlewares/auth');
const { slaStatus } = require('../../utils/sla');

const router = express.Router();
router.use(auth);

router.get('/summary', asyncHandler(async (req, res) => ok(res, await repo.summary())));
router.get('/activity', asyncHandler(async (req, res) => ok(res, await repo.activity())));
router.get('/stage-counts', asyncHandler(async (req, res) => ok(res, await repo.stageCounts())));
router.get('/chart-detail', asyncHandler(async (req, res) => ok(res, await repo.chartDetail())));

// ---- Dòng chảy + SLA (theo dõi chủ động — migration 029) ----
// Tính nghẽn on-the-fly theo SLA trạm — `slaStatus` nay ở utils/sla.js, dùng chung với
// metric báo cáo (nhóm "Dòng chảy theo checkpoint") để 2 nơi không ra số khác nhau.

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

// GET /dashboard/dieu-phoi — dữ liệu Bảng điều phối: TRỄ HẠN GIAO theo trạm (đang kẹt) + chờ duyệt/xử lý + chuyền.
router.get('/dieu-phoi', asyncHandler(async (req, res) => {
  const [rows, extra] = await Promise.all([repo.flowRows(''), repo.dieuPhoiExtra()]);
  // Ngày VN hôm nay (YYYY-MM-DD).
  const todayVN = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
  todayVN.setHours(0, 0, 0, 0);
  const dayMs = 86400000;
  const groups = {}; // ma_tram -> { ..., qua_han, sap_han, phan_ins:{} }
  let quaHanTong = 0; let sapHanTong = 0;
  const seenQua = new Set(); const seenSap = new Set();
  rows.forEach((r) => {
    if (!r.han_giao_hang || r.ma_tram === 'DONE_DELIVERY') return; // đã giao xong → bỏ
    const han = new Date(r.han_giao_hang); han.setHours(0, 0, 0, 0);
    const diff = Math.round((han - todayVN) / dayMs);
    let kind = null;
    if (diff < 0) kind = 'qua'; else if (diff <= 1) kind = 'sap'; // đã trễ / hôm nay + mai
    if (!kind) return;
    const g = (groups[r.ma_tram] = groups[r.ma_tram]
      || { ma_tram: r.ma_tram, ten_tram: r.ten_tram, thu_tu: r.thu_tu, phan_ins: {} });
    const cur = g.phan_ins[r.phan_in_id];
    if (!cur || (kind === 'qua' && cur.kind !== 'qua')) {
      g.phan_ins[r.phan_in_id] = {
        phan_in_id: r.phan_in_id, ma_phan: r.ma_phan, ma_hang: r.ma_hang, ma_don_hang: r.ma_don_hang,
        ten_khach_hang: r.ten_khach_hang, mau_vai: r.mau_vai, kich_vai: r.kich_vai, kich_phim: r.kich_phim,
        han_giao_hang: r.han_giao_hang, tre_ngay: diff < 0 ? -diff : 0, kind,
      };
    }
    // Tổng toàn cục đếm DISTINCT phần in (ưu tiên "qua" nếu 1 phần in vừa qua vừa sắp ở đợt khác).
    if (kind === 'qua') { if (!seenQua.has(r.phan_in_id)) { seenQua.add(r.phan_in_id); quaHanTong += 1; } }
    else if (!seenSap.has(r.phan_in_id) && !seenQua.has(r.phan_in_id)) { seenSap.add(r.phan_in_id); sapHanTong += 1; }
  });
  const by_tram = Object.values(groups).map((g) => {
    const list = Object.values(g.phan_ins);
    return {
      ma_tram: g.ma_tram, ten_tram: g.ten_tram, thu_tu: g.thu_tu,
      qua_han: list.filter((p) => p.kind === 'qua').length,
      sap_han: list.filter((p) => p.kind === 'sap').length,
      phan_ins: list.sort((a, b) => (b.tre_ngay || 0) - (a.tre_ngay || 0)),
    };
  }).sort((a, b) => (a.thu_tu ?? 99) - (b.thu_tu ?? 99));
  return ok(res, {
    tre_han: { qua_han: quaHanTong, sap_han: sapHanTong, by_tram },
    cho_duyet: { qc_tra_ve: extra.qc_tra_ve || 0, oqc_khong_dat: extra.oqc_khong_dat || 0 },
    chuyen: { dang_chay: extra.chuyen_dang_chay || 0, tong: extra.chuyen_tong || 0, ranh: Math.max(0, (extra.chuyen_tong || 0) - (extra.chuyen_dang_chay || 0)) },
  });
}));

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
  const rows = await repo.tinhTrangPhanInList(req.query.search || '', req.query.limit);
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

// GET /dashboard/tinh-trang/phan-in/:id/graph — sơ đồ rẽ nhánh (đợt vải → gộp đợt SX → tem → KCS/Sửa/OQC/Giao).
router.get('/tinh-trang/phan-in/:id/graph', asyncHandler(async (req, res) => ok(res, await repo.tinhTrangGraph(req.params.id))));

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

// GET /dashboard/lich-su-nghen?from=&to=&tram=&level=  (level: all|TRAM|CHECKLIST)
// Lịch sử nghẽn suy từ dwell mỗi trạm (lich_su_luan_chuyen) + dwell mỗi checklist (ket_qua_checkpoint).
// "Nghẽn" = thời gian dừng > SLA; "thời gian vượt SLA" (overrun) = max(0, dwell - SLA).
function vnDateStr(d) {
  const x = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
router.get('/lich-su-nghen', asyncHandler(async (req, res) => {
  // Mặc định: 7 ngày gần nhất (VN).
  const to = req.query.to || vnDateStr(new Date());
  const from = req.query.from || vnDateStr(new Date(Date.now() - 6 * 86400000));
  const tram = req.query.tram || '';
  const level = req.query.level || 'all';

  const [tramEps, cpEpsRaw, tramOwners, cpOwners] = await Promise.all([
    (level === 'CHECKLIST') ? [] : repo.nghenTramEpisodes({ from, to, tram }),
    (level === 'TRAM') ? [] : repo.nghenChecklistEpisodes({ from, to }),
    repo.tramOwnersActive(), repo.checkpointOwnersActive(),
  ]);
  // Lọc checklist theo trạm (repo checklist không lọc trong SQL) để 'tram' áp nhất quán cả 2 cấp.
  const cpEps = tram ? cpEpsRaw.filter((r) => r.ma_tram === tram) : cpEpsRaw;
  const ownerByTram = groupOwners(tramOwners, 'ma_tram');
  const ownerByCp = groupOwners(cpOwners, 'ma_checkpoint');

  // Chuẩn hóa 1 lượt nghẽn thành episode + tính overrun + trạng thái.
  const mkEp = (r, epLevel, maKey, owners) => {
    const sla = Number(r.sla_phut) || 0;
    const dwell = Number(r.dwell_phut) || 0;
    const vuot = Math.max(0, dwell - sla);
    const o = owners[r[maKey]] || {};
    return {
      level: epLevel,
      ma: r[maKey], ten: epLevel === 'TRAM' ? r.ten_tram : r.ten_checkpoint,
      ma_tram: r.ma_tram, ten_tram: r.ten_tram, thu_tu: r.thu_tu,
      phan_in_id: r.phan_in_id, ma_phan: r.ma_phan, ma_hang: r.ma_hang, ma_don_hang: r.ma_don_hang,
      ten_khach_hang: r.ten_khach_hang, mau_vai: r.mau_vai, kich_vai: r.kich_vai, kich_phim: r.kich_phim,
      tg_vao: r.tg_vao, tg_ra: r.tg_ra, dwell_phut: dwell, sla_phut: sla, vuot_phut: vuot,
      sla_status: dwell > sla ? 'NGHEN' : 'OK',
      owner_trach_nhiem: (o.chiu_trach_nhiem || []).join(', ') || null,
      owner_xu_ly: (o.xu_ly || []).join(', ') || null,
    };
  };
  const eps = [
    ...tramEps.map((r) => mkEp(r, 'TRAM', 'ma_tram', ownerByTram)),
    ...cpEps.map((r) => mkEp(r, 'CHECKLIST', 'ma_checkpoint', ownerByCp)),
  ];

  // Gộp theo khóa (trạm / checklist) → thống kê.
  const aggBy = (list) => {
    const m = {};
    list.forEach((e) => {
      const g = (m[e.ma] = m[e.ma] || {
        ma: e.ma, ten: e.ten, ma_tram: e.ma_tram, ten_tram: e.ten_tram, thu_tu: e.thu_tu, sla_phut: e.sla_phut,
        so_vu: 0, so_vu_nghen: 0, tong_dwell_phut: 0, tong_vuot_phut: 0, max_vuot_phut: 0,
        owner_trach_nhiem: e.owner_trach_nhiem, owner_xu_ly: e.owner_xu_ly,
      });
      g.so_vu += 1;
      g.tong_dwell_phut += e.dwell_phut;
      g.tong_vuot_phut += e.vuot_phut;
      if (e.vuot_phut > 0) g.so_vu_nghen += 1;
      if (e.vuot_phut > g.max_vuot_phut) g.max_vuot_phut = e.vuot_phut;
    });
    return Object.values(m).map((g) => ({
      ...g,
      avg_dwell_phut: g.so_vu ? Math.round(g.tong_dwell_phut / g.so_vu) : 0,
      ty_le_nghen: g.so_vu ? Math.round((g.so_vu_nghen / g.so_vu) * 100) : 0,
    })).sort((a, b) => (b.tong_vuot_phut - a.tong_vuot_phut));
  };
  const by_tram = aggBy(eps.filter((e) => e.level === 'TRAM'));
  const by_checklist = aggBy(eps.filter((e) => e.level === 'CHECKLIST'));

  // Xu hướng theo ngày VN + phân bố theo giờ VN (dựa trên tg_ra = thời điểm rời trạm/bước).
  const vnParts = (ts) => {
    const d = new Date(new Date(ts).toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
    return { ngay: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, gio: d.getHours() };
  };
  const dayMap = {}; const gioMap = {};
  eps.forEach((e) => {
    if (!e.tg_ra) return;
    const { ngay, gio } = vnParts(e.tg_ra);
    const d = (dayMap[ngay] = dayMap[ngay] || { ngay, tong_vuot_phut: 0, so_vu_nghen: 0 });
    d.tong_vuot_phut += e.vuot_phut; if (e.vuot_phut > 0) d.so_vu_nghen += 1;
    const h = (gioMap[gio] = gioMap[gio] || { gio, tong_vuot_phut: 0, so_vu_nghen: 0 });
    h.tong_vuot_phut += e.vuot_phut; if (e.vuot_phut > 0) h.so_vu_nghen += 1;
  });
  const by_day = Object.values(dayMap).sort((a, b) => a.ngay.localeCompare(b.ngay));
  const by_gio = [];
  for (let g = 0; g < 24; g += 1) by_gio.push(gioMap[g] || { gio: g, tong_vuot_phut: 0, so_vu_nghen: 0 });

  // KPI tổng.
  const soVuTong = eps.length;
  const soVuNghen = eps.filter((e) => e.vuot_phut > 0).length;
  const tongVuot = eps.reduce((s, e) => s + e.vuot_phut, 0);
  const viDaiNhat = eps.reduce((mx, e) => (e.vuot_phut > (mx?.vuot_phut || 0) ? e : mx), null);
  const rank = [...by_tram, ...by_checklist].sort((a, b) => b.tong_vuot_phut - a.tong_vuot_phut)[0] || null;

  return ok(res, {
    from, to, level,
    kpi: {
      tong_vuot_phut: tongVuot,
      so_vu_nghen: soVuNghen,
      so_vu_tong: soVuTong,
      ty_le_tuan_thu: soVuTong ? Math.round(((soVuTong - soVuNghen) / soVuTong) * 100) : 100,
      vu_dai_nhat: viDaiNhat ? { phut: viDaiNhat.vuot_phut, ten: viDaiNhat.ten, ma_phan: viDaiNhat.ma_phan } : null,
      nghen_nhat: rank ? { ten: rank.ten, ten_tram: rank.ten_tram, tong_vuot_phut: rank.tong_vuot_phut } : null,
    },
    by_tram, by_checklist, by_day, by_gio,
    episodes: eps.sort((a, b) => b.vuot_phut - a.vuot_phut).slice(0, 300),
  });
}));

// Báo cáo (gắn dưới /dashboard cho gọn; module BAO_CAO)
router.get('/reports', asyncHandler(async (req, res) => ok(res, reportService.listReports())));
router.get('/reports/:ma', asyncHandler(async (req, res) => ok(res, await reportService.getReport(req.params.ma))));

module.exports = router;
