'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SINH SCRIPT SQL SERVER HỦY PHIẾU SK6 CỦA TEM 17 "GIAO TRƯỚC" (tem 17 tách từ lượt KCS — 19/11/2026, người dùng yêu cầu:
//   "thêm script để xóa các tem giao trước 17 đã gửi SK6").
// Luật mới: tem 17 của lượt KCS báo ERP bằng phiếu Sh6 (mã tem 17), KHÔNG SK6 ⇒ mọi phiếu SK6 MES từng gửi cho tem 17 của
//   lượt KCS (Lịch sử `ERP_GUI_SUA_DAT`, `id_ban_ghi` = lượt KCS) phải hủy bên ERP.
// Hủy = `dbo.MES_spr_MES2SF0_Huy(@pIDMES, @pNgayHuy, @pNguoiHuy, @pLydohuy)` — cùng proc MES gọi khi hủy chứng từ
//   (`utils/erpHuy`), proc dùng chung mọi loại chứng từ theo IDMES. Không có proc "xóa" — ERP giữ phiếu đã hủy làm vết.
// File: xem trước (đối chiếu SX_PhieuChuyenGiao còn hiệu lực theo soctcu = IDMES) → gọi → đọc lại ERP + bảng SOÁT.
// ⚠ THỨ TỰ: chạy file Sh6 (`taoSqlServerSh6Tem17Kcs.js`) TRƯỚC — hủy SK6 trước khi Sh6 đổi sang tem 17 thì ERP tạm mất số
//   lượng tem 17. File Sh6 tự hủy SK6 khi Sh6 thành công ⇒ chạy file này sau đó chỉ dọn phần còn sót (ERP check bỏ qua
//   IDMES đã hủy).
// ⚠ CHỈ ĐỌC DB MES. Ghi thẳng bên ERP ⇒ không có dòng Lịch sử API ở MES.
//
// CÁCH CHẠY (thư mục backend):  node src/scripts/taoSqlServerHuySk6Tem17Kcs.js
//   ⇒ `database/scripts/sqlserver/huy_sk6_tem17_kcs_MMDD_HHmm.sql`.
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { query, pool } = require('../config/db');
const { tChuoi, tSo } = require('./taoSqlServerGuiLai');

const RA = path.resolve(__dirname, '../../../database/scripts/sqlserver');
const LY_DO = 'Bỏ SK6 tem 17 KCS'; // ≤ 20 ký tự (@pLydohuy nvarchar(20))

const SQL = `
  WITH s AS (
    SELECT a.id_ban_ghi AS kcs_id, COALESCE(a.gia_tri_moi->'gui'->>'IDMES', a.gia_tri_moi->>'id_mes') AS idm,
           a.gia_tri_moi->'gui'->>'BarcodeIn' AS ma17_gui, a.thoi_gian
      FROM audit_log a JOIN kcs k ON k.id::text = a.id_ban_ghi
     WHERE a.ten_bang = 'sua' AND a.hanh_dong = 'ERP_GUI_SUA_DAT'),
  d AS (SELECT kcs_id, idm, max(ma17_gui) AS ma17_gui, min(thoi_gian) AS tg_gui FROM s
         WHERE idm ~ '^[0-9]{6,10}$' GROUP BY kcs_id, idm)
  SELECT d.idm, d.ma17_gui, d.tg_gui, t15.ma_tem AS ma15, k.created_date AS tg_kcs,
         EXISTS (SELECT 1 FROM audit_log h WHERE h.hanh_dong = 'ERP_GUI_HUY_IDMES'
                  AND COALESCE(h.gia_tri_moi->'gui'->>'IDMES', h.gia_tri_moi->>'id_mes') = d.idm) AS da_bao_huy,
         EXISTS (SELECT 1 FROM audit_log h WHERE h.ten_bang = 'kcs' AND h.id_ban_ghi = d.kcs_id
                  AND h.hanh_dong = 'HUY_XAC_NHAN') AS luot_huy,
         (SELECT t.trang_thai FROM tem t WHERE t.kcs_tach_id::text = d.kcs_id ORDER BY t.created_date DESC LIMIT 1) AS tt17,
         (SELECT a.gia_tri_moi->'gui'->>'BarcodeIn' FROM audit_log a WHERE a.ten_bang = 'kcs' AND a.id_ban_ghi = d.kcs_id
            AND a.hanh_dong = 'ERP_GUI_KIEM_PHAM' ORDER BY a.thoi_gian DESC LIMIT 1) AS sh6_ma,
         (SELECT a.gia_tri_moi->>'id_mes' FROM audit_log a WHERE a.ten_bang = 'kcs' AND a.id_ban_ghi = d.kcs_id
            AND a.hanh_dong = 'ERP_GUI_KIEM_PHAM' ORDER BY a.thoi_gian DESC LIMIT 1) AS sh6_idm
    FROM d JOIN kcs k ON k.id::text = d.kcs_id JOIN tem t15 ON t15.id = k.tem_id
   ORDER BY k.created_date, d.idm`;

const vnGio = (d) => new Date(new Date(d).getTime() + 7 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');

async function main() {
  const { rows: db } = await query('SELECT current_database() AS d, inet_server_addr()::text AS h');
  console.log(`[huy-sk6] Đọc DB ${db[0].d} @ ${db[0].h || 'local'} (chỉ SELECT)`);
  const { rows } = await query(SQL.replace(/\s+/g, ' '));

  const dong = rows.map((r, i) => {
    const nhom = r.da_bao_huy ? 'DA_BAO_HUY' : 'CON_HIEU_LUC';
    const tinhTrang = [
      r.luot_huy ? 'lượt KCS đã hủy xác nhận' : null,
      r.tt17 === 'HUY' ? 'tem 17 đã hủy' : null,
      r.da_bao_huy ? 'MES đã báo hủy IDMES này' : null,
      !r.luot_huy && r.sh6_ma ? `Sh6 ${r.sh6_idm} hiện mang ${r.sh6_ma === r.ma17_gui ? 'tem 17' : 'tem 15'}` : null,
    ].filter(Boolean).join(' · ');
    const ghiChu = `tem ${r.ma15} → ${r.ma17_gui || '?'} · KCS ${vnGio(r.tg_kcs)} · SK6 gửi ${vnGio(r.tg_gui)}${tinhTrang ? ` · ${tinhTrang}` : ''}`;
    return `  (${String(i + 1).padStart(2)}, N'${nhom}', ${r.da_bao_huy ? 1 : 0}, ${tSo(r.idm)}, ${tChuoi(r.ma17_gui || '')}, ${tChuoi(ghiChu.slice(0, 300))})`;
  });
  const soCon = rows.filter((r) => !r.da_bao_huy).length;

  const noiDung = `/* =============================================================================================
   HỦY PHIẾU SK6 CỦA TEM 17 "GIAO TRƯỚC" (tem 17 tách từ lượt KCS) — proc dbo.MES_spr_MES2SF0_Huy
   (@pIDMES int, @pNgayHuy datetime, @pNguoiHuy nvarchar(20), @pLydohuy nvarchar(20))
   Sinh lúc ${new Date().toISOString()} từ DB MES bằng backend/src/scripts/taoSqlServerHuySk6Tem17Kcs.js — CHẠY TRÊN DB ERP.
   ---------------------------------------------------------------------------------------------
   VÌ SAO: từ 19/11/2026 tem 17 của lượt KCS kiểm trước (giao trước) báo ERP bằng phiếu Sh6 mang mã tem 17, KHÔNG gửi SK6.
   ${rows.length} phiếu SK6 MES từng gửi thành công cho tem 17 loại này:
     · ${soCon} còn hiệu lực theo MES (nhóm CON_HIEU_LUC) ⇒ SẼ GỌI hủy.
     · ${rows.length - soCon} MES đã tự báo hủy lúc hủy xác nhận KCS (nhóm DA_BAO_HUY) ⇒ mặc định bỏ qua (@GOI_CA_DA_BAO_HUY = 1 để gọi lại).
   ---------------------------------------------------------------------------------------------
   ⚠ THỨ TỰ: chạy file sh6_tem17_kcs_*.sql TRƯỚC (Sh6 đổi sang tem 17). Hủy SK6 trước ⇒ ERP tạm mất số lượng tem 17 cho tới
     khi chạy file Sh6. File Sh6 tự hủy SK6 khi Sh6 thành công ⇒ chạy file này sau đó chỉ dọn phần còn sót (IDMES nào ERP
     không còn phiếu hiệu lực thì bỏ qua). Chạy lại lần nữa vô hại.
   ---------------------------------------------------------------------------------------------
   CÁCH CHẠY (SSMS, đúng database ERP có proc dbo.MES_spr_MES2SF0_Huy):
     1. @CHAY_THAT = 0 (mặc định) ⇒ KHÔNG ghi gì. Xem: tóm tắt · từng IDMES (ERP còn phiếu hiệu lực? SẼ GỌI / bỏ qua).
        Script đọc SX_PhieuChuyenGiao (soctcu = IDMES, ngayhuy IS NULL) — đọc không được ⇒ báo lý do và gọi mọi IDMES.
     2. (nên làm) @CHAY_THAT = 1, @CHI_STT = 1 ⇒ gọi thử ĐÚNG 1 IDMES rồi xem phiếu SK6 bên ERP đã hủy chưa.
     3. @CHAY_THAT = 1, @CHI_STT = NULL ⇒ gọi mọi IDMES "SẼ GỌI"; mỗi lần TRY/CATCH riêng.
        Xong hiện: tóm tắt · kết quả từng IDMES · SOÁT ERP (phiếu còn hiệu lực của IDMES đã gọi — phải RỖNG).
   Tương thích SQL Server 2008 R2.
   ============================================================================================= */
SET NOCOUNT ON;

DECLARE @CHAY_THAT bit = 0;                 -- 0 = chỉ xem · 1 = GỌI PROC THẬT
DECLARE @KIEM_ERP bit = 1;                  -- 1 = chỉ gọi IDMES mà ERP còn phiếu hiệu lực · 0 = gọi mọi IDMES
DECLARE @GOI_CA_KHI_ERP_KHONG_CO bit = 0;   -- 1 = gọi cả IDMES mà ERP không còn phiếu hiệu lực
DECLARE @GOI_CA_DA_BAO_HUY bit = 0;         -- 1 = gọi cả nhóm DA_BAO_HUY
DECLARE @CHI_STT int = NULL;                -- NULL = theo các công tắc trên · số = chỉ gọi đúng IDMES có stt đó
DECLARE @NGAY_HUY datetime = GETDATE();
DECLARE @NGUOI_HUY nvarchar(20) = N'MES';
DECLARE @LY_DO nvarchar(20) = ${tChuoi(LY_DO)};

IF OBJECT_ID(N'dbo.MES_spr_MES2SF0_Huy', N'P') IS NULL
BEGIN
  RAISERROR(N'Không thấy dbo.MES_spr_MES2SF0_Huy trong database đang chọn — chọn đúng database ERP rồi chạy lại.', 16, 1);
  RETURN;
END;

IF OBJECT_ID(N'tempdb..#ds') IS NOT NULL DROP TABLE #ds;
IF OBJECT_ID(N'tempdb..#erp') IS NOT NULL DROP TABLE #erp;
IF OBJECT_ID(N'tempdb..#qd') IS NOT NULL DROP TABLE #qd;
IF OBJECT_ID(N'tempdb..#kq') IS NOT NULL DROP TABLE #kq;

CREATE TABLE #ds (
  stt int PRIMARY KEY, nhom nvarchar(30) COLLATE DATABASE_DEFAULT, da_bao_huy bit NOT NULL, IDMES int NOT NULL,
  ma_tem_17 nvarchar(40) COLLATE DATABASE_DEFAULT, ghi_chu nvarchar(300) COLLATE DATABASE_DEFAULT
);
${dong.length ? `INSERT INTO #ds (stt, nhom, da_bao_huy, IDMES, ma_tem_17, ghi_chu) VALUES\n${dong.join(',\n')};` : '-- (không có phiếu SK6 nào)'}

-- ── PHIẾU BÊN ERP còn hiệu lực của từng IDMES (soctcu = IDMES, ngayhuy IS NULL) ─────────────────────────────────────
CREATE TABLE #erp (IDMES int PRIMARY KEY, so_phieu int, id_phieu nvarchar(400) COLLATE DATABASE_DEFAULT NULL);
DECLARE @erp_doc_duoc bit, @erp_loi nvarchar(2000), @sql_erp nvarchar(max);
SET @erp_doc_duoc = 0;
SET @sql_erp = N'
  INSERT INTO #erp (IDMES, so_phieu, id_phieu)
  SELECT d.IDMES, COUNT(DISTINCT m.id), MAX(CAST(m.id AS nvarchar(200)))
    FROM SX_PhieuChuyenGiao m
    INNER JOIN #ds d ON CAST(m.soctcu AS nvarchar(50)) COLLATE DATABASE_DEFAULT = CAST(d.IDMES AS nvarchar(50)) COLLATE DATABASE_DEFAULT
   WHERE m.ngayhuy IS NULL
   GROUP BY d.IDMES;';
IF @KIEM_ERP = 1
BEGIN
  BEGIN TRY
    EXEC sp_executesql @sql_erp;
    SET @erp_doc_duoc = 1;
  END TRY
  BEGIN CATCH
    SET @erp_loi = ERROR_MESSAGE();
    DELETE FROM #erp;
  END CATCH;
END;

-- ── QUYẾT ĐỊNH từng IDMES ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE #qd (stt int PRIMARY KEY, goi bit NOT NULL, tinh_trang nvarchar(200) COLLATE DATABASE_DEFAULT);
INSERT INTO #qd (stt, goi, tinh_trang)
SELECT d.stt,
       CASE WHEN @CHI_STT IS NOT NULL THEN CASE WHEN d.stt = @CHI_STT THEN 1 ELSE 0 END
            WHEN d.da_bao_huy = 1 AND @GOI_CA_DA_BAO_HUY = 0 THEN 0
            WHEN @erp_doc_duoc = 0 THEN 1
            WHEN e.IDMES IS NULL THEN @GOI_CA_KHI_ERP_KHONG_CO
            ELSE 1 END,
       CASE WHEN d.da_bao_huy = 1 AND @GOI_CA_DA_BAO_HUY = 0 THEN N'MES đã báo hủy — đang tắt (@GOI_CA_DA_BAO_HUY = 0)'
            WHEN @erp_doc_duoc = 0 THEN N'chưa đối chiếu được với ERP'
            WHEN e.IDMES IS NULL THEN N'ERP KHÔNG còn phiếu hiệu lực của IDMES này (đã hủy / chưa từng có)'
            ELSE N'ERP CÒN phiếu hiệu lực' END
         + CASE WHEN e.so_phieu > 1 THEN N' · ⚠ ' + CAST(e.so_phieu AS nvarchar(10)) + N' phiếu cùng IDMES' ELSE N'' END
  FROM #ds d LEFT JOIN #erp e ON e.IDMES = d.IDMES;

IF @CHAY_THAT = 0
BEGIN
  SELECT N'XEM TRƯỚC — chưa gọi proc (đặt @CHAY_THAT = 1 để chạy)' AS che_do,
         (SELECT COUNT(*) FROM #ds) AS tong_idmes, (SELECT COUNT(*) FROM #qd WHERE goi = 1) AS so_idmes_se_goi,
         CASE WHEN @KIEM_ERP = 0 THEN N'KHÔNG đối chiếu ERP (@KIEM_ERP = 0) — gọi mọi IDMES'
              WHEN @erp_doc_duoc = 1 THEN N'đã đọc phiếu bên ERP (SX_PhieuChuyenGiao)'
              ELSE N'KHÔNG đọc được phiếu ERP ⇒ gọi mọi IDMES. Lỗi: ' + ISNULL(@erp_loi, N'?') END AS doi_chieu_erp;
  SELECT d.stt, CASE WHEN q.goi = 1 THEN N'SẼ GỌI' ELSE N'bỏ qua' END AS trang_thai, q.tinh_trang,
         d.nhom, d.IDMES, d.ma_tem_17, e.id_phieu AS erp_id_phieu, d.ghi_chu
    FROM #ds d JOIN #qd q ON q.stt = d.stt LEFT JOIN #erp e ON e.IDMES = d.IDMES ORDER BY d.stt;
  RETURN;
END;

CREATE TABLE #kq (stt int PRIMARY KEY, ok bit, return_value int NULL, loi nvarchar(4000) COLLATE DATABASE_DEFAULT NULL);
DECLARE @stt int, @IDMES int, @rv int;

DECLARE c CURSOR LOCAL STATIC FORWARD_ONLY FOR
  SELECT d.stt, d.IDMES FROM #ds d JOIN #qd q ON q.stt = d.stt WHERE q.goi = 1 ORDER BY d.stt;
OPEN c;
FETCH NEXT FROM c INTO @stt, @IDMES;
WHILE @@FETCH_STATUS = 0
BEGIN
  BEGIN TRY
    SET @rv = NULL;
    EXEC @rv = dbo.MES_spr_MES2SF0_Huy @pIDMES = @IDMES, @pNgayHuy = @NGAY_HUY, @pNguoiHuy = @NGUOI_HUY, @pLydohuy = @LY_DO;
    INSERT INTO #kq (stt, ok, return_value, loi) VALUES (@stt, 1, @rv, NULL);
  END TRY
  BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    INSERT INTO #kq (stt, ok, return_value, loi) VALUES (@stt, 0, NULL, ERROR_MESSAGE());
  END CATCH;
  FETCH NEXT FROM c INTO @stt, @IDMES;
END;
CLOSE c;
DEALLOCATE c;

-- Đọc lại ERP SAU khi gọi.
DELETE FROM #erp;
SET @erp_doc_duoc = 0;
SET @erp_loi = NULL;
BEGIN TRY
  EXEC sp_executesql @sql_erp;
  SET @erp_doc_duoc = 1;
END TRY
BEGIN CATCH
  SET @erp_loi = ERROR_MESSAGE();
  DELETE FROM #erp;
END CATCH;

SELECT N'ĐÃ CHẠY' AS che_do, COUNT(*) AS so_idmes_goi,
       ISNULL(SUM(CASE WHEN ok = 1 AND ISNULL(return_value, 0) = 0 THEN 1 ELSE 0 END), 0) AS thanh_cong,
       ISNULL(SUM(CASE WHEN ok = 1 AND ISNULL(return_value, 0) <> 0 THEN 1 ELSE 0 END), 0) AS proc_tra_ma_khac_0,
       ISNULL(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS loi,
       CASE WHEN @erp_doc_duoc = 1
            THEN CAST((SELECT COUNT(*) FROM #kq k JOIN #ds d ON d.stt = k.stt JOIN #erp e ON e.IDMES = d.IDMES) AS nvarchar(10))
            ELSE N'không đọc được ERP: ' + ISNULL(@erp_loi, N'?') END AS idmes_da_goi_ma_erp_van_con_phieu
  FROM #kq;
SELECT d.stt, CASE WHEN k.stt IS NULL THEN N'không gọi — ' + q.tinh_trang WHEN k.ok = 0 THEN N'LỖI'
                   WHEN ISNULL(k.return_value, 0) <> 0 THEN N'proc trả mã khác 0' ELSE N'đã gọi' END AS ket_qua,
       k.return_value, k.loi, d.nhom, d.IDMES, d.ma_tem_17,
       CASE WHEN @erp_doc_duoc = 0 THEN N'?' WHEN e.IDMES IS NULL THEN N'ERP không còn phiếu hiệu lực' ELSE N'ERP VẪN CÒN phiếu ' + ISNULL(e.id_phieu, N'') END AS erp_sau,
       d.ghi_chu
  FROM #ds d JOIN #qd q ON q.stt = d.stt LEFT JOIN #kq k ON k.stt = d.stt LEFT JOIN #erp e ON e.IDMES = d.IDMES ORDER BY d.stt;
-- SOÁT: IDMES ĐÃ GỌI mà ERP vẫn còn phiếu hiệu lực (phải RỖNG).
SELECT N'SOÁT ERP SAU KHI CHẠY — phải RỖNG' AS bang, d.stt, d.IDMES, d.ma_tem_17, e.id_phieu, e.so_phieu
  FROM #kq k JOIN #ds d ON d.stt = k.stt JOIN #erp e ON e.IDMES = d.IDMES ORDER BY d.stt;
`;
  fs.mkdirSync(RA, { recursive: true });
  const vn = new Date(Date.now() + 7 * 3600e3).toISOString();
  const f = path.join(RA, `huy_sk6_tem17_kcs_${vn.slice(5, 10).replace('-', '')}_${vn.slice(11, 16).replace(':', '')}.sql`);
  fs.writeFileSync(f, `﻿${noiDung}`, 'utf8'); // BOM ⇒ SSMS đọc đúng tiếng Việt
  console.log(`[huy-sk6] ✓ ${rows.length} IDMES SK6 (còn hiệu lực theo MES ${soCon}) ⇒ ${f}`);
}

main()
  .catch((e) => { console.error(`[huy-sk6] ✗ ${e.message}`); process.exitCode = 1; })
  .finally(() => pool.end().catch(() => {}));
