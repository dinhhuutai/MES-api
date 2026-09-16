'use strict';

// THỜI GIAN TỪNG TRẠM — xem ghi chú nguồn mốc ở `thoigiantram.repository.js`.
// ⚠ Backend CHỈ trả danh sách ĐƠN VỊ (mỗi trạm) + SLA; mọi phép tổng hợp (theo trạm / phần in /
//   đợt vải) làm ở FE (`features/dashboard/utils/thoiGianTram.js`) ⇒ 4 góc nhìn cùng MỘT tập dòng,
//   đổi tab không gọi lại API và không bao giờ ra 2 con số đá nhau.

const repo = require('./thoigiantram.repository');

const LOC_KEYS = ['timKiem', 'khach', 'don', 'maHang', 'codePhan', 'mauVai', 'chuyen',
  'loaiMoc', 'tuNgay', 'denNgay', 'trangThai'];
const NGAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function layLoc(q = {}) {
  const loc = {};
  LOC_KEYS.forEach((k) => { if (q[k]) loc[k] = String(q[k]).trim(); });
  // Ngày sai định dạng ⇒ bỏ (không để Postgres ném 22007 làm hỏng cả trang).
  ['tuNgay', 'denNgay'].forEach((k) => { if (loc[k] && !NGAY_RE.test(loc[k])) delete loc[k]; });
  if (!['VAO', 'RA'].includes(loc.loaiMoc)) loc.loaiMoc = 'VAO';
  if (!['DA_ROI', 'DANG_O'].includes(loc.trangThai)) delete loc.trangThai;
  return loc;
}

function slaCua(tram, slaRows) {
  if (!tram.sla) return null;
  const cap = tram.sla.checkpoint ? 'CHECKPOINT' : 'TRAM';
  const ma = tram.sla.checkpoint || tram.sla.tram;
  const r = slaRows.find((x) => x.cap === cap && x.ma === ma);
  return r && r.sla != null ? Number(r.sla) : null;
}

async function duLieu(q = {}) {
  const loc = layLoc(q);
  const chon = String(q.tram || '').split(',').map((s) => s.trim()).filter(Boolean);
  const dsTram = chon.length ? repo.TRAM_TG.filter((t) => chon.includes(t.ma)) : repo.TRAM_TG;

  const slaRows = await repo.dsSla();
  // ⚠ Các trạm ĐỘC LẬP ⇒ chạy SONG SONG (mạng tới DB ~25ms/lượt là nút cổ chai — CLAUDE.md §11.5).
  const kq = await Promise.all(dsTram.map((t) => repo.donViTaiTram(t, loc)));

  let cat = false;
  const rows = [];
  const tram = repo.TRAM_TG.map((t) => ({
    ma: t.ma, ten: t.ten, don_vi: t.donVi, mo_ta: t.moTa, sla_phut: slaCua(t, slaRows), cat: false,
    dang_xet: dsTram.includes(t),
  }));
  dsTram.forEach((t, i) => {
    let ds = kq[i];
    if (ds.length > repo.TRAN_DONG) {
      ds = ds.slice(0, repo.TRAN_DONG);
      cat = true;
      tram.find((x) => x.ma === t.ma).cat = true;
    }
    ds.forEach((r) => rows.push({ ...r, ma_tram: t.ma }));
  });
  return { loc, tram, rows, cat, tran_dong: repo.TRAN_DONG, bay_gio: new Date().toISOString() };
}

module.exports = { duLieu, _layLoc: layLoc };
