'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// LẤY `DDHSUBID` CHO PHẦN IN TỪ API ERP (mig 088)
//
// Cách chạy (từ thư mục `backend/`):
//     node src/scripts/layDdhSubId.js 2026-07-01            ← xem thử, KHÔNG ghi gì
//     node src/scripts/layDdhSubId.js 2026-07-01 --ghi      ← ghi thật vào phan_in.ddh_sub_id
//     node src/scripts/layDdhSubId.js 2026-07-01 --ghi --de   ← ghi ĐÈ cả phần in đã có subID
//
// ⚠ API ERP nhận `?fromDate=YYYY-MM-DD` và trả về **từ ngày đó ĐẾN HIỆN TẠI** ⇒ lùi ngày càng xa thì
//   càng nhiều dữ liệu và proc bên ERP càng nặng. Nên lùi vừa đủ, chạy nhiều lần thay vì một lần thật xa.
//
// ⚠⚠ MẶC ĐỊNH LÀ XEM THỬ. Phải thêm `--ghi` mới ghi xuống DB.
// ⚠⚠ CHỈ ĐIỀN CHỖ TRỐNG, trừ khi có `--de`: phần in đã có subID (do sync mới hoặc sửa tay ở trang
//   Quản trị phần in) sẽ được giữ nguyên.
//
// KHỚP PHẦN IN THEO 2 ĐƯỜNG, ưu tiên giảm dần:
//   1. `BarcodePTHDH` = `phan_in.barcode`  ← đích danh, tin nhất (mã vạch ↔ subID là 1:1)
//   2. `code_part`    = `phan_in.ma_phan`  ← cho phần in chưa có mã vạch
//
// ⚠ Script này KHÔNG cần thiết nếu `erp_phieu_nhan_vai_raw` còn giữ đủ dữ liệu — mig 088 đã tự
//   backfill từ đó (đo prod 19/08/2026: phủ 1968/1968 phần in active). Dùng script khi cần lấy lại
//   phần in CŨ HƠN phạm vi raw còn giữ (raw bị dọn theo `ERP_RAW_RETENTION_DAYS`, mặc định 7 ngày).
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const axios = require('axios');
const { query } = require('../config/db');
const env = require('../config/env');

const args = process.argv.slice(2);
const fromDate = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const GHI = args.includes('--ghi');
const DE = args.includes('--de');

function erpProxy() {
  if (!env.erp.proxyUrl) return undefined;
  try {
    const u = new URL(env.erp.proxyUrl);
    return { host: u.hostname, port: Number(u.port) || 80, protocol: u.protocol.replace(':', '') };
  } catch { return undefined; }
}

// Đọc trường không phân biệt hoa/thường + gạch dưới (ERP đặt tên không nhất quán) — cùng luật
// `field()` của `erpsync.service`.
function truong(row, ...ten) {
  const khoa = Object.keys(row || {});
  for (const t of ten) {
    const k = khoa.find((x) => x.toLowerCase().replace(/_/g, '') === String(t).toLowerCase().replace(/_/g, ''));
    if (k && row[k] != null && String(row[k]).trim() !== '') return String(row[k]).trim();
  }
  return null;
}

(async () => {
  if (!fromDate) {
    console.error('Thiếu ngày bắt đầu.\n'
      + '  node src/scripts/layDdhSubId.js YYYY-MM-DD [--ghi] [--de]\n'
      + '  (API lấy từ ngày này ĐẾN HIỆN TẠI)');
    process.exit(1);
  }

  const db = (await query('SELECT current_database() AS d')).rows[0].d;
  console.log(`DB      : ${db}`);
  console.log(`Chế độ  : ${GHI ? 'GHI THẬT' : 'XEM THỬ (thêm --ghi để ghi)'}${DE ? ' · GHI ĐÈ cả ô đã có' : ''}`);

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
  console.log(`Nhận về : ${rows.length} dòng (${Math.round((Date.now() - t0) / 1000)}s)\n`);

  // Gom theo mã vạch phần in và theo code_part — giữ dòng MỚI NHẤT (dữ liệu về sau ghi đè trước đó).
  const theoBarcode = new Map();
  const theoCodePart = new Map();
  let boQua = 0;
  for (const r of rows) {
    const sub = truong(r, 'DDHSUBID', 'ddh_sub_id');
    if (!sub || !/^\d+$/.test(sub)) { boQua += 1; continue; }
    const bc = truong(r, 'BarcodePTHDH', 'barcode_pthdh');
    const cp = truong(r, 'code_part', 'codepart');
    if (bc) theoBarcode.set(bc, sub);
    if (cp) theoCodePart.set(cp, sub);
  }
  console.log(`Có DDHSUBID: ${theoBarcode.size} mã vạch phần in · ${theoCodePart.size} code phần`
    + `${boQua ? ` · bỏ qua ${boQua} dòng không có subID` : ''}`);

  // ⚠ Kiểm bất biến "3 số cuối mã vạch = subID" ngay trên dữ liệu vừa lấy — lệch nghĩa là ERP đổi
  //   quy ước đánh mã, phải dừng lại xem xét chứ đừng ghi bừa.
  let lech = 0;
  for (const [bc, sub] of theoBarcode) {
    if (bc.slice(-3) !== String(sub).padStart(3, '0')) lech += 1;
  }
  console.log(`Kiểm bất biến 3 số cuối mã vạch = subID: ${lech === 0 ? 'KHỚP HẾT' : `⚠ ${lech} mã LỆCH`}\n`);

  const dk = DE ? '' : ' AND p.ddh_sub_id IS NULL';
  const capNhat = async (cot, m) => {
    if (!m.size) return { doi: 0, khop: 0 };
    const keys = [...m.keys()];
    const vals = keys.map((k) => m.get(k));
    // Xem trước: đếm số dòng SẼ đổi (giá trị khác hiện tại).
    const { rows: r1 } = await query(
      `SELECT count(*)::int AS khop,
              count(*) FILTER (WHERE p.ddh_sub_id IS DISTINCT FROM x.sub)::int AS doi
         FROM phan_in p
         JOIN unnest($1::text[], $2::text[]) AS x(khoa, sub) ON x.khoa = p.${cot}
        WHERE p.dang_hoat_dong${dk}`.replace(/\s+/g, ' '),
      [keys, vals]
    );
    if (GHI && r1[0].doi > 0) {
      await query(
        `UPDATE phan_in p SET ddh_sub_id = x.sub, updated_date = CURRENT_TIMESTAMP
           FROM unnest($1::text[], $2::text[]) AS x(khoa, sub)
          WHERE x.khoa = p.${cot} AND p.dang_hoat_dong
            AND p.ddh_sub_id IS DISTINCT FROM x.sub${dk}`.replace(/\s+/g, ' '),
        [keys, vals]
      );
    }
    return r1[0];
  };

  const a = await capNhat('barcode', theoBarcode);
  console.log(`Theo mã vạch phần in : khớp ${a.khop} phần in · ${GHI ? 'đã ghi' : 'sẽ ghi'} ${a.doi}`);
  const b = await capNhat('ma_phan', theoCodePart);
  console.log(`Theo code phần       : khớp ${b.khop} phần in · ${GHI ? 'đã ghi' : 'sẽ ghi'} ${b.doi}`);

  const { rows: con } = await query(
    'SELECT count(*)::int AS c FROM phan_in WHERE dang_hoat_dong AND ddh_sub_id IS NULL');
  console.log(`\nCòn thiếu subID: ${con[0].c} phần in đang hoạt động`);
  if (!GHI) console.log('(Chưa ghi gì — chạy lại kèm `--ghi` để ghi thật.)');
  process.exit(0);
})().catch((e) => {
  console.error('✗ LỖI:', e.message);
  process.exit(1);
});
