'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// ĐIỀN `DDHSUBID` CHO NHỮNG PHẦN IN CÒN THIẾU — lấy từ API ERP (mig 088)
//
// CÁCH CHẠY (từ thư mục `backend/`):
//     npm run lay:subid                     ← xem thử: liệt kê phần in còn thiếu, KHÔNG ghi gì
//     npm run lay:subid -- --ghi            ← ghi thật (tự dò ngày cần lấy)
//     npm run lay:subid -- 2026-07-01 --ghi ← ép lấy từ ngày chỉ định
//     npm run lay:subid -- --tatca --ghi    ← đối chiếu LẠI toàn bộ, ghi đè cả ô đã có
//
// ⚠⚠ MẶC ĐỊNH LÀ XEM THỬ. Phải có `--ghi` mới ghi xuống DB.
// ⚠⚠ MẶC ĐỊNH CHỈ ĐIỀN CHỖ TRỐNG — phần in đã có subID (do sync, do mig 088, hoặc sửa tay ở trang
//    Quản trị phần in) được giữ nguyên. Muốn ghi đè phải nói rõ bằng `--tatca`.
//
// TỰ DÒ NGÀY: không truyền ngày thì script tìm các phần in còn thiếu subID, lấy ngày SỚM NHẤT trong
// nhóm đó (theo đợt vải, lùi về ngày tạo phần in nếu chưa có đợt) rồi trừ thêm biên an toàn.
// ⚠ API ERP nhận `?fromDate=` và trả về **từ ngày đó ĐẾN HIỆN TẠI** ⇒ lùi càng xa, proc bên ERP
//   càng nặng và phản hồi càng lâu. Vì vậy script KHÔNG gọi API khi không có gì để điền.
//
// KHỚP PHẦN IN THEO 2 ĐƯỜNG, ưu tiên giảm dần:
//   1. `BarcodePTHDH` = `phan_in.barcode`  ← đích danh, tin nhất (mã vạch ↔ subID là 1:1)
//   2. `code_part`    = `phan_in.ma_phan`  ← cho phần in chưa có mã vạch
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const axios = require('axios');
const { query } = require('../config/db');
const env = require('../config/env');
const { tachDsMa, sqlKhopMa } = require('../utils/maPhanIn');

const args = process.argv.slice(2);
const ngayEp = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || null;
const GHI = args.includes('--ghi');
const TAT_CA = args.includes('--tatca');
const BIEN_AN_TOAN_NGAY = 3;   // lùi thêm vài ngày phòng lệch múi giờ / đợt về sát ngày

function erpProxy() {
  if (!env.erp.proxyUrl) return undefined;
  try {
    const u = new URL(env.erp.proxyUrl);
    return { host: u.hostname, port: Number(u.port) || 80, protocol: u.protocol.replace(':', '') };
  } catch { return undefined; }
}

// Đọc trường không phân biệt hoa/thường + gạch dưới — cùng luật `field()` của `erpsync.service`
// (ERP đặt tên không nhất quán: `DDHSUBID` / `ddh_sub_id` / `ddhsubid`).
function truong(row, ...ten) {
  const khoa = Object.keys(row || {});
  for (const t of ten) {
    const k = khoa.find((x) => x.toLowerCase().replace(/_/g, '') === String(t).toLowerCase().replace(/_/g, ''));
    if (k && row[k] != null && String(row[k]).trim() !== '') return String(row[k]).trim();
  }
  return null;
}

const lui = (d, n) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() - n);
  return x.toISOString().slice(0, 10);
};

(async () => {
  const db = (await query('SELECT current_database() AS d')).rows[0].d;
  console.log(`DB      : ${db}`);
  console.log(`Chế độ  : ${GHI ? 'GHI THẬT' : 'XEM THỬ (thêm --ghi để ghi)'}`
    + `${TAT_CA ? ' · ĐỐI CHIẾU LẠI TOÀN BỘ (ghi đè ô đã có)' : ' · chỉ điền chỗ trống'}`);

  // Chưa chạy mig 088 thì báo rõ, đừng để lỗi 42703 khó hiểu.
  const { rows: cot } = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_name='phan_in' AND column_name='ddh_sub_id' LIMIT 1`);
  if (!cot.length) {
    console.error('\n✗ Bảng `phan_in` chưa có cột `ddh_sub_id`.'
      + '\n  Chạy `database/migrations/088_ddh_sub_id_ve_phan_in.sql` (bằng user postgres) trước đã.');
    process.exit(1);
  }

  // ─── Phần in còn thiếu ────────────────────────────────────────────────────
  const { rows: thieu } = await query(
    `SELECT p.id, p.ma_phan, p.barcode,
            COALESCE(dv.som_nhat, p.created_date) AS moc
       FROM phan_in p
       LEFT JOIN LATERAL (SELECT min(COALESCE(d.ngay_vai_ve, d.created_date)) AS som_nhat
                            FROM dot_vai_ve d WHERE d.phan_in_id = p.id) dv ON true
      WHERE p.dang_hoat_dong AND p.ddh_sub_id IS NULL
      ORDER BY moc`.replace(/\s+/g, ' ')
  );
  const { rows: tong } = await query(
    'SELECT count(*)::int AS c FROM phan_in WHERE dang_hoat_dong');

  console.log(`\nPhần in đang hoạt động : ${tong[0].c}`);
  console.log(`Còn THIẾU subID        : ${thieu.length}`);

  if (!thieu.length && !TAT_CA) {
    console.log('\n✓ Không có phần in nào thiếu subID — không gọi API (API ERP rất nặng).');
    console.log('  Muốn đối chiếu lại toàn bộ với ERP thì chạy kèm `--tatca`.');
    process.exit(0);
  }

  if (thieu.length) {
    console.log('\n  Danh sách (tối đa 20 dòng đầu):');
    thieu.slice(0, 20).forEach((r) => console.log(
      `   ${r.ma_phan.padEnd(30)} mã vạch ${(r.barcode || '—').padEnd(13)} mốc ${String(r.moc).slice(0, 10)}`));
    if (thieu.length > 20) console.log(`   … và ${thieu.length - 20} phần in nữa`);
  }

  // ─── Ngày bắt đầu ─────────────────────────────────────────────────────────
  let fromDate = ngayEp;
  if (!fromDate) {
    const mocSom = thieu.length ? String(thieu[0].moc).slice(0, 10) : null;
    if (!mocSom) {
      console.error('\n✗ Không tự dò được ngày (không có phần in thiếu). Truyền ngày tường minh:'
        + '\n  npm run lay:subid -- 2026-07-01 --ghi');
      process.exit(1);
    }
    fromDate = lui(mocSom, BIEN_AN_TOAN_NGAY);
    console.log(`\nTự dò ngày: phần in thiếu sớm nhất ${mocSom} → lùi ${BIEN_AN_TOAN_NGAY} ngày = ${fromDate}`);
  }

  const url = `${env.erp.phieuNhanVaiUrl}?fromDate=${encodeURIComponent(fromDate)}`;
  console.log(`Gọi ERP : GET ${url}`);
  const t0 = Date.now();
  const res = await axios.get(url, {
    timeout: env.erp.syncTimeoutMs || 600000,
    headers: { Accept: 'application/json', ...(env.erp.apiHeaders || {}) },
    proxy: erpProxy(),
    validateStatus: () => true,
  });
  if (res.status < 200 || res.status >= 300) {
    console.error(`✗ ERP trả về HTTP ${res.status}: ${String(JSON.stringify(res.data || {})).slice(0, 300)}`);
    process.exit(1);
  }
  const body = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  const rows = Array.isArray(body) ? body : (body.data || body.items || body.result || []);
  console.log(`Nhận về : ${rows.length} dòng (${Math.round((Date.now() - t0) / 1000)}s)`);

  // Gom theo mã vạch phần in và theo code_part — giữ dòng MỚI NHẤT khi trùng khóa.
  const theoBarcode = new Map();
  const theoCodePart = new Map();
  let khongCoSub = 0;
  for (const r of rows) {
    const sub = truong(r, 'DDHSUBID', 'ddh_sub_id');
    if (!sub || !/^\d+$/.test(sub)) { khongCoSub += 1; continue; }
    const bc = truong(r, 'BarcodePTHDH', 'barcode_pthdh');
    const cp = truong(r, 'code_part', 'codepart');
    // ⚠ `BarcodePTHDH` CÓ THỂ LÀ DANH SÁCH (ngăn bằng dấu phẩy) — tách ra để mỗi mã tra riêng.
    //   Mọi mã trong danh sách đều có 3 số cuối = subID (đo prod 20/08: 1648/1648 mã khớp).
    for (const ma of tachDsMa(bc)) theoBarcode.set(ma, sub);
    if (cp) theoCodePart.set(cp, sub);
  }
  console.log(`Có subID: ${theoBarcode.size} mã vạch · ${theoCodePart.size} code phần`
    + `${khongCoSub ? ` · ${khongCoSub} dòng không có subID` : ''}`);

  // ⚠ Kiểm bất biến "3 số cuối mã vạch = subID" NGAY trên dữ liệu vừa lấy. Lệch nghĩa là ERP đổi quy
  //   ước đánh mã ⇒ DỪNG, đừng ghi bừa (bất biến này là nền của cả mig 088).
  const lech = [...theoBarcode].filter(([bc, sub]) => bc.slice(-3) !== String(sub).padStart(3, '0'));
  if (lech.length) {
    console.error(`\n✗ ${lech.length} mã vạch có 3 số cuối KHÁC subID — vd ${lech[0][0]} ↔ ${lech[0][1]}.`);
    console.error('  Bất biến của mig 088 không còn đúng. DỪNG để bạn kiểm tra với bên ERP trước.');
    process.exit(1);
  }
  console.log('Kiểm bất biến 3 số cuối mã vạch = subID: KHỚP HẾT');

  // ─── Ghi ──────────────────────────────────────────────────────────────────
  const dkTrong = TAT_CA ? '' : ' AND p.ddh_sub_id IS NULL';
  const chay = async (cot2, m) => {
    if (!m.size) return { khop: 0, doi: 0 };
    const keys = [...m.keys()];
    const vals = keys.map((k) => m.get(k));
    // ⚠ `phan_in.barcode` CÓ THỂ LÀ DANH SÁCH ⇒ so TỪNG mã, không so nguyên chuỗi (so nguyên chuỗi
    //   thì 32 phần in đang lưu danh sách sẽ trượt hết ở lớp 1 rồi rơi xuống lớp kém tin hơn).
    const dk = cot2 === 'barcode' ? sqlKhopMa('p.barcode', 'x.khoa') : `x.khoa = p.${cot2}`;
    const { rows: r1 } = await query(
      `SELECT count(*)::int AS khop,
              count(*) FILTER (WHERE p.ddh_sub_id IS DISTINCT FROM x.sub)::int AS doi
         FROM phan_in p
         JOIN unnest($1::text[], $2::text[]) AS x(khoa, sub) ON ${dk}
        WHERE p.dang_hoat_dong${dkTrong}`.replace(/\s+/g, ' '),
      [keys, vals]
    );
    if (GHI && r1[0].doi > 0) {
      await query(
        `UPDATE phan_in p SET ddh_sub_id = x.sub, updated_date = CURRENT_TIMESTAMP
           FROM unnest($1::text[], $2::text[]) AS x(khoa, sub)
          WHERE ${dk} AND p.dang_hoat_dong
            AND p.ddh_sub_id IS DISTINCT FROM x.sub${dkTrong}`.replace(/\s+/g, ' '),
        [keys, vals]
      );
    }
    return r1[0];
  };

  const a = await chay('barcode', theoBarcode);
  console.log(`\nTheo mã vạch phần in : khớp ${a.khop} · ${GHI ? 'đã ghi' : 'sẽ ghi'} ${a.doi}`);
  const b = await chay('ma_phan', theoCodePart);
  console.log(`Theo code phần       : khớp ${b.khop} · ${GHI ? 'đã ghi' : 'sẽ ghi'} ${b.doi}`);

  const { rows: con } = await query(
    'SELECT count(*)::int AS c FROM phan_in WHERE dang_hoat_dong AND ddh_sub_id IS NULL');
  console.log(`\nCòn thiếu subID: ${con[0].c} phần in`);
  if (con[0].c && GHI) {
    console.log('  → ERP không trả về những phần in này trong khoảng ngày đã lấy.');
    console.log(`  → Thử lùi xa hơn: npm run lay:subid -- ${lui(fromDate, 30)} --ghi`);
  }
  if (!GHI) console.log('\n(Chưa ghi gì — chạy lại kèm `--ghi` để ghi thật.)');
  process.exit(0);
})().catch((e) => {
  console.error('✗ LỖI:', e.message);
  process.exit(1);
});
