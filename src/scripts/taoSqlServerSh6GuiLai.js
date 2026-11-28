'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SINH SCRIPT SQL SERVER GỌI LẠI SH6 (proc `MES_spr_MES2Sh6`) CHO LƯỢT KCS GỬI ERP BỊ LỖI — 28/11/2026.
//   Dùng khi đường truyền MES → ERP đứt (vd 27/11 19:36 → sáng 28/11: "timeout of 10000ms exceeded" / ETIMEDOUT
//   118.69.134.179:5000) mà người dùng chạy thẳng proc bên ERP thay vì chờ hàng đợi MES tự gửi lại.
//
// Mỗi lượt KCS CÒN HIỆU LỰC (không có `HUY_XAC_NHAN`), CHƯA có lần Sh6 thành công nào, có ≥1 dòng `ERP_GUI_KIEM_PHAM_LOI`
//   ⇒ 1 `EXEC dbo.MES_spr_MES2Sh6` với ĐÚNG thân của lần thử GẦN NHẤT (`audit_log.gia_tri_moi.gui` — cùng IDMES, Ngày CT, ngày ca,
//   giờ, chuyền / tổ / người theo SF0, SL đạt / hư / thiếu, BarcodeIn tem 15, Barcode17). Tham số y hệt router
//   `docs/erp-router/gui-erp-kiem-pham.js` (chuỗi rỗng ⇒ NULL như `|| null`; `@pBarcode17` rỗng ⇒ '' — proc không có mặc định).
//   Cùng IDMES ⇒ proc xóa phiếu cùng Soctcu rồi tạo lại: chạy file 2 lần, hoặc MES tự gửi lại sau khi đường truyền thông, đều
//   KHÔNG đẻ phiếu trùng.
// ⚠ CHỈ ĐỌC DB MES (SELECT) — không ghi gì, không gọi ERP. In `current_database()` ra đầu tiên.
// ⚠ Ghi thẳng bên ERP ⇒ MES vẫn hiện các lượt này là LỖI ở Cài đặt API › Lịch sử (bấm "Gửi lại" sau này vẫn vô hại).
// ⚠ SL lượt KCS đổi SAU lần thử cuối (OQC trả về, sửa lượt…) ⇒ file ghi CẢNH BÁO ở dòng chú thích — kiểm trước khi chạy.
//
// CÁCH CHẠY (thư mục backend):
//     node src/scripts/taoSqlServerSh6GuiLai.js                                   ← lượt KCS từ 00:00 hôm nay (giờ VN)
//     node src/scripts/taoSqlServerSh6GuiLai.js --tu="2026-11-27 19:30"           ← từ mốc khác
//     node src/scripts/taoSqlServerSh6GuiLai.js --tu="2026-11-28" --den="2026-11-28 12:00"
//   ⇒ file ở `database/scripts/sqlserver/sh6_gui_lai_MMDD_HHmm.sql` — mở bằng SSMS trên DB ERP, đọc đầu file, F5.
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { query, pool } = require('../config/db');
const { tChuoi, tSo, tNgay, khoiExec, cuoiFile } = require('./taoSqlServerGuiLai');

const RA = path.resolve(__dirname, '../../../database/scripts/sqlserver');
const PROC = 'MES_spr_MES2Sh6';
const thamSo = (ten) => { const a = process.argv.find((x) => x.startsWith(`--${ten}=`)); return a ? a.slice(ten.length + 3).trim() : null; };
const vnBayGio = () => new Date(Date.now() + 7 * 3600e3).toISOString(); // giờ VN dán nhãn Z
const TU = thamSo('tu') || `${vnBayGio().slice(0, 10)} 00:00`;
const DEN = thamSo('den') || null;
const rong = (v) => (v == null || String(v) === '' ? null : v);

// 21 tham số — y hệt router `/gui-erp-kiem-pham` bản 25/11/2026.
const thamSoSh6 = (b) => [
  ['pIDMES', tSo(b.IDMES)], ['pNgayct', tNgay(b.Ngayct)], ['pNgayca', tChuoi(rong(b.Ngayca))],
  ['pTugio', tNgay(b.Tugio)], ['pDengio', tNgay(b.Dengio)],
  ['pChuyentruong', tChuoi(rong(b.Chuyentruong))], ['pCatruong', tChuoi(rong(b.Catruong))],
  ['pdsthoin', tChuoi(rong(b.dsthoin))], ['pToin', tChuoi(rong(b.Toin))], ['pbanin', tChuoi(rong(b.banin))],
  ['pIDDotNhanvai', tChuoi(rong(b.IDDotNhanvai))], ['pDDHID', tChuoi(rong(b.DDHID))], ['pDDHsubID', tSo(b.DDHsubID)],
  ['pBarcodeIn', tChuoi(rong(b.BarcodeIn))], ['pinbosung', tSo(b.inbosung)], ['pLenhbosung', tChuoi(rong(b.Lenhbosung))],
  ['pSoluong', tSo(b.Soluong)], ['pSoluongloi', tSo(b.Soluongloi)], ['pSOLUONGTHIEU', tSo(b.SOLUONGTHIEU)],
  ['pGCMauvai', tChuoi(rong(b.GCMauvai))],
  ['pBarcode17', tChuoi(String(b.Barcode17 == null ? '' : b.Barcode17).trim().slice(0, 20))],
];

// Lượt KCS trong khoảng, còn hiệu lực, chưa có Sh6 thành công + thân của lần thử lỗi GẦN NHẤT + số hiện tại của lượt.
const SQL_LUOT = `
  SELECT k.id, t.ma_tem, k.so_luong_dat, k.so_luong_loi, k.so_luong_chenh_lech,
         to_char(k.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM HH24:MI') AS gio_kcs,
         lt.gui, lt.so_lan, lt.loi
    FROM kcs k
    JOIN tem t ON t.id = k.tem_id
    LEFT JOIN LATERAL (
      SELECT (array_agg(a.gia_tri_moi->'gui' ORDER BY a.thoi_gian DESC))[1] AS gui,
             (array_agg(a.gia_tri_moi->>'loi' ORDER BY a.thoi_gian DESC))[1] AS loi, count(*)::int AS so_lan
        FROM audit_log a
       WHERE a.ten_bang = 'kcs' AND a.id_ban_ghi = k.id::text AND a.hanh_dong = 'ERP_GUI_KIEM_PHAM_LOI') lt ON true
   WHERE k.created_date >= ($1::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
     AND ($2::timestamp IS NULL OR k.created_date < ($2::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'))
     AND NOT EXISTS (SELECT 1 FROM audit_log h WHERE h.ten_bang = 'kcs' AND h.id_ban_ghi = k.id::text
                      AND h.hanh_dong = 'HUY_XAC_NHAN')
     AND NOT EXISTS (SELECT 1 FROM audit_log s WHERE s.ten_bang = 'kcs' AND s.id_ban_ghi = k.id::text
                      AND s.hanh_dong = 'ERP_GUI_KIEM_PHAM')
   ORDER BY k.created_date`;

// Proc phải có đủ 21 tham số (proc cũ thiếu @pBarcode17 ⇒ mọi dòng lỗi) — không đủ thì không chạy gì.
function kiemProc() {
  const ds = thamSoSh6({}).map(([k]) => `(N'@${k}')`).join(', ');
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
  const { rows: db } = await query('SELECT current_database() AS d, inet_server_addr()::text AS h');
  console.log(`[sh6-gui-lai] Đọc DB ${db[0].d} @ ${db[0].h || 'local'} (chỉ SELECT) · lượt KCS từ ${TU}${DEN ? ` tới ${DEN}` : ''} (giờ VN)`);
  const { rows } = await query(SQL_LUOT.replace(/\s+/g, ' '), [TU, DEN]);

  const boQua = []; const khoi = []; let canhBao = 0;
  for (const r of rows) {
    const b = r.gui || {};
    if (!r.so_lan) { boQua.push(`${r.ma_tem} · KCS ${r.gio_kcs} — chưa từng gửi Sh6 (API tắt / chưa có mã tem ERP) — không có thân để gọi`); continue; }
    if (b.IDMES == null || !/^15\d{10}$/.test(String(b.BarcodeIn || ''))) {
      boQua.push(`${r.ma_tem} · KCS ${r.gio_kcs} — thân lần thử cuối thiếu IDMES / BarcodeIn không phải mã tem ERP`); continue;
    }
    const thieu = Math.max(0, -(Number(r.so_luong_chenh_lech) || 0));
    const lech = [['đạt', b.Soluong, r.so_luong_dat], ['hư', b.Soluongloi, r.so_luong_loi], ['thiếu', b.SOLUONGTHIEU, thieu]]
      .filter(([, gui, nay]) => Number(gui || 0) !== Number(nay || 0)).map(([t, gui, nay]) => `${t} gửi ${gui ?? 0} ≠ hiện ${nay ?? 0}`);
    if (lech.length) canhBao += 1;
    khoi.push(`-- [${khoi.length + 1}] KCS ${r.gio_kcs} · tem ${b.BarcodeIn} · IDMES ${b.IDMES} · đạt ${b.Soluong ?? 0} hư ${b.Soluongloi ?? 0}`
      + ` thiếu ${b.SOLUONGTHIEU ?? 0} · chuyền ${b.banin || '—'} · ngày ca ${b.Ngayca || '—'}`
      + `${b.Barcode17 ? ` · tem 17 ${b.Barcode17}` : ''} · đã thử ${r.so_lan} lần`
      + `${lech.length ? `\n-- ⚠ CẢNH BÁO: số của lượt đã đổi sau lần thử cuối (${lech.join(' · ')}) — kiểm trước khi chạy` : ''}\n`
      + khoiExec(PROC, `${b.BarcodeIn} (IDMES ${b.IDMES})`, thamSoSh6(b)));
  }

  const tong = khoi.length;
  const bq = boQua.length ? boQua.map((x) => `--   · ${x}`).join('\n') : '--   (không có)';
  const noiDung = `-- =============================================================================
-- GỌI LẠI SH6 (MES_spr_MES2Sh6) — ${tong} lượt KCS gửi ERP bị lỗi, KCS từ ${TU}${DEN ? ` tới ${DEN}` : ''} (giờ VN)
-- Sinh lúc ${vnBayGio().slice(0, 16).replace('T', ' ')} (giờ VN) từ DB MES bằng backend/src/scripts/taoSqlServerSh6GuiLai.js — CHẠY TRÊN DB ERP.
-- -----------------------------------------------------------------------------
-- Lượt KCS còn hiệu lực, CHƯA có lần Sh6 thành công (đường truyền MES → ERP lỗi). Mỗi khối = 1 EXEC dbo.${PROC}
--   với ĐÚNG thân MES đã gửi ở lần thử cuối: cùng IDMES · Ngày CT · ngày ca · giờ · chuyền / tổ · ca trưởng / chuyền trưởng /
--   thợ in (theo SF0 lúc in) · SL đạt / hư / thiếu · @pBarcodeIn = tem 15 · @pBarcode17 = tem 17 giao trước ('' nếu không).
-- Cùng IDMES ⇒ proc xóa phiếu cùng Soctcu rồi tạo lại ⇒ chạy lại file, hoặc MES tự gửi lại khi đường truyền thông, đều
--   KHÔNG đẻ phiếu trùng. Lượt có CẢNH BÁO: ${canhBao}.
-- Ghi thẳng bên ERP ⇒ ở MES các lượt này vẫn hiện LỖI trong Cài đặt API › Lịch sử.
--
-- CÁCH CHẠY (SSMS, đúng DB ERP):
--   1. Để nguyên @chay_that = 0 → F5: chỉ ĐẾM (bảng kết quả cuối: se_chay = ${tong}). Proc thiếu tham số ⇒ tab Messages báo ✗.
--   2. Đổi @chay_that = 1 → F5: chạy thật. Bảng cuối: ok · canh_bao · loi. Dòng lỗi không làm dừng file (mỗi EXEC bọc
--      TRY/CATCH) — gửi tab Messages cho bên MES nếu loi > 0.
--
-- BỎ QUA:
${bq}
-- =============================================================================
SET NOCOUNT ON;
DECLARE @chay_that bit = 0;   -- ← ĐỔI THÀNH 1 ĐỂ CHẠY THẬT
DECLARE @rv int, @ok int = 0, @canh_bao int = 0, @loi int = 0, @dem int = 0;
${kiemProc()}
`;
  fs.mkdirSync(RA, { recursive: true });
  const vn = vnBayGio();
  const f = path.join(RA, `sh6_gui_lai_${vn.slice(5, 10).replace('-', '')}_${vn.slice(11, 16).replace(':', '')}.sql`);
  fs.writeFileSync(f, `﻿${noiDung}${khoi.join('\n')}${cuoiFile(tong)}`, 'utf8'); // BOM ⇒ SSMS đọc đúng tiếng Việt
  console.log(`[sh6-gui-lai] ✓ ${tong} EXEC · cảnh báo ${canhBao} · bỏ qua ${boQua.length} ⇒ ${f}`);
  boQua.forEach((x) => console.log(`   bỏ qua: ${x}`));
}

main()
  .catch((e) => { console.error(`[sh6-gui-lai] ✗ ${e.message}`); process.exitCode = 1; })
  .finally(() => pool.end().catch(() => {}));
