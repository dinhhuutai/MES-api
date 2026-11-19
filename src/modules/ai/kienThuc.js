'use strict';

// ═════════════════════════════════════════════════════════════════════════════
// KHO KIẾN THỨC (RAG) của Agent MES THLA — đọc `backend/ai-kien-thuc/kien-thuc.json`
// (dựng bằng `node src/scripts/taoKienThucAi.js`). Tìm theo từ khóa KHÔNG DẤU, xếp hạng BM25 trên âm tiết
// + cặp âm tiết liền nhau (để "sản xuất", "test run" khớp như một từ). Không cần dịch vụ ngoài.
// ═════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const TEP = path.resolve(__dirname, '../../../ai-kien-thuc/kien-thuc.json');
const DUNG = new Set(('va la cua cac cho co khong duoc trong mot nhung thi nay voi de khi theo tu den da se o ra vao len '
  + 'nao gi ai hay hoac neu ma nen vi do boi tai ve cung chi moi nhu bi lai rat them sau truoc tren duoi nhieu it '
  + 'toi ban minh anh chi em ho no cai con dang can phai thay xem lam the nhe a oi vay roi luc').split(' '));

function boDau(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}
function tach(s) {
  const am = boDau(s).split(/[^a-z0-9]+/).filter((x) => x.length >= 2 || /^\d$/.test(x));
  const ra = [];
  am.forEach((x, i) => {
    if (!DUNG.has(x)) ra.push(x);
    if (i + 1 < am.length) ra.push(`${x}_${am[i + 1]}`);
  });
  return ra;
}

let kho = null;
function napKho() {
  if (kho) return kho;
  try {
    const raw = JSON.parse(fs.readFileSync(TEP, 'utf8'));
    const doan = Array.isArray(raw.doan) ? raw.doan : [];
    const tf = [];
    const df = new Map();
    let tong = 0;
    doan.forEach((d) => {
      const tok = [...tach(d.tieu_de), ...tach(d.tieu_de), ...tach(d.noi_dung)]; // tiêu đề nặng gấp đôi
      const m = new Map();
      tok.forEach((t) => m.set(t, (m.get(t) || 0) + 1));
      tf.push({ m, len: tok.length });
      tong += tok.length;
      m.forEach((_, t) => df.set(t, (df.get(t) || 0) + 1));
    });
    kho = { doan, menu: Array.isArray(raw.menu) ? raw.menu : [], tf, df, N: doan.length, tb: tong / Math.max(1, doan.length), taoLuc: raw.tao_luc, loi: null };
  } catch (e) {
    kho = { doan: [], menu: [], tf: [], df: new Map(), N: 0, tb: 1, taoLuc: null, loi: `Chưa có kho kiến thức (${e.code || e.message}). Chạy node src/scripts/taoKienThucAi.js` };
  }
  return kho;
}

/** Tìm `k` đoạn liên quan nhất. `nguon`: HUONG_DAN | LUAT_NGHIEP_VU | DU_LIEU (tùy chọn). */
function tim(tuKhoa, { k = 5, nguon = null } = {}) {
  const K = napKho();
  if (!K.N) return { loi: K.loi, ket_qua: [] };
  const q = [...new Set(tach(tuKhoa))];
  if (!q.length) return { ket_qua: [] };
  const k1 = 1.2;
  const b = 0.75;
  const diem = [];
  K.doan.forEach((d, i) => {
    if (nguon && d.nguon !== nguon) return;
    const { m, len } = K.tf[i];
    let s = 0;
    q.forEach((t) => {
      const f = m.get(t);
      if (!f) return;
      const n = K.df.get(t) || 0;
      const idf = Math.log(1 + (K.N - n + 0.5) / (n + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / K.tb)));
    });
    if (s > 0) diem.push([s, i]);
  });
  diem.sort((a, c) => c[0] - a[0]);
  return {
    ket_qua: diem.slice(0, Math.max(1, Math.min(10, k))).map(([s, i]) => ({
      tieu_de: K.doan[i].tieu_de, nguon: K.doan[i].nguon, noi_dung: K.doan[i].noi_dung, diem: Math.round(s * 100) / 100,
    })),
  };
}

function dsMenu() { return napKho().menu; }
function thongTinKho() { const K = napKho(); return { so_doan: K.N, tao_luc: K.taoLuc, loi: K.loi }; }

module.exports = { tim, dsMenu, thongTinKho, boDau };
