'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// ĐIỀN `DDHID` CHO NHỮNG ĐƠN HÀNG CÒN THIẾU — lấy từ API ERP (mig 074)
//
// CÁCH CHẠY (từ thư mục `backend/`):
//     npm run lay:ddhid                     ← xem thử: liệt kê đơn còn thiếu, KHÔNG ghi gì
//     npm run lay:ddhid -- --ghi            ← ghi thật (tự dò ngày cần lấy)
//     npm run lay:ddhid -- 2026-06-01 --ghi ← ép lấy từ ngày chỉ định
//     npm run lay:ddhid -- --tatca --ghi    ← đối chiếu LẠI toàn bộ, ghi đè cả ô đã có
//
// ⚠⚠ MẶC ĐỊNH LÀ XEM THỬ. Phải có `--ghi` mới ghi xuống DB.
// ⚠⚠ MẶC ĐỊNH CHỈ ĐIỀN CHỖ TRỐNG — đơn đã có `ddh_id` (do sync, do backfill, hoặc sửa tay) được giữ
//    nguyên. Muốn ghi đè phải nói rõ bằng `--tatca`.
//
// VÌ SAO CẦN: `don_hang.ddh_id` được thêm ở mig 074, nhưng ERP chỉ trả lại cùng một dòng trong cửa sổ
// ~7 giờ ⇒ đơn cũ hơn cửa sổ đó KHÔNG BAO GIỜ được sync điền vào. `ddh_id` là trường MES **gửi ngược
// lên ERP mỗi lần in tem** (`@pDDHID` của `POST /ghi-in-tem`, mig 082) — thiếu là ERP không đối soát
// được lượt in tem đó.
//
// TỰ DÒ NGÀY: không truyền ngày thì script tìm các đơn còn thiếu `ddh_id`, lấy ngày SỚM NHẤT trong
// nhóm đó (theo đợt vải của đơn, lùi về ngày tạo đơn nếu chưa có đợt) rồi trừ thêm biên an toàn.
// ⚠ API ERP nhận `?fromDate=` và trả về **từ ngày đó ĐẾN HIỆN TẠI** ⇒ lùi càng xa, proc bên ERP càng
//   nặng và phản hồi càng lâu. Vì vậy script KHÔNG gọi API khi không có gì để điền.
//
// KHỚP ĐƠN HÀNG: `order_name` = `don_hang.ma_don_hang` (đường DUY NHẤT — khác `lay:subid` có 2 lớp).
// ⚠ Đối chiếu prod 20/08/2026: `order_name` ↔ `DDHID` là **1:1 tuyệt đối** (0 đơn mang 2 DDHID, 0
//   DDHID dùng cho 2 đơn) ⇒ khớp theo mã đơn là an toàn.
//
// ⚠ Có sẵn đường KHÔNG gọi API: `database/scripts/backfill_ddh_074_tu_raw.sql` điền từ
//   `erp_phieu_nhan_vai_raw` đã lưu. Dùng script SQL đó trước cho nhẹ; script này để lấy phần mà raw
//   không còn giữ.
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const axios = require('axios');
const { query } = require('../config/db');
const env = require('../config/env');

const args = process.argv.slice(2);
const ngayEp = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || null;
const GHI = args.includes('--ghi');
const TAT_CA = args.includes('--tatca');
const BIEN_AN_TOAN_NGAY = 3;   // lùi thêm vài ngày phòng lệch múi giờ / đơn về sát ngày

function erpProxy() {
  if (!env.erp.proxyUrl) return undefined;
  try {
    const u = new URL(env.erp.proxyUrl);
    return { host: u.hostname, port: Number(u.port) || 80, protocol: u.protocol.replace(':', '') };
  } catch { return undefined; }
}

// Đọc trường không phân biệt hoa/thường + gạch dưới — cùng luật `field()` của `erpsync.service`
// (ERP đặt tên không nhất quán: `DDHID` / `ddh_id` / `ddhid`).
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
    + `${TAT_CA ? ' · ĐỐI CHIẾU TOÀN BỘ (ghi đè cả ô đã có)' : ' · chỉ điền chỗ trống'}`);

  const { rows: cot } = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_name='don_hang' AND column_name='ddh_id' LIMIT 1`);
  if (!cot.length) {
    console.error('\n✗ Bảng `don_hang` chưa có cột `ddh_id`.'
      + '\n  Chạy `database/migrations/074_erp_ddh_fields.sql` (bằng user postgres) trước đã.');
    process.exit(1);
  }

  // ─── Đơn hàng còn thiếu ───────────────────────────────────────────────────
  const { rows: thieu } = await query(
    // ⚠ Trả MỐC dạng CHUỖI 'YYYY-MM-DD' theo giờ VN: node-pg parse timestamptz thành `Date` của JS,
    //   mà `String(new Date())` ra "Fri Jul 31 2026 …" ⇒ `slice(0,10)` cho "Fri Jul 31" và
    //   `new Date('Fri Jul 31T00:00:00Z')` là **Invalid time value** (đã gặp thật khi chạy lần đầu).
    `SELECT d.id, d.ma_don_hang,
            ((COALESCE(dv.som_nhat, d.created_date) AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)::text AS moc
       FROM don_hang d
       LEFT JOIN LATERAL (SELECT min(COALESCE(v.ngay_vai_ve, v.created_date)) AS som_nhat
                            FROM ma_hang mh
                            JOIN phan_in p ON p.ma_hang_id = mh.id
                            JOIN dot_vai_ve v ON v.phan_in_id = p.id
                           WHERE mh.don_hang_id = d.id) dv ON true
      WHERE d.ddh_id IS NULL
      ORDER BY moc`.replace(/\s+/g, ' ')
  );
  const { rows: tong } = await query('SELECT count(*)::int AS c FROM don_hang');

  console.log(`\nĐơn hàng            : ${tong[0].c}`);
  console.log(`Còn THIẾU DDHID     : ${thieu.length}`);

  if (!thieu.length && !TAT_CA) {
    console.log('\n✓ Không có đơn nào thiếu DDHID — không gọi API (proc ERP rất nặng).');
    console.log('  Muốn đối chiếu lại toàn bộ với ERP thì chạy kèm `--tatca`.');
    process.exit(0);
  }

  if (thieu.length) {
    console.log('\n  Danh sách (tối đa 20 dòng đầu):');
    thieu.slice(0, 20).forEach((r) => console.log(
      `   ${String(r.ma_don_hang).padEnd(28)} mốc ${String(r.moc).slice(0, 10)}`));
    if (thieu.length > 20) console.log(`   … và ${thieu.length - 20} đơn nữa`);
  }

  // ─── Ngày bắt đầu ─────────────────────────────────────────────────────────
  let fromDate = ngayEp;
  if (!fromDate) {
    const mocSom = thieu.length ? String(thieu[0].moc).slice(0, 10) : null;
    if (!mocSom) {
      console.error('\n✗ Không tự dò được ngày (không có đơn thiếu). Truyền ngày tường minh:'
        + '\n  npm run lay:ddhid -- 2026-06-01 --ghi');
      process.exit(1);
    }
    fromDate = lui(mocSom, BIEN_AN_TOAN_NGAY);
    console.log(`\nTự dò ngày: đơn thiếu sớm nhất ${mocSom} → lùi ${BIEN_AN_TOAN_NGAY} ngày = ${fromDate}`);
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

  // Gom theo mã đơn — giữ dòng MỚI NHẤT khi trùng khóa.
  const theoDon = new Map();
  let khongCoDdh = 0;
  const nhieuGiaTri = new Map();   // mã đơn → tập DDHID khác nhau (để cảnh báo)
  for (const r of rows) {
    const ddh = truong(r, 'DDHID', 'ddh_id');
    const don = truong(r, 'order_name', 'ordername', 'ma_don_hang');
    if (!ddh) { khongCoDdh += 1; continue; }
    if (!don) continue;
    if (!nhieuGiaTri.has(don)) nhieuGiaTri.set(don, new Set());
    nhieuGiaTri.get(don).add(ddh);
    theoDon.set(don, ddh);
  }
  console.log(`Có DDHID: ${theoDon.size} mã đơn`
    + `${khongCoDdh ? ` · ${khongCoDdh} dòng không có DDHID` : ''}`);

  // ⚠ Kiểm bất biến "1 mã đơn ↔ 1 DDHID" NGAY trên dữ liệu vừa lấy. Lệch nghĩa là ERP đổi quy ước
  //   (một đơn tách nhiều DDHID) ⇒ DỪNG, đừng ghi bừa giá trị cuối cùng gặp được.
  const lech = [...nhieuGiaTri].filter(([, tap]) => tap.size > 1);
  if (lech.length) {
    console.error(`\n✗ ${lech.length} mã đơn mang NHIỀU DDHID khác nhau — vd ${lech[0][0]} ↔ ${[...lech[0][1]].join(', ')}.`);
    console.error('  Bất biến "1 đơn ↔ 1 DDHID" không còn đúng. DỪNG để bạn kiểm tra với bên ERP trước.');
    process.exit(1);
  }
  console.log('Kiểm bất biến 1 mã đơn ↔ 1 DDHID: KHỚP HẾT');

  // ─── Ghi ──────────────────────────────────────────────────────────────────
  const dkTrong = TAT_CA ? '' : ' AND d.ddh_id IS NULL';
  if (!theoDon.size) {
    console.log('\nERP không trả về mã đơn nào có DDHID trong khoảng ngày này.');
    process.exit(0);
  }
  const keys = [...theoDon.keys()];
  const vals = keys.map((k) => theoDon.get(k));
  const { rows: r1 } = await query(
    `SELECT count(*)::int AS khop,
            count(*) FILTER (WHERE d.ddh_id IS DISTINCT FROM x.ddh)::int AS doi
       FROM don_hang d
       JOIN unnest($1::text[], $2::text[]) AS x(ma, ddh) ON x.ma = d.ma_don_hang
      WHERE TRUE${dkTrong}`.replace(/\s+/g, ' '),
    [keys, vals]
  );
  if (GHI && r1[0].doi > 0) {
    await query(
      `UPDATE don_hang d SET ddh_id = x.ddh, updated_date = CURRENT_TIMESTAMP
         FROM unnest($1::text[], $2::text[]) AS x(ma, ddh)
        WHERE x.ma = d.ma_don_hang AND d.ddh_id IS DISTINCT FROM x.ddh${dkTrong}`.replace(/\s+/g, ' '),
      [keys, vals]
    );
  }
  console.log(`\nTheo mã đơn hàng : khớp ${r1[0].khop} · ${GHI ? 'đã ghi' : 'sẽ ghi'} ${r1[0].doi}`);

  const { rows: con } = await query('SELECT count(*)::int AS c FROM don_hang WHERE ddh_id IS NULL');
  console.log(`\nCòn thiếu DDHID: ${con[0].c} đơn hàng`);
  if (con[0].c && GHI) {
    console.log('  → ERP không trả về những đơn này trong khoảng ngày đã lấy.');
    console.log(`  → Thử lùi xa hơn: npm run lay:ddhid -- ${lui(fromDate, 30)} --ghi`);
  }
  if (!GHI) console.log('\n(Chưa ghi gì — chạy lại kèm `--ghi` để ghi thật.)');
  process.exit(0);
})().catch((e) => {
  console.error('✗ LỖI:', e.message);
  process.exit(1);
});
