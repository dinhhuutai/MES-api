'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SỬA 1 LẦN (17/11/2026) — TEM BỔ SUNG IN 13/11 → 16/11 BỊ MẤT SL BỔ SUNG CÔNG TY / KHÁCH.
//   Luồng in tem CŨ tạo tem + dựng thân SF0 TRƯỚC, 0–12 giây SAU mới lưu SL bổ sung của ĐỢT ⇒ SF0 gửi 0, mig 135 chép 0
//   sang tem ⇒ tem trống (vd 152608084368 · LSX13119 · đợt RD026LA-007742 · 197 công ty). Luồng mới (nhập theo tem) đã đúng.
//
// Phạm vi: lệnh có đợt BO_SUNG mang SL bổ sung > 0 · lệnh có ĐÚNG 1 tem 15 sống · tem đó chưa có số bổ sung ·
//   tem in 13/11 00:00 → 17/11 00:00 (giờ VN) · Σ bổ sung ≤ SL tem · lần SF0 thành công gần nhất gửi 0.
//
// Sinh 2 file (CHỈ ĐỌC DB MES — SELECT, không ghi gì, không gọi ERP):
//   · database/scripts/bo_sung_tem_tu_dot_1711.sql            ← pgAdmin (F5 cả file): ghi tem.sl_bo_sung_* + audit SUA_TEM
//   · database/scripts/sqlserver/sf0_bo_sung_tem_tu_dot_1711.sql ← SSMS trên DB ERP: gọi lại MES_spr_MES2SF0 cùng IDMES,
//     thân = ĐÚNG thân SF0 thành công gần nhất (audit ERP_GHI_IN_TEM), chỉ đổi @pSLBSCty / @pSLBSKhachHang.
//
// CÁCH CHẠY (thư mục backend): node src/scripts/taoBoSungTemTuDot1711.js
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { query, pool } = require('../config/db');
const { tChuoi, thamSoSf0, khoiExec, cuoiFile } = require('./taoSqlServerGuiLai');

const TU = '2026-11-12T17:00:00Z';  // 13/11/2026 00:00 giờ VN
const DEN = '2026-11-16T17:00:00Z'; // 17/11/2026 00:00 giờ VN
const NGUON = 'script_bo_sung_tem_tu_dot_1711';
const GOC = path.resolve(__dirname, '../../../database/scripts');

const SQL_TEM = `
  WITH bs AS (
    SELECT lsd.lenh_san_xuat_id AS lenh_id,
           SUM(COALESCE(d.sl_bo_sung_cty, 0))::int AS cty, SUM(COALESCE(d.sl_bo_sung_khach, 0))::int AS khach,
           string_agg(d.barcode, ', ' ORDER BY d.barcode) AS phieu_ready
      FROM lenh_sx_dot_vai lsd
      JOIN dot_vai_ve d ON d.id = lsd.dot_vai_ve_id
      JOIN loai_dot_vai l ON l.id = d.loai_dot_vai_id AND l.ma_loai = 'BO_SUNG'
     GROUP BY 1
    HAVING SUM(COALESCE(d.sl_bo_sung_cty, 0)) + SUM(COALESCE(d.sl_bo_sung_khach, 0)) > 0),
  song AS (
    SELECT ps.lenh_san_xuat_id AS lenh_id, count(*) AS so_tem,
           SUM(COALESCE(t.sl_bo_sung_cty, 0) + COALESCE(t.sl_bo_sung_khach, 0)) AS bs_tem
      FROM tem t JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
     WHERE t.tem_goc_id IS NULL AND t.trang_thai <> 'HUY' AND t.ma_tem LIKE '15%'
     GROUP BY 1)
  SELECT t.id AS tem_id, t.ma_tem, t.so_luong, ls.ma_lenh_san_xuat, bs.cty, bs.khach, bs.phieu_ready,
         to_char(t.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM HH24:MI') AS in_luc
    FROM bs
    JOIN song ON song.lenh_id = bs.lenh_id AND song.so_tem = 1 AND song.bs_tem = 0
    JOIN lenh_san_xuat ls ON ls.id = bs.lenh_id
    JOIN phieu_san_xuat ps ON ps.lenh_san_xuat_id = ls.id
    JOIN tem t ON t.phieu_san_xuat_id = ps.id AND t.tem_goc_id IS NULL AND t.trang_thai <> 'HUY' AND t.ma_tem LIKE '15%'
   WHERE t.created_date >= $1 AND t.created_date < $2 AND bs.cty + bs.khach <= t.so_luong
   ORDER BY t.created_date, t.ma_tem`;

const SQL_SF0 = `
  SELECT DISTINCT ON (a.id_ban_ghi) a.id_ban_ghi, a.gia_tri_moi
    FROM audit_log a
   WHERE a.ten_bang = 'tem' AND a.hanh_dong = 'ERP_GHI_IN_TEM' AND a.id_ban_ghi = ANY($1::text[])
     AND (a.gia_tri_moi->>'thanh_cong')::boolean IS TRUE
   ORDER BY a.id_ban_ghi, a.thoi_gian DESC`;

const mot = (s) => s.replace(/\s+/g, ' ').trim(); // IPS reset câu nhiều dòng từ máy dev ⇒ gửi 1 dòng
const pad = (v, n) => String(v).padEnd(n);

function filePg(ds) {
  const bang = ds.map((x) => `--   ${pad(x.ma_tem, 13)} ${pad(x.lenh, 9)} SL ${pad(x.so_luong, 4)} cty ${pad(x.cty, 4)} khách ${pad(x.khach, 4)} in ${x.in_luc}`).join('\n');
  const dong = ds.map((x) => `  ('${x.ma_tem}', '${x.tem_id}'::uuid, '${x.lenh}', ${x.cty}, ${x.khach})`).join(',\n');
  return `-- =============================================================================
-- GHI SL BỔ SUNG CÔNG TY / KHÁCH VÀO ${ds.length} TEM BỔ SUNG IN 13/11 → 16/11/2026 (lấy theo số của ĐỢT VẢI bổ sung)
-- Sinh ${new Date().toISOString()} bằng backend/src/scripts/taoBoSungTemTuDot1711.js. Chạy bằng pgAdmin trên DB THLA.
-- -----------------------------------------------------------------------------
-- VÌ SAO: luồng in tem cũ tạo tem rồi 0–12 giây sau mới lưu SL bổ sung của đợt ⇒ phiếu SF0 gửi ERP số 0, mig 135 chép
--   số 0 đó sang tem ⇒ tem trống. Script này ghi số của đợt vào tem (mỗi lệnh chỉ có 1 tem) + 1 dòng audit SUA_TEM / tem
--   (nguon = '${NGUON}'). ERP sửa RIÊNG bằng database/scripts/sqlserver/sf0_bo_sung_tem_tu_dot_1711.sql.
--
-- Tem tự BỎ QUA (không ghi) nếu lúc chạy: tem đã hủy · tem đã có số bổ sung (ai đó đã Sửa tem) · số của đợt đã đổi ·
--   Σ bổ sung > SL tem. Có dòng BỎ QUA ⇒ báo bên MES TRƯỚC khi chạy file SQL Server.
--
-- CÁCH CHẠY: F5 cả file.
--   1. Để nguyên chay_that = false → F5: chỉ ĐẾM, bảng cuối cột trang_thai = SE_GHI / BO_QUA (không ghi gì).
--   2. Sửa false thành true ở dòng INSERT INTO _cfg → F5: ghi thật, bảng cuối trang_thai = DA_GHI.
--   Chạy lại lần 2 vô hại (tem đã có số ⇒ BỎ QUA).
--
--   Tem           Lệnh      SL    Cty  Khách  In lúc
${bang}
-- =============================================================================
ROLLBACK;
DROP TABLE IF EXISTS pg_temp._cfg, pg_temp._ds, pg_temp._ket_qua;
BEGIN;

CREATE TEMP TABLE _cfg (chay_that boolean NOT NULL, nguon text NOT NULL);
INSERT INTO _cfg VALUES (false, '${NGUON}');

CREATE TEMP TABLE _ds (ma_tem text PRIMARY KEY, tem_id uuid NOT NULL, lenh text NOT NULL, cty int NOT NULL, khach int NOT NULL);
INSERT INTO _ds (ma_tem, tem_id, lenh, cty, khach) VALUES
${dong};

CREATE TEMP TABLE _ket_qua AS
SELECT ds.ma_tem, ds.lenh, t.so_luong, ds.cty, ds.khach,
       t.sl_bo_sung_cty AS tem_cty_cu, t.sl_bo_sung_khach AS tem_khach_cu, d.cty AS dot_cty, d.khach AS dot_khach,
       CASE WHEN t.id IS NULL THEN 'BO_QUA: không thấy tem'
            WHEN t.trang_thai = 'HUY' THEN 'BO_QUA: tem đã hủy'
            WHEN COALESCE(t.sl_bo_sung_cty, 0) + COALESCE(t.sl_bo_sung_khach, 0) > 0 THEN 'BO_QUA: tem đã có số bổ sung'
            WHEN d.cty IS DISTINCT FROM ds.cty OR d.khach IS DISTINCT FROM ds.khach THEN 'BO_QUA: số bổ sung của đợt đã đổi'
            WHEN ds.cty + ds.khach > t.so_luong THEN 'BO_QUA: bổ sung lớn hơn SL tem'
            ELSE 'SE_GHI' END::text AS trang_thai
  FROM _ds ds
  LEFT JOIN tem t ON t.id = ds.tem_id
  LEFT JOIN LATERAL (
    SELECT SUM(COALESCE(dv.sl_bo_sung_cty, 0))::int AS cty, SUM(COALESCE(dv.sl_bo_sung_khach, 0))::int AS khach
      FROM phieu_san_xuat ps
      JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ps.lenh_san_xuat_id
      JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
      JOIN loai_dot_vai l ON l.id = dv.loai_dot_vai_id AND l.ma_loai = 'BO_SUNG'
     WHERE ps.id = t.phieu_san_xuat_id) d ON true;

DO $$
DECLARE v_that boolean; v_nguon text; v_se int; v_tem int; v_au int;
BEGIN
  SELECT chay_that, nguon INTO v_that, v_nguon FROM _cfg;
  SELECT count(*) INTO v_se FROM _ket_qua WHERE trang_thai = 'SE_GHI';
  IF v_se > ${ds.length} THEN RAISE EXCEPTION 'Số tem sẽ ghi (%) vượt danh sách ${ds.length} — dừng, không ghi gì', v_se; END IF;
  IF NOT v_that THEN RAISE NOTICE 'ĐẾM THỬ: % tem sẽ ghi (chưa ghi gì)', v_se; RETURN; END IF;

  UPDATE tem t SET sl_bo_sung_cty = NULLIF(k.cty, 0), sl_bo_sung_khach = NULLIF(k.khach, 0), updated_date = CURRENT_TIMESTAMP
    FROM _ds ds JOIN _ket_qua k ON k.ma_tem = ds.ma_tem
   WHERE t.id = ds.tem_id AND k.trang_thai = 'SE_GHI';
  GET DIAGNOSTICS v_tem = ROW_COUNT;

  INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_cu, gia_tri_moi, thoi_gian)
  SELECT 'tem', ds.tem_id::text, 'SUA_TEM',
         jsonb_build_object('sl_bo_sung_cty', k.tem_cty_cu, 'sl_bo_sung_khach', k.tem_khach_cu),
         jsonb_build_object('ma_tem', ds.ma_tem,
           'ly_do', 'Chép SL bổ sung của đợt vải sang tem — luồng in tem cũ lưu số bổ sung SAU khi tạo tem nên phiếu SF0 gửi ERP số 0',
           'sl_bo_sung_cty', NULLIF(k.cty, 0), 'sl_bo_sung_khach', NULLIF(k.khach, 0), 'nguon', v_nguon,
           'erp', 'gửi lại bằng database/scripts/sqlserver/sf0_bo_sung_tem_tu_dot_1711.sql'),
         CURRENT_TIMESTAMP
    FROM _ds ds JOIN _ket_qua k ON k.ma_tem = ds.ma_tem
   WHERE k.trang_thai = 'SE_GHI';
  GET DIAGNOSTICS v_au = ROW_COUNT;

  IF v_tem <> v_se OR v_au <> v_se THEN
    RAISE EXCEPTION 'Lệch số: sẽ ghi % tem nhưng sửa % tem, % dòng audit — dừng, không ghi gì', v_se, v_tem, v_au;
  END IF;
  UPDATE _ket_qua SET trang_thai = 'DA_GHI' WHERE trang_thai = 'SE_GHI';
  RAISE NOTICE 'ĐÃ GHI % tem', v_tem;
END $$;

COMMIT;

SELECT trang_thai, ma_tem, lenh, so_luong, cty, khach, tem_cty_cu, tem_khach_cu FROM _ket_qua ORDER BY trang_thai, ma_tem;
`;
}

function fileSqlServer(viec, boQua) {
  const bq = boQua.length ? boQua.map((x) => `--   · ${x}`).join('\n') : '--   (không có)';
  const tongCty = viec.reduce((s, v) => s + v.cty, 0);
  const tongKhach = viec.reduce((s, v) => s + v.khach, 0);
  const khoi = viec.map((v) => `-- ${v.ma_tem} · lệnh ${v.lenh} · in ${v.in_luc} · SL ${v.so_luong} · SLBSCty 0 → ${v.cty} · SLBSKhachHang 0 → ${v.khach}\n`
    + khoiExec('MES_spr_MES2SF0', `${v.ma_tem} (IDMES ${v.idMes})`, thamSoSf0(v.than)));
  return `-- =============================================================================
-- GHI LẠI SF0 (MES_spr_MES2SF0) — SL BỔ SUNG CÔNG TY / KHÁCH CỦA ${viec.length} TEM BỔ SUNG IN 13/11 → 16/11/2026
-- Sinh ${new Date().toISOString()} bằng backend/src/scripts/taoBoSungTemTuDot1711.js — CHẠY TRÊN DB ERP (SQL Server, SSMS).
-- -----------------------------------------------------------------------------
-- VÌ SAO: luồng in tem cũ dựng phiếu SF0 TRƯỚC khi lưu SL bổ sung của đợt ⇒ ERP nhận @pSLBSCty = 0 / @pSLBSKhachHang = 0.
--   Mỗi dòng gọi lại proc với ĐÚNG IDMES cũ và ĐÚNG thân SF0 thành công gần nhất (audit ERP_GHI_IN_TEM ở MES) — chỉ đổi 2 số
--   bổ sung thành số của đợt vải bổ sung (mỗi lệnh 1 tem; Σ ≤ SL tem). Tổng: Σ SLBSCty ${tongCty} · Σ SLBSKhachHang ${tongKhach}.
--   Bên MES ghi cùng số bằng database/scripts/bo_sung_tem_tu_dot_1711.sql (pgAdmin) — chạy file đó TRƯỚC; có dòng BỎ QUA
--   thì báo bên MES trước khi chạy file này.
-- Proc ghi đè phiếu cùng Soctcu = IDMES (không đẻ phiếu mới). Chạy lại lần 2 vô hại. Ghi thẳng bên ERP ⇒ KHÔNG có dòng
--   Lịch sử API ở MES.
--
-- CÁCH CHẠY (SSMS, đúng DB ERP có proc dbo.MES_spr_MES2SF0):
--   1. Để nguyên @chay_that = 0 → F5: chỉ ĐẾM (bảng kết quả cuối: se_chay = ${viec.length}).
--   2. Đổi @chay_that = 1 → F5: chạy thật. Tab Messages liệt kê dòng lỗi / cảnh báo; bảng cuối: ok · canh_bao · loi.
--
-- BỎ QUA (không đủ điều kiện ghi lại):
${bq}
-- =============================================================================
SET NOCOUNT ON;
DECLARE @chay_that bit = 0;   -- ← ĐỔI THÀNH 1 ĐỂ CHẠY THẬT
DECLARE @rv int, @ok int = 0, @canh_bao int = 0, @loi int = 0, @dem int = 0;

IF OBJECT_ID(N'dbo.MES_spr_MES2SF0', N'P') IS NULL
BEGIN
  RAISERROR(N'Không thấy dbo.MES_spr_MES2SF0 trong database đang chọn — chọn đúng database ERP rồi chạy lại.', 16, 1);
  RETURN;
END;

${khoi.join('\n\n')}
${cuoiFile(viec.length)}`;
}

async function main() {
  const { rows: db } = await query(mot("SELECT current_database() AS d, inet_server_addr()::text AS h"));
  console.log(`[bo-sung-tem] Đọc DB ${db[0].d} @ ${db[0].h || 'local'} (chỉ SELECT)`);

  const { rows } = await query(mot(SQL_TEM), [TU, DEN]);
  const { rows: au } = rows.length ? await query(mot(SQL_SF0), [rows.map((r) => String(r.tem_id))]) : { rows: [] };
  const mAu = new Map(au.map((a) => [String(a.id_ban_ghi), a.gia_tri_moi || {}]));

  const boQua = []; const viec = [];
  for (const r of rows) {
    const g = mAu.get(String(r.tem_id));
    const cu = g && (g.gui || g.payload);
    const idMes = cu ? Number(cu.IDMES) : NaN;
    const goc = `${r.ma_tem} (lệnh ${r.ma_lenh_san_xuat})`;
    if (!cu || !Number.isFinite(idMes)) { boQua.push(`${goc} — chưa có lần SF0 thành công / thiếu IDMES`); continue; }
    if (String(cu.BarcodeIn) !== String(r.ma_tem)) { boQua.push(`${goc} — thân SF0 mang mã tem khác (${cu.BarcodeIn})`); continue; }
    if ((Number(cu.SLBSCty) || 0) + (Number(cu.SLBSKhachHang) || 0) > 0) { boQua.push(`${goc} — SF0 đã gửi số bổ sung khác 0`); continue; }
    viec.push({
      ma_tem: r.ma_tem, tem_id: r.tem_id, lenh: r.ma_lenh_san_xuat, so_luong: r.so_luong, cty: r.cty, khach: r.khach,
      in_luc: r.in_luc, idMes, than: { ...cu, SLBSCty: r.cty, SLBSKhachHang: r.khach },
    });
  }

  const fPg = path.join(GOC, 'bo_sung_tem_tu_dot_1711.sql');
  const fSs = path.join(GOC, 'sqlserver', 'sf0_bo_sung_tem_tu_dot_1711.sql');
  fs.writeFileSync(fPg, filePg(viec), 'utf8');
  fs.writeFileSync(fSs, `﻿${fileSqlServer(viec, boQua)}`, 'utf8'); // BOM ⇒ SSMS đọc đúng tiếng Việt
  console.log(`[bo-sung-tem] ${rows.length} tem đủ điều kiện · ${viec.length} đưa vào script · bỏ qua ${boQua.length}`);
  boQua.forEach((x) => console.log(`  bỏ qua: ${x}`));
  console.log(`[bo-sung-tem] Σ cty ${viec.reduce((s, v) => s + v.cty, 0)} · Σ khách ${viec.reduce((s, v) => s + v.khach, 0)}`);
  console.log(`[bo-sung-tem] ✓ ${fPg}\n[bo-sung-tem] ✓ ${fSs}`);
}

main()
  .catch((e) => { console.error(`[bo-sung-tem] ✗ ${e.message}`); process.exitCode = 1; })
  .finally(() => pool.end().catch(() => {}));
