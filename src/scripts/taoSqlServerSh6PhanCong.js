'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SINH SCRIPT SQL SERVER GHI LẠI PHIẾU KIỂM PHẨM SH6 THEO PHÂN CÔNG CỦA SF0 (19/11/2026, người dùng chốt: "Sh6 phải lấy lại
//   ca trưởng, chuyền trưởng, thợ in của tem in SF0 … chỉ cần các tem này").
// Mỗi lượt KCS CÒN HIỆU LỰC đã gửi Sh6 THÀNH CÔNG của tem ⇒ 1 `EXEC dbo.MES_spr_MES2Sh6` với ĐÚNG thân đã gửi lần cuối
//   (giữ IDMES · Ngày CT · ngày ca · giờ · SL) CHỈ thay 3 trường `@pCatruong` / `@pChuyentruong` / `@pdsthoin` bằng của lần
//   gửi SF0 mới nhất của tem (`utils/phanCongSf0`). Proc xóa phiếu cùng Soctcu(=IDMES)+SH6 rồi tạo lại ⇒ ghi đè, không trùng.
// ⚠ 19/11/2026 chiều: "SF0 của tem" = lần gửi LÚC IN (`phanCongSf0` — lần thành công đầu tiên; "Gửi lại" / Sửa tem đã ghi
//   đè SF0 bên ERP bằng người ca sau). File sinh thêm phần GHI LẠI SF0 (`MES_spr_MES2SF0`) cho tem mà SF0 mới nhất lệch người
//   lúc in: ĐÚNG thân SF0 thành công mới nhất (giữ IDMES · SL · bổ sung · kiếng · BTP), chỉ thay 3 trường người. Chạy trước Sh6.
// ⚠ CHỈ ĐỌC DB MES. Ghi thẳng bên ERP ⇒ không có dòng Lịch sử API ở MES.
//
// CÁCH CHẠY (thư mục backend):  node src/scripts/taoSqlServerSh6PhanCong.js 608084777 608084786 …
//   (mã tem đủ 12 số hoặc 9–10 số đuôi) ⇒ file ở `database/scripts/sqlserver/`.
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { query, pool } = require('../config/db');
const { phanCongSf0 } = require('../utils/phanCongSf0');
const { tChuoi, tSo, tNgay, thamSoSf0, khoiExec, cuoiFile } = require('./taoSqlServerGuiLai');

const RA = path.resolve(__dirname, '../../../database/scripts/sqlserver');
const PROC = 'MES_spr_MES2Sh6';
const rong = (v) => (v == null || String(v) === '' ? null : v);

// 20 tham số chung của SF0 / SK6 / Sh6 (`utils/erpGhiInTem THU_TU_TRUONG`) — tên tham số = @p + tên khóa JSON.
const THAM_SO = [
  ['IDMES', 'so'], ['Ngayct', 'ngay'], ['Ngayca', 'chuoi'], ['Tugio', 'ngay'], ['Dengio', 'ngay'],
  ['Chuyentruong', 'chuoi'], ['Catruong', 'chuoi'], ['dsthoin', 'chuoi'], ['Toin', 'chuoi'], ['banin', 'chuoi'],
  ['IDDotNhanvai', 'chuoi'], ['DDHID', 'chuoi'], ['DDHsubID', 'so'], ['BarcodeIn', 'chuoi'], ['inbosung', 'so'],
  ['Lenhbosung', 'chuoi'], ['Soluong', 'so'], ['Soluongloi', 'so'], ['SOLUONGTHIEU', 'so'], ['GCMauvai', 'chuoi'],
  // 23/11/2026 proc Sh6 thêm `@pBarcode17` (KHÔNG mặc định): tem 17 của lượt giao trước, không có ⇒ N'' (không NULL).
  ['Barcode17', 'rong'],
];
const giaTri = (b, [k, kieu]) => (kieu === 'so' ? tSo(b[k]) : kieu === 'ngay' ? tNgay(b[k])
  : kieu === 'rong' ? tChuoi(String(b[k] || '').slice(0, 20)) : tChuoi(rong(b[k])));

// Đầu file: kiểm proc có ĐỦ 21 tham số đúng tên — thiếu ⇒ in tên thiếu và ép chạy thử (không EXEC gì).
// ⚠ SQL Server ERP là bản CŨ (< 2017): KHÔNG có `STRING_AGG` (ca thật 19/11/2026: Msg 195) ⇒ ghép bằng `FOR XML PATH` + `STUFF`.
function kiemThamSo() {
  const ds = THAM_SO.map(([k]) => `(N'@p${k}')`).join(', ');
  return `DECLARE @thieu nvarchar(max);
SELECT @thieu = STUFF((
  SELECT N', ' + x.ten FROM (VALUES ${ds}) x(ten)
   WHERE NOT EXISTS (SELECT 1 FROM sys.parameters p WHERE p.object_id = OBJECT_ID(N'dbo.${PROC}') AND p.name = x.ten)
  FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 2, N'');
IF OBJECT_ID(N'dbo.${PROC}') IS NULL OR @thieu IS NOT NULL
BEGIN
  PRINT N'✗ Proc dbo.${PROC} không có hoặc thiếu tham số: ' + ISNULL(@thieu, N'(không thấy proc)') + N' — KHÔNG chạy gì.';
  SET @chay_that = 0;
END
`;
}

async function main() {
  const vao = process.argv.slice(2).map((x) => String(x).trim()).filter((x) => /^\d{9,12}$/.test(x));
  if (!vao.length) throw new Error('Truyền mã tem (12 số hoặc số đuôi)');
  const { rows: db } = await query('SELECT current_database() AS d, inet_server_addr()::text AS h');
  console.log(`[sh6] Đọc DB ${db[0].d} @ ${db[0].h || 'local'} (chỉ SELECT) · ${vao.length} mã`);
  const maDu = vao.map((x) => (x.length === 12 ? x : `15${x.padStart(10, '2')}`));

  const { rows: tems } = await query('SELECT id, ma_tem FROM tem WHERE ma_tem = ANY($1::text[]) AND tem_goc_id IS NULL', [maDu]);
  const mTem = new Map(tems.map((t) => [t.ma_tem, t]));
  const boQua = maDu.filter((m) => !mTem.has(m)).map((m) => `${m} — không thấy tem`);

  // Thân Sh6 THÀNH CÔNG mới nhất của từng lượt KCS còn hiệu lực.
  const { rows: luot } = await query(`SELECT k.id AS kcs_id, k.tem_id, k.created_date, x.gui FROM kcs k
      CROSS JOIN LATERAL (SELECT a.gia_tri_moi->'gui' AS gui FROM audit_log a WHERE a.ten_bang = 'kcs'
         AND a.id_ban_ghi = k.id::text AND a.hanh_dong = 'ERP_GUI_KIEM_PHAM' ORDER BY a.thoi_gian DESC LIMIT 1) x
     WHERE k.tem_id = ANY($1::uuid[])
       AND NOT EXISTS (SELECT 1 FROM audit_log h WHERE h.ten_bang = 'kcs' AND h.id_ban_ghi = k.id::text AND h.hanh_dong = 'HUY_XAC_NHAN')
     ORDER BY k.created_date`.replace(/\s+/g, ' '), [tems.map((t) => t.id)]);
  const coLuot = new Set(luot.map((l) => l.tem_id));
  tems.filter((t) => !coLuot.has(t.id)).forEach((t) => boQua.push(`${t.ma_tem} — không có lượt KCS đã gửi Sh6 thành công`));

  const pc = await phanCongSf0(tems.map((t) => t.id));

  // SF0: thân thành công MỚI NHẤT; người lệch SF0 lúc in ⇒ ghi lại (SF0 trống người gửi `-`, như router).
  const { rows: sf0Moi } = await query(`SELECT t.id AS tem_id, x.gui FROM tem t
      CROSS JOIN LATERAL (SELECT a.gia_tri_moi->'gui' AS gui FROM audit_log a WHERE a.ten_bang = 'tem'
         AND a.id_ban_ghi = t.id::text AND a.hanh_dong = 'ERP_GHI_IN_TEM' ORDER BY a.thoi_gian DESC LIMIT 1) x
     WHERE t.id = ANY($1::uuid[])`.replace(/\s+/g, ' '), [tems.map((t) => t.id)]);
  const khoiSf0 = [];
  for (const s of sf0Moi) {
    const t = tems.find((x) => x.id === s.tem_id);
    const p = pc.get(String(s.tem_id));
    const cu = s.gui || {};
    if (!p || cu.IDMES == null) continue;
    const moi = { Catruong: p.Catruong || '-', Chuyentruong: p.Chuyentruong || '-', dsthoin: p.dsthoin || '-' };
    const keys = ['Catruong', 'Chuyentruong', 'dsthoin'];
    if (keys.every((k) => String(cu[k] || '-') === moi[k])) continue; // SF0 bên ERP đã đúng người lúc in
    const b = { ...cu, ...moi };
    khoiSf0.push(`-- SF0 ${t.ma_tem} · IDMES ${cu.IDMES} · ${keys.map((k) => `${k} ${cu[k] || '∅'} → ${moi[k]}`).join(' · ')}\n`
      + khoiExec('MES_spr_MES2SF0', `SF0 ${t.ma_tem} (IDMES ${cu.IDMES})`, thamSoSf0(b)));
  }

  const khoi = [];
  for (const l of luot) {
    const t = tems.find((x) => x.id === l.tem_id);
    const sf0 = pc.get(String(l.tem_id));
    const cu = l.gui || {};
    if (!sf0) { boQua.push(`${t.ma_tem} — không có SF0`); continue; }
    if (cu.IDMES == null) { boQua.push(`${t.ma_tem} — Sh6 cũ không có IDMES`); continue; }
    const b = { ...cu, Catruong: sf0.Catruong, Chuyentruong: sf0.Chuyentruong, dsthoin: sf0.dsthoin };
    // Thân 19/11–25/11 của lượt giao trước mang tem 17 ở `BarcodeIn` ⇒ đổi về thân mới: tem 15 + `Barcode17` = tem 17.
    if (/^17\d{10}$/.test(String(cu.BarcodeIn || ''))) { b.Barcode17 = cu.Barcode17 || cu.BarcodeIn; b.BarcodeIn = t.ma_tem; }
    const doi = ['Catruong', 'Chuyentruong', 'dsthoin']
      .map((k) => `${k} ${cu[k] || '∅'} → ${b[k] || '∅'}`).join(' · ');
    khoi.push(`-- ${t.ma_tem} · lượt KCS ${l.kcs_id} · IDMES ${cu.IDMES} · ${doi}\n`
      + khoiExec(PROC, `${t.ma_tem} (IDMES ${cu.IDMES})`, THAM_SO.map((p) => [`p${p[0]}`, giaTri(b, p)])));
  }

  const bq = boQua.length ? boQua.map((x) => `--   · ${x}`).join('\n') : '--   (không có)';
  const tong = khoiSf0.length + khoi.length;
  const noiDung = `-- =============================================================================
-- GHI LẠI SF0 + SH6 — CA TRƯỞNG / CHUYỀN TRƯỞNG / THỢ IN THEO PHIẾU IN TEM SF0 LÚC IN
-- Sinh lúc ${new Date().toISOString()} từ DB MES bằng backend/src/scripts/taoSqlServerSh6PhanCong.js — CHẠY TRÊN DB ERP.
-- -----------------------------------------------------------------------------
-- Phần 1: ${khoiSf0.length} phiếu SF0 (dbo.MES_spr_MES2SF0) mà lần gửi lại đã ghi đè người ca sau — ĐÚNG thân SF0 mới nhất
--   (giữ IDMES, SL, SL bổ sung, kiếng, BTP), CHỈ thay 3 trường người bằng người LÚC IN.
-- Phần 2: ${khoi.length} phiếu Sh6 (dbo.${PROC}) của ${tems.length} tem. Mỗi dòng = ĐÚNG thân Sh6 đã gửi thành công lần cuối
--   (giữ IDMES, Ngày CT, ngày ca, giờ, SL đạt / hư / thiếu), CHỈ thay @pCatruong · @pChuyentruong · @pdsthoin bằng của SF0 lúc in.
-- Proc XÓA phiếu cùng Soctcu(=IDMES) rồi tạo lại ⇒ ghi đè, không đẻ phiếu mới. Chạy lại lần 2 vô hại.
--
-- CÁCH CHẠY (SSMS, đúng DB ERP):
--   1. Để nguyên @chay_that = 0 → F5: chỉ ĐẾM (bảng cuối: se_chay = ${tong}); proc Sh6 thiếu tham số thì tab Messages báo.
--   2. Đổi @chay_that = 1 → F5: chạy thật. Bảng cuối: ok · canh_bao · loi. Gửi tab Messages cho MES nếu loi > 0.
--
-- BỎ QUA:
${bq}
-- =============================================================================
SET NOCOUNT ON;
DECLARE @chay_that bit = 0;   -- ← ĐỔI THÀNH 1 ĐỂ CHẠY THẬT
DECLARE @rv int, @ok int = 0, @canh_bao int = 0, @loi int = 0, @dem int = 0;
${kiemThamSo()}
-- ─── PHẦN 1 · SF0 ─────────────────────────────────────────────────────────────
${khoiSf0.join('\n') || '-- (SF0 bên ERP đã đúng người lúc in — không cần ghi lại)'}
-- ─── PHẦN 2 · SH6 ─────────────────────────────────────────────────────────────
${khoi.join('\n')}
${cuoiFile(tong)}`;
  fs.mkdirSync(RA, { recursive: true });
  // Tên có giờ (giờ VN) — chạy nhiều lượt trong ngày không ghi đè file người dùng có thể đã chạy.
  const vn = new Date(Date.now() + 7 * 3600e3).toISOString();
  const f = path.join(RA, `sf0_sh6_phan_cong_${vn.slice(5, 10).replace('-', '')}_${vn.slice(11, 16).replace(':', '')}.sql`);
  fs.writeFileSync(f, `﻿${noiDung}`, 'utf8'); // BOM ⇒ SSMS đọc đúng tiếng Việt
  console.log(`[sh6] ✓ SF0 ${khoiSf0.length} + Sh6 ${khoi.length} EXEC · bỏ qua ${boQua.length} ⇒ ${f}`);
  boQua.forEach((x) => console.log(`   bỏ qua: ${x}`));
}

main()
  .catch((e) => { console.error(`[sh6] ✗ ${e.message}`); process.exitCode = 1; })
  .finally(() => pool.end().catch(() => {}));
