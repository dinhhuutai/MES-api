'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SINH SCRIPT SQL SERVER: SH6 CỦA LƯỢT KCS ĐÃ TÁCH TEM 17 GỬI LẠI BẰNG MÃ TEM 17 + HỦY PHIẾU SK6 CỦA TEM 17 (19/11/2026,
//   người dùng chốt: "tem 15 mà kiểm trước bị tách thì lấy tem 17 và gửi với câu Sh6, không gọi SK6 nữa; tem 15 lúc đầu bị
//   tách rồi nên cũng không cần gửi nữa — kiểm những tem bị trường hợp trước, cho script SQL Server chạy lại Sh6").
// Luật cũ (08/11): lượt KCS kiểm một phần / chốt sau giao trước ⇒ Sh6 mang TEM 15 lúc xác nhận + SK6 mang TEM 17 lúc in lần đầu.
// Luật mới (`quality/kiemPhamErp`): Sh6 mang TEM 17, không SK6.
//
// Mỗi lượt KCS CÒN HIỆU LỰC, tem 17 còn sống, Sh6 thành công lần cuối KHÔNG mang mã tem 17:
//   (1) EXEC dbo.MES_spr_MES2Sh6 — ĐÚNG thân Sh6 thành công lần cuối (giữ IDMES · Ngày CT · ngày ca · giờ · SL đạt/hư/thiếu),
//       đổi @pBarcodeIn tem 15 → tem 17; 3 trường người theo SF0 LÚC IN của tem 15 (`utils/phanCongSf0`, luật 19/11) nếu có.
//       Proc xóa phiếu cùng Soctcu(=IDMES) rồi tạo lại ⇒ phiếu tem 15 THÀNH phiếu tem 17, không đẻ phiếu mới.
//   (2) CHỈ KHI (1) thành công: EXEC dbo.MES_spr_MES2SF0_Huy cho IDMES SK6 của tem 17 (còn hiệu lực — chưa từng báo hủy)
//       ⇒ ERP không đếm đôi tem 17 (Sh6 + SK6).
// ⚠ CHỈ ĐỌC DB MES. Ghi thẳng bên ERP ⇒ không có dòng Lịch sử API ở MES. Chạy lại vô hại (Sh6 ghi đè; hủy lần 2 ERP bỏ qua).
// ⚠ Lượt tách tem 17 xảy ra SAU lần sinh file mà TRƯỚC khi deploy BE mới vẫn đi luật cũ ⇒ sinh lại file sau deploy.
//
// CÁCH CHẠY (thư mục backend):  node src/scripts/taoSqlServerSh6Tem17Kcs.js            (mọi lượt)
//                               node src/scripts/taoSqlServerSh6Tem17Kcs.js 608084777 …  (chỉ tem 15 / tem 17 này)
//   ⇒ file ở `database/scripts/sqlserver/sh6_tem17_kcs_MMDD_HHmm.sql`.
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { query, pool } = require('../config/db');
const { phanCongSf0 } = require('../utils/phanCongSf0');
const { tChuoi, tSo, tNgay } = require('./taoSqlServerGuiLai');

const RA = path.resolve(__dirname, '../../../database/scripts/sqlserver');
const PROC = 'MES_spr_MES2Sh6';
const PROC_HUY = 'MES_spr_MES2SF0_Huy';
const LY_DO_HUY = 'Tem 17 đã gửi Sh6'; // ≤ 20 ký tự (@pLydohuy nvarchar(20))
const NGUOI_HUY = 'MES';
const rong = (v) => (v == null || String(v) === '' ? null : v);

// 20 tham số chung SF0 / SK6 / Sh6 — tên tham số = @p + tên khóa JSON (cùng `taoSqlServerSh6PhanCong`).
const THAM_SO = [
  ['IDMES', 'so'], ['Ngayct', 'ngay'], ['Ngayca', 'chuoi'], ['Tugio', 'ngay'], ['Dengio', 'ngay'],
  ['Chuyentruong', 'chuoi'], ['Catruong', 'chuoi'], ['dsthoin', 'chuoi'], ['Toin', 'chuoi'], ['banin', 'chuoi'],
  ['IDDotNhanvai', 'chuoi'], ['DDHID', 'chuoi'], ['DDHsubID', 'so'], ['BarcodeIn', 'chuoi'], ['inbosung', 'so'],
  ['Lenhbosung', 'chuoi'], ['Soluong', 'so'], ['Soluongloi', 'so'], ['SOLUONGTHIEU', 'so'], ['GCMauvai', 'chuoi'],
];
const giaTri = (b, [k, kieu]) => (kieu === 'so' ? tSo(b[k]) : kieu === 'ngay' ? tNgay(b[k]) : tChuoi(rong(b[k])));

// Lượt KCS sống + tem 17 sống + Sh6 thành công lần cuối + IDMES SK6 thành công (chưa báo hủy) của tem 17.
const SQL_LUOT = `
  SELECT k.id AS kcs_id, k.created_date, t15.id AS tem15_id, t15.ma_tem AS ma15, t17.ma_tem AS ma17, sh.gui,
         (SELECT array_agg(DISTINCT x.idm ORDER BY x.idm) FROM (
            SELECT COALESCE(a.gia_tri_moi->'gui'->>'IDMES', a.gia_tri_moi->>'id_mes') AS idm FROM audit_log a
             WHERE a.ten_bang = 'sua' AND a.id_ban_ghi = k.id::text AND a.hanh_dong = 'ERP_GUI_SUA_DAT') x
           WHERE x.idm ~ '^[0-9]{6,10}$'
             AND NOT EXISTS (SELECT 1 FROM audit_log h WHERE h.hanh_dong = 'ERP_GUI_HUY_IDMES'
                              AND COALESCE(h.gia_tri_moi->'gui'->>'IDMES', h.gia_tri_moi->>'id_mes') = x.idm)) AS sk6
    FROM kcs k
    JOIN tem t15 ON t15.id = k.tem_id
    JOIN LATERAL (SELECT t.ma_tem FROM tem t WHERE t.kcs_tach_id = k.id AND t.trang_thai <> 'HUY'
                   ORDER BY t.created_date DESC LIMIT 1) t17 ON true
    JOIN LATERAL (SELECT a.gia_tri_moi->'gui' AS gui FROM audit_log a WHERE a.ten_bang = 'kcs'
                   AND a.id_ban_ghi = k.id::text AND a.hanh_dong = 'ERP_GUI_KIEM_PHAM'
                   ORDER BY a.thoi_gian DESC LIMIT 1) sh ON true
   WHERE NOT EXISTS (SELECT 1 FROM audit_log h WHERE h.ten_bang = 'kcs' AND h.id_ban_ghi = k.id::text
                      AND h.hanh_dong = 'HUY_XAC_NHAN')
     AND COALESCE(sh.gui->>'BarcodeIn', '') <> t17.ma_tem
     AND ($1::text[] IS NULL OR t15.ma_tem = ANY($1::text[]) OR t17.ma_tem = ANY($1::text[]))
   ORDER BY k.created_date`;

function kiemProc() {
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
IF @huy_sk6 = 1 AND OBJECT_ID(N'dbo.${PROC_HUY}') IS NULL
BEGIN
  PRINT N'✗ Không thấy proc dbo.${PROC_HUY} — KHÔNG chạy gì (hoặc đặt @huy_sk6 = 0 để chỉ ghi lại Sh6).';
  SET @chay_that = 0;
END
`;
}

// 1 lượt: Sh6 (TRY/CATCH) → thành công mới hủy từng IDMES SK6 (TRY/CATCH riêng).
function khoiLuot(stt, nhan, thamSoSh6, sk6) {
  const n = tChuoi(nhan);
  const ts = thamSoSh6.map(([k, v]) => `@${k} = ${v}`).join(', ');
  const huy = sk6.map((idm) => `
    IF @sh6_ok = 1 AND @huy_sk6 = 1
    BEGIN
      BEGIN TRY
        SET @rv = NULL;
        EXEC @rv = dbo.${PROC_HUY} @pIDMES = ${tSo(idm)}, @pNgayHuy = @ngay_huy, @pNguoiHuy = ${tChuoi(NGUOI_HUY)}, @pLydohuy = ${tChuoi(LY_DO_HUY)};
        IF ISNULL(@rv, 0) = 0 SET @huy_ok += 1;
        ELSE BEGIN SET @canh_bao += 1; PRINT N'⚠ ' + ${n} + N' — hủy SK6 IDMES ${idm} trả returnValue = ' + CAST(@rv AS nvarchar(20)); END
      END TRY
      BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        SET @loi += 1; PRINT N'✗ ' + ${n} + N' — hủy SK6 IDMES ${idm}: ' + ERROR_MESSAGE();
      END CATCH
    END`).join('');
  return `IF @chay_that = 1 AND (@chi_stt IS NULL OR @chi_stt = ${stt})
BEGIN
  SET @sh6_ok = 0;
  BEGIN TRY
    SET @rv = NULL;
    EXEC @rv = dbo.${PROC} ${ts};
    IF ISNULL(@rv, 0) = 0 BEGIN SET @ok += 1; SET @sh6_ok = 1; END
    ELSE BEGIN SET @canh_bao += 1; PRINT N'⚠ ' + ${n} + N' — Sh6 trả returnValue = ' + CAST(@rv AS nvarchar(20)) + N' (KHÔNG hủy SK6)'; END
  END TRY
  BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    SET @loi += 1; PRINT N'✗ ' + ${n} + N' — Sh6: ' + ERROR_MESSAGE() + N' (KHÔNG hủy SK6)';
  END CATCH${huy}
END
ELSE IF @chi_stt IS NULL OR @chi_stt = ${stt} BEGIN SET @dem += 1; SET @dem_huy += ${sk6.length}; END`;
}

async function main() {
  // ⚠⚠ LỖI THỜI từ 25/11/2026: proc Sh6 nay có `@pBarcode17` (không mặc định) và `BarcodeIn` phải là TEM 15 — file sinh ra
  //   đổi `BarcodeIn` sang tem 17 và thiếu `@pBarcode17` ⇒ sai luật + lỗi "expects parameter". Gửi lại các lượt này qua MES:
  //   `node src/scripts/guiLaiLuotLoiErp.js --ma=ERP_GUI_KIEM_PHAM --tu=2026-11-19 --tem17 [--gui]`. Hủy SK6 cũ: `taoSqlServerHuySk6Tem17Kcs.js`.
  throw new Error('Script lỗi thời (25/11/2026) — dùng guiLaiLuotLoiErp.js --tem17, xem chú thích đầu hàm main');
  // eslint-disable-next-line no-unreachable
  const vao = process.argv.slice(2).map((x) => String(x).trim()).filter((x) => /^\d{9,12}$/.test(x));
  const ma = vao.length ? vao.map((x) => (x.length === 12 ? x : `15${x.padStart(10, '2')}`)) : null;
  // Mã 17 truyền dạng đuôi thì cũng thử khớp tiền tố 17.
  const maLoc = ma ? [...new Set([...ma, ...vao.filter((x) => x.length < 12).map((x) => `17${x.padStart(10, '2')}`)])] : null;
  const { rows: db } = await query('SELECT current_database() AS d, inet_server_addr()::text AS h');
  console.log(`[sh6-tem17] Đọc DB ${db[0].d} @ ${db[0].h || 'local'} (chỉ SELECT)${ma ? ` · lọc ${ma.length} mã` : ' · mọi lượt'}`);

  const { rows: luot } = await query(SQL_LUOT.replace(/\s+/g, ' '), [maLoc]);
  const pc = luot.length ? await phanCongSf0([...new Set(luot.map((l) => l.tem15_id))]) : new Map();

  const boQua = [];
  const khoi = [];
  let soHuy = 0;
  for (const l of luot) {
    const cu = l.gui || {};
    if (cu.IDMES == null) { boQua.push(`${l.ma15} → ${l.ma17} — Sh6 cũ không có IDMES`); continue; }
    const sf0 = pc.get(String(l.tem15_id));
    const b = { ...cu, BarcodeIn: l.ma17, ...(sf0 ? { Catruong: sf0.Catruong, Chuyentruong: sf0.Chuyentruong, dsthoin: sf0.dsthoin } : {}) };
    const sk6 = (l.sk6 || []).filter(Boolean);
    soHuy += sk6.length;
    const stt = khoi.length + 1;
    const nguoi = sf0 ? ['Catruong', 'Chuyentruong', 'dsthoin'].filter((k) => String(cu[k] || '') !== String(b[k] || ''))
      .map((k) => `${k} ${cu[k] || '∅'} → ${b[k] || '∅'}`).join(' · ') : 'không có SF0 — giữ người cũ';
    const ngay = new Date(new Date(l.created_date).getTime() + 7 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
    khoi.push(`-- [${stt}] KCS ${ngay} · tem ${l.ma15} → ${l.ma17} · Sh6 IDMES ${cu.IDMES} · đạt ${cu.Soluong ?? 0} hư ${cu.Soluongloi ?? 0} thiếu ${cu.SOLUONGTHIEU ?? 0}`
      + ` · hủy SK6 ${sk6.length ? sk6.join(', ') : '(không có SK6 còn hiệu lực)'}${nguoi ? ` · ${nguoi}` : ''}\n`
      + khoiLuot(stt, `[${stt}] ${l.ma17} (Sh6 IDMES ${cu.IDMES})`, THAM_SO.map((p) => [`p${p[0]}`, giaTri(b, p)]), sk6));
  }

  const bq = boQua.length ? boQua.map((x) => `--   · ${x}`).join('\n') : '--   (không có)';
  const noiDung = `-- =============================================================================
-- SH6 CỦA LƯỢT KCS ĐÃ TÁCH TEM 17 ⇒ GỬI LẠI BẰNG MÃ TEM 17 + HỦY PHIẾU SK6 CỦA TEM 17
-- Sinh lúc ${new Date().toISOString()} từ DB MES bằng backend/src/scripts/taoSqlServerSh6Tem17Kcs.js — CHẠY TRÊN DB ERP.
-- -----------------------------------------------------------------------------
-- Luật mới: tem 15 kiểm trước bị tách ⇒ Sh6 mang mã TEM 17, không gửi tem 15, không SK6.
-- ${khoi.length} lượt KCS đang đi luật cũ (Sh6 mang tem 15 + SK6 mang tem 17). Mỗi lượt:
--   (1) EXEC dbo.${PROC}: ĐÚNG thân Sh6 đã gửi thành công lần cuối (giữ IDMES, Ngày CT, ngày ca, giờ, SL đạt / hư / thiếu),
--       @pBarcodeIn tem 15 → tem 17; ca trưởng / chuyền trưởng / thợ in = của SF0 lúc in (nếu có).
--       Proc XÓA phiếu cùng Soctcu(=IDMES) rồi tạo lại ⇒ phiếu tem 15 thành phiếu tem 17, không đẻ phiếu mới.
--   (2) CHỈ KHI (1) thành công: EXEC dbo.${PROC_HUY} hủy phiếu SK6 của tem 17 (${soHuy} IDMES) ⇒ ERP không đếm đôi.
-- Chạy lại lần 2 vô hại.
--
-- CÁCH CHẠY (SSMS, đúng DB ERP):
--   1. Để nguyên @chay_that = 0 → F5: chỉ ĐẾM (bảng cuối: se_chay = ${khoi.length}, se_huy_sk6 = ${soHuy}).
--   2. Nên thử 1 lượt trước: @chay_that = 1, @chi_stt = 1 → F5, rồi xem bên ERP phiếu Sh6 IDMES đó đã mang tem 17 và
--      phiếu SK6 đã hủy chưa.
--   3. @chay_that = 1, @chi_stt = NULL → F5: chạy hết. Bảng cuối: ok · huy_sk6_ok · canh_bao · loi. loi > 0 ⇒ gửi tab Messages cho MES.
--   Muốn chỉ ghi lại Sh6, KHÔNG hủy SK6 ⇒ @huy_sk6 = 0.
--
-- BỎ QUA:
${bq}
-- =============================================================================
SET NOCOUNT ON;
DECLARE @chay_that bit = 0;   -- ← ĐỔI THÀNH 1 ĐỂ CHẠY THẬT
DECLARE @chi_stt int = NULL;  -- số [stt] ⇒ chỉ chạy đúng lượt đó
DECLARE @huy_sk6 bit = 1;     -- 1 = hủy phiếu SK6 của tem 17 sau khi Sh6 thành công
DECLARE @ngay_huy datetime = GETDATE();
DECLARE @rv int, @ok int = 0, @huy_ok int = 0, @canh_bao int = 0, @loi int = 0, @dem int = 0, @dem_huy int = 0, @sh6_ok bit = 0;
${kiemProc()}
${khoi.join('\n')}

SELECT CASE WHEN @chay_that = 1 THEN N'DA_CHAY' ELSE N'DEM_THU' END AS che_do, ${khoi.length} AS tong_luot,
       @dem AS se_chay, @dem_huy AS se_huy_sk6, @ok AS ok, @huy_ok AS huy_sk6_ok, @canh_bao AS canh_bao, @loi AS loi;
`;
  fs.mkdirSync(RA, { recursive: true });
  const vn = new Date(Date.now() + 7 * 3600e3).toISOString();
  const f = path.join(RA, `sh6_tem17_kcs_${vn.slice(5, 10).replace('-', '')}_${vn.slice(11, 16).replace(':', '')}.sql`);
  fs.writeFileSync(f, `﻿${noiDung}`, 'utf8'); // BOM ⇒ SSMS đọc đúng tiếng Việt
  console.log(`[sh6-tem17] ✓ ${khoi.length} lượt · hủy SK6 ${soHuy} IDMES · bỏ qua ${boQua.length} ⇒ ${f}`);
  boQua.forEach((x) => console.log(`   bỏ qua: ${x}`));
}

main()
  .catch((e) => { console.error(`[sh6-tem17] ✗ ${e.message}`); process.exitCode = 1; })
  .finally(() => pool.end().catch(() => {}));
