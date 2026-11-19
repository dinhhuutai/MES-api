'use strict';

// ═════════════════════════════════════════════════════════════════════════════
// DỰNG KHO KIẾN THỨC CHO AGENT MES THLA (RAG — MCP `mes-docs`) — 19/11/2026
//   Chạy (thư mục backend):  node src/scripts/taoKienThucAi.js
//   Ra file: backend/ai-kien-thuc/kien-thuc.json — deploy CÙNG backend (máy chủ không có thư mục docs/ của repo).
//   Chạy lại mỗi khi tài liệu hướng dẫn / CLAUDE.md / DATABASE.md / menu đổi.
// Nguồn:
//   1. Hướng dẫn sử dụng từng module  docs/huong-dan-su-dung/_nguon/noi_dung/*.mjs   (nội dung bộ tài liệu Word/PDF)
//   2. Hướng dẫn tổng quan            docs/HUONG-DAN-SU-DUNG*.md, docs/HUONG-DAN-OWNER-SLA.md
//   3. Luật nghiệp vụ                  CLAUDE.md — chỉ các mục nghiệp vụ (bỏ Tech stack, DB/MCP, coding, triển khai…)
//   4. Cấu trúc dữ liệu                DATABASE.md
//   5. Menu + quyền                    frontend/src/constants/modules.js
// ⚠ LỌC trước khi ghi: địa chỉ IP, đường dẫn máy chủ, dòng có mật khẩu/khóa bí mật, tên user DB.
// ═════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const GOC = path.resolve(__dirname, '../../..');
const RA = path.resolve(__dirname, '../../ai-kien-thuc/kien-thuc.json');
const TOI_DA_DOAN = 1800;

// ─── Lọc thông tin hạ tầng ────────────────────────────────────────────────────
function locBiMat(s) {
  return String(s || '')
    .split('\n')
    .filter((d) => !/(PGPASSWORD|JWT_SECRET|API_KEY\s*=|SECRET\s*=|mật khẩu\s*[:=]\s*\S|password\s*[:=]\s*\S)/i.test(d))
    .join('\n')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '[địa chỉ máy chủ]')
    .replace(/\b[A-Za-z]:[\\/][^\s`'")\]]+/g, '[đường dẫn máy chủ]')
    .replace(/claude_agent_mes/g, 'user DB của MES')
    .replace(/mes_ai_doc/g, 'user DB chỉ đọc của AI');
}

// ─── Cắt markdown theo tiêu đề ────────────────────────────────────────────────
function catMarkdown(text, nguon, tenTep, boQua = () => false) {
  const ra = [];
  const tieuDe = [];
  let dong = [];
  let tdHienTai = tenTep;
  let biBo = false;
  const day = () => {
    const nd = dong.join('\n').trim();
    dong = [];
    if (!nd || biBo) return;
    chiaNho(nd).forEach((p, i) => ra.push({ nguon, tieu_de: i ? `${tdHienTai} (tiếp)` : tdHienTai, noi_dung: p }));
  };
  text.split(/\r?\n/).forEach((l) => {
    const m = /^(#{1,4})\s+(.*)$/.exec(l);
    if (m) {
      day();
      const cap = m[1].length;
      tieuDe.length = cap - 1;
      tieuDe[cap - 1] = m[2].replace(/[*`]/g, '').trim();
      tdHienTai = [tenTep, ...tieuDe.filter(Boolean)].join(' › ');
      biBo = tieuDe.filter(Boolean).some(boQua);
      return;
    }
    dong.push(l);
  });
  day();
  return ra;
}

function chiaNho(nd) {
  if (nd.length <= TOI_DA_DOAN) return [nd];
  const ra = [];
  let cur = '';
  nd.split(/\n(?=\s*\n)|\n(?=[*-] |\d+\. |\|)/).forEach((p) => {
    if ((cur + '\n' + p).length > TOI_DA_DOAN && cur) { ra.push(cur.trim()); cur = p; } else cur += '\n' + p;
  });
  if (cur.trim()) ra.push(cur.trim());
  // Đoạn đơn vẫn quá dài ⇒ cắt cứng.
  return ra.flatMap((p) => (p.length <= TOI_DA_DOAN * 1.5 ? [p] : p.match(new RegExp(`[\\s\\S]{1,${TOI_DA_DOAN}}`, 'g'))));
}

// ─── Hướng dẫn module (.mjs) → văn bản ────────────────────────────────────────
const BO_KHOA = new Set(['cb', 'dau', 'sel', 's', 't', 'cat', 'id', 'trong', 'nhom', 'n', 'i', 'pad', 'ex', 'len', 'rong', 'tep', 'ma', 'vung', 'cho', 'x', 'y', 'w', 'h', 'anh', 'file']);
function vanBan(v, khoa) {
  if (v == null || typeof v === 'function') return [];
  if (BO_KHOA.has(khoa)) return [];
  if (typeof v === 'string') return [v];
  if (typeof v === 'number' || typeof v === 'boolean') return [];
  if (Array.isArray(v)) {
    if (khoa === 'so') return v.filter((x) => typeof x === 'string').map((x, i) => `${i + 1}. ${x}`);
    return v.flatMap((x) => vanBan(x, khoa));
  }
  if (khoa === 'bang' && Array.isArray(v.dong)) {
    const cot = Array.isArray(v.cot) ? v.cot : [];
    const ra = v.td ? [`Bảng: ${v.td}`] : [];
    if (cot.length) ra.push(`| ${cot.join(' | ')} |`);
    v.dong.forEach((d) => { if (Array.isArray(d)) ra.push(`| ${d.map((x) => String(x)).join(' | ')} |`); });
    return ra;
  }
  return Object.entries(v).flatMap(([k, x]) => vanBan(x, k));
}

async function huongDanModule() {
  const thuMuc = path.join(GOC, 'docs/huong-dan-su-dung/_nguon/noi_dung');
  if (!fs.existsSync(thuMuc)) return [];
  const ra = [];
  for (const tep of fs.readdirSync(thuMuc).filter((f) => f.endsWith('.mjs')).sort()) {
    const mod = (await import(pathToFileURL(path.join(thuMuc, tep)).href)).default;
    if (!mod || !Array.isArray(mod.muc)) continue;
    const tenModule = `Hướng dẫn ${mod.ten || tep}`;
    if (Array.isArray(mod.bia) && mod.bia.length) {
      ra.push({ nguon: 'HUONG_DAN', tieu_de: tenModule, noi_dung: mod.bia.join('\n') });
    }
    mod.muc.forEach((m) => {
      const td = `${tenModule} › ${m.td || ''}`.trim();
      const nd = vanBan(m, '').filter((x) => x !== m.td).join('\n').trim();
      if (nd) chiaNho(nd).forEach((p, i) => ra.push({ nguon: 'HUONG_DAN', tieu_de: i ? `${td} (tiếp)` : td, noi_dung: p }));
    });
  }
  return ra;
}

// ─── Menu từ frontend/src/constants/modules.js ─────────────────────────────────
function menu() {
  const tep = path.join(GOC, 'frontend/src/constants/modules.js');
  if (!fs.existsSync(tep)) return [];
  const code = fs.readFileSync(tep, 'utf8').replace(/^export\s+/gm, '');
  // eslint-disable-next-line no-new-func
  const MODULES = new Function(`${code}\nreturn MODULES;`)();
  const ra = [];
  MODULES.forEach((m) => {
    (m.children || []).forEach((c) => {
      ra.push({
        module: m.ten,
        ten: c.ten,
        route: c.route,
        quyen: [].concat(c.perm || m.perm || []).filter(Boolean),
      });
    });
  });
  return ra;
}

async function main() {
  const doc = (p) => fs.readFileSync(path.join(GOC, p), 'utf8');
  const doan = [];

  doan.push(...(await huongDanModule()));
  ['docs/HUONG-DAN-SU-DUNG-THLA-MES.md', 'docs/HUONG-DAN-SU-DUNG.md', 'docs/HUONG-DAN-OWNER-SLA.md'].forEach((p) => {
    if (fs.existsSync(path.join(GOC, p))) {
      doan.push(...catMarkdown(doc(p), 'HUONG_DAN', path.basename(p, '.md'), (t) => /SLIDE|NotebookLM/i.test(t)));
    }
  });
  // CLAUDE.md: chỉ giữ mục nghiệp vụ.
  doan.push(...catMarkdown(doc('CLAUDE.md'), 'LUAT_NGHIEP_VU', 'Luật nghiệp vụ MES',
    (t) => /Tech Stack|Database & MCP|UI\/UX Design|Coding Rules|Triển khai|Việc đang treo|Quy trình làm việc của Claude/i.test(t)));
  doan.push(...catMarkdown(doc('DATABASE.md'), 'DU_LIEU', 'Cấu trúc dữ liệu MES',
    (t) => /^0\. Trạng thái|Kết nối|rò kết nối|Hiệu năng/i.test(t)));

  const sach = doan
    .map((d) => ({ ...d, tieu_de: locBiMat(d.tieu_de), noi_dung: locBiMat(d.noi_dung) }))
    .filter((d) => d.noi_dung.replace(/\s+/g, '').length >= 40)
    .map((d, i) => ({ id: i + 1, ...d }));

  const kho = { tao_luc: new Date().toISOString(), so_doan: sach.length, doan: sach, menu: menu() };
  fs.mkdirSync(path.dirname(RA), { recursive: true });
  fs.writeFileSync(RA, JSON.stringify(kho));
  const theoNguon = sach.reduce((a, d) => ({ ...a, [d.nguon]: (a[d.nguon] || 0) + 1 }), {});
  console.log(`Đã ghi ${RA}: ${sach.length} đoạn ${JSON.stringify(theoNguon)}, ${kho.menu.length} mục menu, ${Math.round(fs.statSync(RA).size / 1024)} KB`);
}

main().catch((e) => { console.error(e); process.exit(1); });
