'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SỬA 1 LẦN (18/11/2026) — PHẦN SÓT CỦA `taoBoSungTemTuDot1711.js`: TEM BỔ SUNG IN 13/11 → 16/11 CỦA LỆNH NHIỀU TEM.
//   Cùng lỗi luồng in tem cũ (tạo tem + dựng SF0 TRƯỚC, 0–12 giây SAU mới lưu SL bổ sung của đợt ⇒ SF0 gửi 0, tem trống),
//   nhưng script 17/11 chỉ lấy lệnh có ĐÚNG 1 tem ⇒ bỏ sót lệnh mà đợt BỔ SUNG được gom vào lệnh cũ đã in tem đợt thường
//   (vd LSX10679 · 5A5B: tem 29/10 cho đợt thường 1080, tem 152608084374 16/11 cho đợt bổ sung 106 công ty — khu A báo thiếu 106).
//
// Gán đợt → tem: đợt BO_SUNG mang SL bổ sung > 0 vào lệnh (lenh_sx_dot_vai.created_date) SAU tem trước đó của lệnh và
//   KHÔNG MUỘN HƠN tem này ⇒ số của đợt thuộc tem này (luồng cũ: tem đầu sau khi đợt vào lệnh mang Σ đợt).
// Phạm vi: tem 15 sống in 13/11 00:00 → 17/11 00:00 (giờ VN) · lệnh ≥ 2 tem 15 sống · tem chưa có số bổ sung · Σ ≤ SL tem ·
//   SF0 thành công gần nhất gửi 0 · không tem nào khác của lệnh đang mang số bổ sung (có ⇒ BỎ QUA, xem tay) ·
//   SF0 lúc in gửi ĐÚNG phiếu ready của đợt bổ sung + inbosung 1 (khác ⇒ tem in cho đợt thường ⇒ BỎ QUA, xem tay).
//
// Sinh 2 file (CHỈ ĐỌC DB MES — SELECT, không ghi gì, không gọi ERP):
//   · database/scripts/bo_sung_tem_nhieu_tem_1811.sql            ← pgAdmin (F5 cả file): ghi tem.sl_bo_sung_* + audit SUA_TEM
//   · database/scripts/sqlserver/sf0_bo_sung_tem_nhieu_tem_1811.sql ← SSMS trên DB ERP: gọi lại MES_spr_MES2SF0 cùng IDMES,
//     thân = ĐÚNG thân SF0 thành công gần nhất (audit ERP_GHI_IN_TEM), chỉ đổi @pSLBSCty / @pSLBSKhachHang.
//
// CÁCH CHẠY (thư mục backend): node src/scripts/taoBoSungTemNhieuTem1811.js
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { query, pool } = require('../config/db');
const { thamSoSf0, khoiExec, cuoiFile } = require('./taoSqlServerGuiLai');
const { chuanMaChuyenSql } = require('../utils/maChuyen');

const TU = '2026-11-12T17:00:00Z';  // 13/11/2026 00:00 giờ VN
const DEN = '2026-11-16T17:00:00Z'; // 17/11/2026 00:00 giờ VN
const NGUON = 'script_bo_sung_tem_nhieu_tem_1811';
const GOC = path.resolve(__dirname, '../../../database/scripts');

const SQL_TEM = `
  WITH tm AS (
    SELECT t.id, t.ma_tem, t.so_luong, t.created_date, ps.lenh_san_xuat_id AS lenh_id,
           ${chuanMaChuyenSql('cs.ma_chuyen')} AS chuyen,
           lag(t.created_date) OVER (PARTITION BY ps.lenh_san_xuat_id ORDER BY t.created_date) AS tem_truoc,
           count(*) OVER (PARTITION BY ps.lenh_san_xuat_id) AS so_tem,
           COALESCE(t.sl_bo_sung_cty, 0) + COALESCE(t.sl_bo_sung_khach, 0) AS bs_tem,
           SUM(COALESCE(t.sl_bo_sung_cty, 0) + COALESCE(t.sl_bo_sung_khach, 0)) OVER (PARTITION BY ps.lenh_san_xuat_id) AS bs_lenh
      FROM tem t
      JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
      JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
      LEFT JOIN chuyen_san_xuat cs ON cs.id = COALESCE(t.chuyen_id, ps.chuyen_id, ls.chuyen_id)
     WHERE t.tem_goc_id IS NULL AND t.trang_thai <> 'HUY' AND t.ma_tem LIKE '15%' AND ls.trang_thai <> 'HUY')
  SELECT tm.id AS tem_id, tm.ma_tem, tm.so_luong, tm.chuyen, tm.so_tem::int AS so_tem, (tm.bs_lenh - tm.bs_tem)::int AS bs_tem_khac,
         ls.ma_lenh_san_xuat,
         SUM(COALESCE(d.sl_bo_sung_cty, 0))::int AS cty, SUM(COALESCE(d.sl_bo_sung_khach, 0))::int AS khach,
         array_agg(d.id ORDER BY d.ma_dot_vai) AS dot_ids,
         string_agg(DISTINCT d.barcode, ', ') AS phieu_ready,
         to_char(tm.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM HH24:MI') AS in_luc
    FROM tm
    JOIN lenh_san_xuat ls ON ls.id = tm.lenh_id
    JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = tm.lenh_id
    JOIN dot_vai_ve d ON d.id = lsd.dot_vai_ve_id
    JOIN loai_dot_vai l ON l.id = d.loai_dot_vai_id AND l.ma_loai = 'BO_SUNG'
   WHERE tm.so_tem > 1 AND tm.bs_tem = 0 AND tm.created_date >= $1 AND tm.created_date < $2
     AND COALESCE(d.sl_bo_sung_cty, 0) + COALESCE(d.sl_bo_sung_khach, 0) > 0
     AND lsd.created_date > COALESCE(tm.tem_truoc, '-infinity') AND lsd.created_date <= tm.created_date
   GROUP BY tm.id, tm.ma_tem, tm.so_luong, tm.chuyen, tm.so_tem, tm.bs_lenh, tm.bs_tem, ls.ma_lenh_san_xuat, tm.created_date
   ORDER BY tm.created_date, tm.ma_tem`;

const SQL_SF0 = `
  SELECT DISTINCT ON (a.id_ban_ghi) a.id_ban_ghi, a.gia_tri_moi
    FROM audit_log a
   WHERE a.ten_bang = 'tem' AND a.hanh_dong = 'ERP_GHI_IN_TEM' AND a.id_ban_ghi = ANY($1::text[])
     AND (a.gia_tri_moi->>'thanh_cong')::boolean IS TRUE
   ORDER BY a.id_ban_ghi, a.thoi_gian DESC`;

const mot = (s) => s.replace(/\s+/g, ' ').trim(); // IPS reset câu nhiều dòng từ máy dev ⇒ gửi 1 dòng
const pad = (v, n) => String(v).padEnd(n);

function filePg(ds) {
  const bang = ds.map((x) => `--   ${pad(x.ma_tem, 13)} ${pad(x.lenh, 9)} ${pad(x.chuyen, 5)} SL ${pad(x.so_luong, 4)} cty ${pad(x.cty, 4)} khách ${pad(x.khach, 3)} in ${x.in_luc} · phiếu ready ${x.phieu_ready}`).join('\n');
  const dong = ds.map((x) => `  ('${x.ma_tem}', '${x.tem_id}'::uuid, '${x.lenh}', ${x.cty}, ${x.khach}, ARRAY[${x.dot_ids.map((d) => `'${d}'`).join(', ')}]::uuid[])`).join(',\n');
  const tCty = ds.reduce((s, x) => s + x.cty, 0);
  const tKhach = ds.reduce((s, x) => s + x.khach, 0);
  return `-- =============================================================================
-- GHI SL BỔ SUNG CÔNG TY / KHÁCH VÀO ${ds.length} TEM BỔ SUNG IN 13/11 → 16/11/2026 CỦA LỆNH NHIỀU TEM (phần sót của script 17/11)
-- Sinh ${new Date().toISOString()} bằng backend/src/scripts/taoBoSungTemNhieuTem1811.js. Chạy bằng pgAdmin trên DB THLA.
-- -----------------------------------------------------------------------------
-- VÌ SAO: cùng lỗi luồng in tem cũ (SF0 gửi ERP số bổ sung 0, tem trống) nhưng script bo_sung_tem_tu_dot_1711.sql chỉ lấy
--   lệnh có đúng 1 tem ⇒ sót lệnh mà đợt BỔ SUNG gom vào lệnh cũ đã in tem đợt thường. Số của tem = số của đợt bổ sung vào
--   lệnh giữa tem trước và tem này. Ghi tem + 1 dòng audit SUA_TEM / tem (nguon = '${NGUON}').
--   ERP sửa RIÊNG bằng database/scripts/sqlserver/sf0_bo_sung_tem_nhieu_tem_1811.sql. Tổng: cty ${tCty} · khách ${tKhach}.
--
-- Tem tự BỎ QUA (không ghi) nếu lúc chạy: tem đã hủy · tem đã có số bổ sung (ai đó đã Sửa tem) · số của đợt đã đổi ·
--   Σ bổ sung > SL tem. Có dòng BỎ QUA ⇒ báo bên MES TRƯỚC khi chạy file SQL Server.
--
-- CÁCH CHẠY: F5 cả file.
--   1. Để nguyên chay_that = false → F5: chỉ ĐẾM, bảng cuối cột trang_thai = SE_GHI / BO_QUA (không ghi gì).
--   2. Sửa false thành true ở dòng INSERT INTO _cfg → F5: ghi thật, bảng cuối trang_thai = DA_GHI.
--   Chạy lại lần 2 vô hại (tem đã có số ⇒ BỎ QUA).
--
--   Tem           Lệnh      Chuyền SL    Cty  Khách In lúc
${bang}
-- =============================================================================
ROLLBACK;
DROP TABLE IF EXISTS pg_temp._cfg, pg_temp._ds, pg_temp._ket_qua;
BEGIN;

CREATE TEMP TABLE _cfg (chay_that boolean NOT NULL, nguon text NOT NULL);
INSERT INTO _cfg VALUES (false, '${NGUON}');

CREATE TEMP TABLE _ds (ma_tem text PRIMARY KEY, tem_id uuid NOT NULL, lenh text NOT NULL, cty int NOT NULL, khach int NOT NULL, dot_ids uuid[] NOT NULL);
INSERT INTO _ds (ma_tem, tem_id, lenh, cty, khach, dot_ids) VALUES
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
      FROM dot_vai_ve dv WHERE dv.id = ANY(ds.dot_ids)) d ON true;

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
           'ly_do', 'Chép SL bổ sung của đợt vải bổ sung sang tem (lệnh nhiều tem) — luồng in tem cũ lưu số bổ sung SAU khi tạo tem nên phiếu SF0 gửi ERP số 0',
           'sl_bo_sung_cty', NULLIF(k.cty, 0), 'sl_bo_sung_khach', NULLIF(k.khach, 0), 'nguon', v_nguon,
           'erp', 'gửi lại bằng database/scripts/sqlserver/sf0_bo_sung_tem_nhieu_tem_1811.sql'),
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
  const khoi = viec.map((v) => `-- ${v.ma_tem} · lệnh ${v.lenh} · chuyền ${v.chuyen} · in ${v.in_luc} · SL ${v.so_luong} · SLBSCty 0 → ${v.cty} · SLBSKhachHang 0 → ${v.khach}`
    + ` · IDDotNhanvai đã gửi ${v.than.IDDotNhanvai || '—'} (phiếu ready đợt bổ sung ${v.phieu_ready})\n`
    + khoiExec('MES_spr_MES2SF0', `${v.ma_tem} (IDMES ${v.idMes})`, thamSoSf0(v.than)));
  return `-- =============================================================================
-- GHI LẠI SF0 (MES_spr_MES2SF0) — SL BỔ SUNG CÔNG TY / KHÁCH CỦA ${viec.length} TEM BỔ SUNG IN 13/11 → 16/11/2026 (LỆNH NHIỀU TEM)
-- Sinh ${new Date().toISOString()} bằng backend/src/scripts/taoBoSungTemNhieuTem1811.js — CHẠY TRÊN DB ERP (SQL Server, SSMS).
-- -----------------------------------------------------------------------------
-- VÌ SAO: luồng in tem cũ dựng phiếu SF0 TRƯỚC khi lưu SL bổ sung của đợt ⇒ ERP nhận @pSLBSCty = 0 / @pSLBSKhachHang = 0.
--   Phần sót của sf0_bo_sung_tem_tu_dot_1711.sql (file đó chỉ có lệnh 1 tem). Mỗi dòng gọi lại proc với ĐÚNG IDMES cũ và
--   ĐÚNG thân SF0 thành công gần nhất (audit ERP_GHI_IN_TEM ở MES) — chỉ đổi 2 số bổ sung. Tổng: Σ SLBSCty ${tongCty} ·
--   Σ SLBSKhachHang ${tongKhach}.
--   Bên MES ghi cùng số bằng database/scripts/bo_sung_tem_nhieu_tem_1811.sql (pgAdmin) — chạy file đó TRƯỚC; có dòng BỎ QUA
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
  console.log(`[bo-sung-nhieu-tem] Đọc DB ${db[0].d} @ ${db[0].h || 'local'} (chỉ SELECT)`);

  const { rows } = await query(mot(SQL_TEM), [TU, DEN]);
  const { rows: au } = rows.length ? await query(mot(SQL_SF0), [rows.map((r) => String(r.tem_id))]) : { rows: [] };
  const mAu = new Map(au.map((a) => [String(a.id_ban_ghi), a.gia_tri_moi || {}]));

  const boQua = []; const viec = [];
  for (const r of rows) {
    const g = mAu.get(String(r.tem_id));
    const cu = g && (g.gui || g.payload);
    const idMes = cu ? Number(cu.IDMES) : NaN;
    const goc = `${r.ma_tem} (lệnh ${r.ma_lenh_san_xuat})`;
    if (r.cty + r.khach > r.so_luong) { boQua.push(`${goc} — bổ sung ${r.cty + r.khach} > SL tem ${r.so_luong}`); continue; }
    if (r.bs_tem_khac > 0) { boQua.push(`${goc} — tem khác của lệnh đang mang ${r.bs_tem_khac} bổ sung, xem tay`); continue; }
    if (!cu || !Number.isFinite(idMes)) { boQua.push(`${goc} — chưa có lần SF0 thành công / thiếu IDMES`); continue; }
    if (String(cu.BarcodeIn) !== String(r.ma_tem)) { boQua.push(`${goc} — thân SF0 mang mã tem khác (${cu.BarcodeIn})`); continue; }
    if ((Number(cu.SLBSCty) || 0) + (Number(cu.SLBSKhachHang) || 0) > 0) { boQua.push(`${goc} — SF0 đã gửi số bổ sung khác 0`); continue; }
    // SF0 lúc in là bằng chứng tem in cho ĐỢT NÀO: phải là phiếu ready của đợt bổ sung + inbosung 1. Không khớp ⇒ tem có thể in
    //   phần còn lại của đợt thường (đợt bổ sung chỉ tình cờ vào lệnh trước tem này) ⇒ không tự gán số, xem tay.
    if (Number(cu.inbosung) !== 1 || !String(r.phieu_ready || '').split(', ').includes(String(cu.IDDotNhanvai))) {
      boQua.push(`${goc} — SF0 lúc in gửi đợt ${cu.IDDotNhanvai} (inbosung ${cu.inbosung}), không phải đợt bổ sung ${r.phieu_ready} (cty ${r.cty}) — xem tay`);
      continue;
    }
    viec.push({
      ma_tem: r.ma_tem, tem_id: r.tem_id, lenh: r.ma_lenh_san_xuat, chuyen: r.chuyen || '—', so_luong: r.so_luong,
      cty: r.cty, khach: r.khach, dot_ids: r.dot_ids, phieu_ready: r.phieu_ready, in_luc: r.in_luc, idMes,
      than: { ...cu, SLBSCty: r.cty, SLBSKhachHang: r.khach },
    });
  }

  const fPg = path.join(GOC, 'bo_sung_tem_nhieu_tem_1811.sql');
  const fSs = path.join(GOC, 'sqlserver', 'sf0_bo_sung_tem_nhieu_tem_1811.sql');
  fs.writeFileSync(fPg, filePg(viec), 'utf8');
  fs.writeFileSync(fSs, `﻿${fileSqlServer(viec, boQua)}`, 'utf8'); // BOM ⇒ SSMS đọc đúng tiếng Việt
  console.log(`[bo-sung-nhieu-tem] ${rows.length} tem đủ điều kiện · ${viec.length} đưa vào script · bỏ qua ${boQua.length}`);
  boQua.forEach((x) => console.log(`  bỏ qua: ${x}`));
  viec.forEach((v) => console.log(`  ${v.ma_tem} ${v.lenh} ${v.chuyen} SL ${v.so_luong} cty ${v.cty} khách ${v.khach} · IDDotNhanvai gửi ${v.than.IDDotNhanvai} · phiếu ready ${v.phieu_ready} · inbosung ${v.than.inbosung}`));
  console.log(`[bo-sung-nhieu-tem] Σ cty ${viec.reduce((s, v) => s + v.cty, 0)} · Σ khách ${viec.reduce((s, v) => s + v.khach, 0)}`);
  console.log(`[bo-sung-nhieu-tem] ✓ ${fPg}\n[bo-sung-nhieu-tem] ✓ ${fSs}`);
}

main()
  .catch((e) => { console.error(`[bo-sung-nhieu-tem] ✗ ${e.message}`); process.exitCode = 1; })
  .finally(() => pool.end().catch(() => {}));
