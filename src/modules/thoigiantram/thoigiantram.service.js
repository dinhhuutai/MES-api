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
    // Số checklist sổ xuống được — FE chỉ vẽ mũi tên ở dòng có số > 0.
    so_checklist: (t.checklist || []).length,
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

// ─── CHECKLIST CỦA MỘT TRẠM (bấm mũi tên ở dòng trạm để sổ xuống) ────────────
// ⚠⚠ TẢI LƯỜI (chỉ khi người dùng bung dòng), KHÔNG nhét vào `duLieu()`: mỗi checklist là một lượt
//   query nặng ngang dòng trạm cha — READY_KT có 3 checklist là gấp 4 lần dữ liệu cho một trạm mà
//   đa số lần xem không ai mở tới.
// ⚠ Trả RA DÒNG (không phải số đã tổng hợp) để FE chạy CHÍNH `tongHopTheoTram` của dòng cha ⇒ cha và
//   con không thể dùng 2 công thức khác nhau (TB / trung vị / P90 / quá SLA).
async function duLieuChecklist(maTram, q = {}) {
  const t = repo.TRAM_TG.find((x) => x.ma === maTram);
  if (!t || !(t.checklist || []).length) return { tram: maTram, checklist: [], rows: [] };

  const loc = layLoc(q);
  const [dm, kq] = await Promise.all([
    repo.dsChecklist(),
    // ⚠ Các checklist ĐỘC LẬP ⇒ song song (cùng lý do với 13 trạm ở `duLieu`).
    Promise.all(t.checklist.map((ma) => repo.donViTaiTram(t, loc, ma))),
  ]);

  const rows = [];
  const checklist = t.checklist.map((ma, i) => {
    const info = dm.find((x) => x.ma === ma) || {};
    let ds = kq[i];
    let cat = false;
    if (ds.length > repo.TRAN_DONG) { ds = ds.slice(0, repo.TRAN_DONG); cat = true; }
    ds.forEach((r) => rows.push({ ...r, ma_tram: maTram, ma_checkpoint: ma }));
    return {
      ma,
      ten: info.ten || ma,
      // ⚠ SLA của CHECKLIST (không phải của trạm): Khuôn 120p · Mực 90p · QC 60p… — lấy SLA trạm thì
      //   mục nào cũng "trong hạn" và cột "Quá SLA" của dòng con thành vô nghĩa.
      sla_phut: info.sla != null ? Number(info.sla) : null,
      so_don_vi: ds.length,
      so_xac_nhan: ds.filter((r) => r.da_xac_nhan).length,
      cat,
    };
  });
  return { tram: maTram, don_vi: t.donVi, checklist, rows, tran_dong: repo.TRAN_DONG };
}

module.exports = { duLieu, duLieuChecklist, _layLoc: layLoc };
