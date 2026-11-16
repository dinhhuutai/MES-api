'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SINH SCRIPT SQL SERVER (chạy THẲNG bên ERP, không qua API) để ghi lại phiếu ERP theo luật mới — 14/11/2026:
//   · sf0 : phiếu in tem SF0 của hàng BỔ SUNG (mặc định in 01/11 → 30/11) — thêm `@pSLBSCty` / `@pSLBSKhachHang` (chỉ tem đầu
//           của lệnh mang số), người trống ⇒ "-". Phạm vi tem = `guiLaiSf0BoSung.SQL_TEM_BO_SUNG`.
//   · su6 : phiếu phân loại lỗi SU6 có NGÀY CT (lần gửi gần nhất) trong khoảng (mặc định 13/11 → 13/11) — `@pDsMaloi` bộ bốn
//           `mã, SL hủy, SL sửa, SL đạt`. Phạm vi phiếu = `guiLaiSu6PhanLoaiLoi.SQL_PHIEU_PLL`.
//   Mỗi dòng = 1 `EXEC` proc với ĐÚNG thân MES sẽ gửi (dựng như nút "Gửi lại ERP": GIỮ IDMES + Ngày CT + SL in / hủy / thiếu
//   của lần gửi trước, SU6 giữ cả nhân viên) ⇒ proc ghi đè đúng phiếu cũ theo Soctcu = IDMES, không đẻ phiếu mới.
//   Tem / phiếu chưa từng gửi (không có IDMES) ⇒ bỏ qua, liệt kê ở đầu file.
//
// ⚠ CHỈ ĐỌC DB MES (SELECT) — không ghi gì, không gọi ERP. Kiểm `PGHOST`/`PGDATABASE` in ra đầu tiên.
// ⚠ Ghi thẳng bên ERP KHÔNG để lại dòng Lịch sử API ở MES.
//
// CÁCH CHẠY (thư mục backend):
//     node src/scripts/taoSqlServerGuiLai.js sf0                         ← tem bổ sung in 01/11 → 30/11/2026
//     node src/scripts/taoSqlServerGuiLai.js su6                         ← phân loại lỗi Ngày CT 13/11/2026
//     node src/scripts/taoSqlServerGuiLai.js su6 2026-11-13 2026-11-14   ← khoảng khác
//   ⇒ file ở `database/scripts/sqlserver/` — mở bằng SSMS trên DB ERP, đọc đầu file, đặt @chay_that = 1 rồi F5.
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { query, pool } = require('../config/db');
const prodRepo = require('../modules/production/production.repository');
const plRepo = require('../modules/quality/phanloailoi.repository');
const erp = require('../utils/erpApiChung');
const { taoPayload, dungThanGui, laMaTemErp } = require('../utils/erpGhiInTem');
const { ngayCtDaGui } = require('../utils/erpNgayGio');
const { temCode } = require('../utils/temPrefix');
const { idMesCu } = require('../modules/caidatapi/guiLai');
const { SQL_TEM_BO_SUNG } = require('./guiLaiSf0BoSung');
const { SQL_PHIEU_PLL } = require('./guiLaiSu6PhanLoaiLoi');

const args = process.argv.slice(2);
const LOAI = (args[0] || '').toLowerCase();
const ngays = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const MAC_DINH = { sf0: ['2026-11-01', '2026-11-30'], su6: ['2026-11-13', '2026-11-13'] };
const RA = path.resolve(__dirname, '../../../database/scripts/sqlserver');

// ─── T-SQL helpers ───────────────────────────────────────────────────────────
const tChuoi = (v) => (v == null ? 'NULL' : `N'${String(v).replace(/'/g, "''")}'`);
const tSo = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? 'NULL' : String(Math.trunc(Number(v))));
// Ngày giờ MES gửi = giờ VN dán nhãn Z ("2026-11-13T09:30:00.000Z") ⇒ router lưu đúng giờ đó ⇒ bỏ đuôi Z, dạng ISO 'T'
//   (SQL Server đọc không phụ thuộc ngôn ngữ / DATEFORMAT).
const tNgay = (v) => {
  const m = /^(\d{4})[-/](\d{2})[-/](\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(v || ''));
  return m ? `'${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}'` : 'NULL';
};
const rong = (v) => (v == null || String(v) === '' ? null : v);

// Tham số SF0 — y hệt router `docs/erp-router/ghi-in-tem.js` (chuỗi rỗng ⇒ NULL như `|| null`, trừ @pKieng).
function thamSoSf0(b) {
  const soNguyen = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
  return [
    ['pIDMES', tSo(b.IDMES)], ['pNgayct', tNgay(b.Ngayct)], ['pNgayca', tChuoi(rong(b.Ngayca))],
    ['pTugio', tNgay(b.Tugio)], ['pDengio', tNgay(b.Dengio)],
    ['pChuyentruong', tChuoi(rong(b.Chuyentruong))], ['pCatruong', tChuoi(rong(b.Catruong))],
    ['pdsthoin', tChuoi(rong(b.dsthoin))], ['pToin', tChuoi(rong(b.Toin))], ['pbanin', tChuoi(rong(b.banin))],
    ['pIDDotNhanvai', tChuoi(rong(b.IDDotNhanvai))], ['pDDHID', tChuoi(rong(b.DDHID))], ['pDDHsubID', tSo(b.DDHsubID)],
    ['pBarcodeIn', tChuoi(rong(b.BarcodeIn))], ['pinbosung', tSo(b.inbosung)], ['pLenhbosung', tChuoi(rong(b.Lenhbosung))],
    ['pSoluong', tSo(b.Soluong)], ['pSoluongloi', tSo(b.Soluongloi)], ['pSOLUONGTHIEU', tSo(b.SOLUONGTHIEU)],
    ['pGCMauvai', tChuoi(rong(b.GCMauvai))],
    ['pLabtp', String(Number(b.Labtp) ? 1 : 0)], ['pLabtpCuoi', String(Number(b.LabtpCuoi) ? 1 : 0)],
    ['pKieng', tChuoi(String(b.Kieng || '').slice(0, 20))], ['pSoluongKieng', String(soNguyen(b.SoluongKieng))],
    ['pHsKieng', String(soNguyen(b.HsKieng))],
    ['pSLBSCty', String(soNguyen(b.SLBSCty))], ['pSLBSKhachHang', String(soNguyen(b.SLBSKhachHang))],
  ];
}

// 1 khối EXEC an toàn: lỗi 1 dòng không dừng cả file; proc để treo transaction ⇒ ROLLBACK rồi đi tiếp.
function khoiExec(proc, nhan, thamSo) {
  const ts = thamSo.map(([k, v]) => `@${k} = ${v}`).join(', ');
  const n = tChuoi(nhan);
  return `IF @chay_that = 1
BEGIN
  BEGIN TRY
    SET @rv = NULL;
    EXEC @rv = dbo.${proc} ${ts};
    IF ISNULL(@rv, 0) = 0 BEGIN SET @ok += 1; END
    ELSE BEGIN SET @canh_bao += 1; PRINT N'⚠ ' + ${n} + N' — proc trả returnValue = ' + CAST(@rv AS nvarchar(20)); END
  END TRY
  BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    SET @loi += 1; PRINT N'✗ ' + ${n} + N': ' + ERROR_MESSAGE();
  END CATCH
END
ELSE SET @dem += 1;`;
}

function dauFile({ tieuDe, moTa, tong, boQua, proc }) {
  const bq = boQua.length ? boQua.map((x) => `--   · ${x}`).join('\n') : '--   (không có)';
  return `-- =============================================================================
-- ${tieuDe}
-- Sinh lúc ${new Date().toISOString()} từ DB MES bằng backend/src/scripts/taoSqlServerGuiLai.js — CHẠY TRÊN DB ERP (SQL Server).
-- -----------------------------------------------------------------------------
${moTa}
-- Mỗi dòng = 1 EXEC dbo.${proc} với ĐÚNG IDMES cũ ⇒ proc XÓA phiếu cùng Soctcu rồi tạo lại (ghi đè, không đẻ phiếu mới).
-- Chạy lại lần 2 vô hại. Ghi thẳng bên ERP ⇒ KHÔNG có dòng Lịch sử API ở MES.
--
-- CÁCH CHẠY (SSMS, đúng DB ERP):
--   1. Để nguyên @chay_that = 0 → F5: chỉ ĐẾM (bảng kết quả cuối: se_chay = ${tong}).
--   2. Đổi @chay_that = 1 → F5: chạy thật. Tab Messages liệt kê dòng lỗi / cảnh báo; bảng cuối: ok · canh_bao · loi.
--   Dòng lỗi không làm dừng file (mỗi EXEC bọc TRY/CATCH). Gửi tab Messages cho bên MES nếu loi > 0.
--
-- BỎ QUA (chưa từng gửi ERP / không có IDMES — không ghi đè được):
${bq}
-- =============================================================================
SET NOCOUNT ON;
DECLARE @chay_that bit = 0;   -- ← ĐỔI THÀNH 1 ĐỂ CHẠY THẬT
DECLARE @rv int, @ok int = 0, @canh_bao int = 0, @loi int = 0, @dem int = 0;
`;
}
const cuoiFile = (tong) => `
SELECT CASE WHEN @chay_that = 1 THEN N'DA_CHAY' ELSE N'DEM_THU' END AS che_do, ${tong} AS tong_dong,
       @dem AS se_chay, @ok AS ok, @canh_bao AS canh_bao, @loi AS loi;
`;

// ─── SF0 bổ sung ─────────────────────────────────────────────────────────────
async function sinhSf0(tu, den) {
  const { rows } = await query(SQL_TEM_BO_SUNG.replace(/\s+/g, ' '), [tu, den]);
  const ids = rows.filter((r) => r.audit_id).map((r) => String(r.audit_id));
  const { rows: au } = ids.length
    ? await query('SELECT id, gia_tri_moi FROM audit_log WHERE id::text = ANY($1::text[])', [ids])
    : { rows: [] };
  const mAu = new Map(au.map((a) => [String(a.id), a.gia_tri_moi || {}]));
  const temIds = rows.map((r) => r.tem_id);
  const { rows: dv } = await query('SELECT id, to_jsonb(t)->>\'dot_vai_ve_id\' AS dot_vai_ve_id FROM tem t WHERE id = ANY($1::uuid[])', [temIds]);
  const mDv = new Map(dv.map((x) => [x.id, x.dot_vai_ve_id || null]));
  let mVai = new Map();
  try {
    const { rows: v } = await query(
      `SELECT tem_id, COALESCE(SUM(so_luong) FILTER (WHERE COALESCE(loai,'HUY') = 'HUY'), 0)::int AS huy,
              COALESCE(SUM(so_luong) FILTER (WHERE loai = 'THIEU'), 0)::int AS thieu, count(*)::int AS so_dong
         FROM vai_huy WHERE tem_id = ANY($1::uuid[]) GROUP BY tem_id`.replace(/\s+/g, ' '), [temIds]);
    mVai = new Map(v.map((x) => [x.tem_id, x]));
  } catch { mVai = new Map(); } // chưa có cột vai_huy.tem_id ⇒ giữ số đã gửi lần trước

  const boQua = []; const viec = [];
  for (const r of rows) {
    const g = r.audit_id ? mAu.get(String(r.audit_id)) : null;
    const idMes = g ? idMesCu(g) : null;
    if (idMes == null) { boQua.push(`${r.ma_tem} (lệnh ${r.ma_lenh_san_xuat}) — chưa có IDMES`); continue; }
    if (!laMaTemErp(r.ma_tem)) { boQua.push(`${r.ma_tem} — chưa có mã tem ERP`); continue; }
    const cu = g.gui || g.payload || {};
    viec.push({ r, idMes, cu, ngayCt: ngayCtDaGui(cu.Ngayct) });
  }
  // `duLieuGhiInTem` nhận nhiều tem chung 1 Ngày CT ⇒ gom theo Ngày CT (ít câu).
  const theoNgay = new Map();
  for (const v of viec) {
    const k = v.ngayCt || '';
    if (!theoNgay.has(k)) theoNgay.set(k, []);
    theoNgay.get(k).push(v);
  }
  const khoi = []; let tongCty = 0; let tongKhach = 0; let soTemDau = 0;
  for (const [ngay, ds] of theoNgay) {
    // eslint-disable-next-line no-await-in-loop
    const du = await prodRepo.duLieuGhiInTem(ds.map((v) => ({ temId: v.r.tem_id, dotVaiId: mDv.get(v.r.tem_id) || null })), ngay || null);
    const mDu = new Map(du.map((x) => [x.tem_id, x]));
    for (const v of ds) {
      const x = mDu.get(v.r.tem_id);
      if (!x) { boQua.push(`${v.r.ma_tem} — không đọc được dữ liệu tem`); continue; }
      const vai = mVai.get(v.r.tem_id);
      const soHoacNull = (s) => (s == null || s === '' || !Number.isFinite(Number(s)) ? null : Number(s));
      const payload = taoPayload(x, {
        idMes: v.idMes,
        soLuong: soHoacNull(v.cu.Soluong),
        soLuongHuy: vai && vai.so_dong > 0 ? vai.huy : (soHoacNull(v.cu.Soluongloi) || 0),
        soLuongThieu: vai && vai.so_dong > 0 ? vai.thieu : (soHoacNull(v.cu.SOLUONGTHIEU) || 0),
      });
      // eslint-disable-next-line no-await-in-loop
      const b = await dungThanGui(payload, 'ERP_GHI_IN_TEM');
      tongCty += Number(b.SLBSCty) || 0; tongKhach += Number(b.SLBSKhachHang) || 0;
      if (Number(b.SLBSCty) || Number(b.SLBSKhachHang)) soTemDau += 1;
      khoi.push(`-- ${b.BarcodeIn} · lệnh ${v.r.ma_lenh_san_xuat} · in ${v.r.ngay_in} · SLBSCty ${b.SLBSCty} · SLBSKhachHang ${b.SLBSKhachHang}\n`
        + khoiExec('MES_spr_MES2SF0', `${b.BarcodeIn} (IDMES ${b.IDMES})`, thamSoSf0(b)));
    }
  }
  const moTa = `-- Phiếu in tem SF0 của TEM BỔ SUNG in ${tu} → ${den} (+ tem đầu của các lệnh đó): ghi lại kèm @pSLBSCty / @pSLBSKhachHang
--   (chỉ TEM ĐẦU của lệnh mang số, tem sau 0) + ca trưởng / chuyền trưởng / thợ in trống ⇒ "-".
--   Tổng: ${khoi.length} phiếu · ${soTemDau} tem mang số bổ sung · Σ SLBSCty ${tongCty} · Σ SLBSKhachHang ${tongKhach}.`;
  return { ten: `sf0_bo_sung_${tu.slice(5).replace('-', '')}_${den.slice(5).replace('-', '')}.sql`,
    noiDung: dauFile({ tieuDe: 'GHI LẠI SF0 (MES_spr_MES2SF0) — HÀNG BỔ SUNG', moTa, tong: khoi.length, boQua, proc: 'MES_spr_MES2SF0' })
      + khoi.join('\n') + cuoiFile(khoi.length), so: khoi.length, boQua: boQua.length };
}

// ─── SU6 phân loại lỗi ───────────────────────────────────────────────────────
async function sinhSu6(tu, den) {
  // Lấy phiếu lưu từ `tu` tới hôm nay rồi lọc theo NGÀY CT của lần gửi gần nhất (giờ VN, 10 ký tự đầu).
  const homNay = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  const { rows } = await query(SQL_PHIEU_PLL.replace(/\s+/g, ' '), [tu, homNay > den ? homNay : den]);
  const boQua = []; const khoi = [];
  for (const r of rows) {
    const cu = (r.gtm && r.gtm.gui) || {};
    const ngayCt = String(cu.Ngayct || '').slice(0, 10) || String(r.tg_luu_vn || '').slice(0, 10);
    if (ngayCt < tu || ngayCt > den) continue;
    const ma16 = temCode(r.ma_tem, 16);
    if (!laMaTemErp(r.ma_tem)) { boQua.push(`${r.ma_tem} — chưa có mã tem ERP`); continue; }
    const idMes = r.audit_id ? String(cu.IDMes || r.gtm.id_mes || '') : '';
    if (!idMes) { boQua.push(`${ma16} — phiếu chưa từng gửi SU6 (không có IDMes)`); continue; }
    // eslint-disable-next-line no-await-in-loop
    const phieu = await plRepo.getPhieuTheoTem(r.tem_id);
    const ds = phieu ? erp.dsMaLoi(phieu.dong, r.sl_kcs_dat) : '';
    if (!ds) { boQua.push(`${ma16} — không dòng nào có mã lỗi`); continue; }
    // eslint-disable-next-line no-await-in-loop
    const nv = cu.nhanvien || await erp.tenDangNhap(r.nguoi_luu);
    const thamSo = [
      ['pIDMes', tChuoi(idMes.slice(0, 20))], ['pNgayct', tNgay(cu.Ngayct || r.tg_luu_vn)],
      ['pnhanvien', tChuoi(rong(String(nv || '').slice(0, 20)))], ['pMaquet', tChuoi(ma16)],
      ['pDsMaloi', tChuoi(ds.slice(0, 4000))],
    ];
    khoi.push(`-- ${ma16} · Ngày CT ${ngayCt} · ${ds}\n` + khoiExec('MES_spr_MES2SU6', `${ma16} (IDMes ${idMes})`, thamSo));
  }
  const moTa = `-- Phiếu phân loại lỗi SU6 có Ngày CT ${tu}${den !== tu ? ` → ${den}` : ''}: ghi lại @pDsMaloi theo BỘ BỐN
--   \`mã lỗi, SL hủy, SL sửa, SL đạt\` (SL đạt = đạt KCS của tem, lặp lại mọi bộ). Giữ IDMes · Ngày CT · nhân viên cũ.
--   ⚠ Proc MES_spr_MES2SU6 PHẢI ĐÃ ALTER đọc bộ bốn trước khi chạy file này.
--   Tổng: ${khoi.length} phiếu.`;
  const tenNgay = tu === den ? tu.slice(5).replace('-', '') : `${tu.slice(5).replace('-', '')}_${den.slice(5).replace('-', '')}`;
  return { ten: `su6_phan_loai_loi_${tenNgay}.sql`,
    noiDung: dauFile({ tieuDe: 'GHI LẠI SU6 (MES_spr_MES2SU6) — PHÂN LOẠI LỖI BỘ BỐN', moTa, tong: khoi.length, boQua, proc: 'MES_spr_MES2SU6' })
      + khoi.join('\n') + cuoiFile(khoi.length), so: khoi.length, boQua: boQua.length };
}

async function main() {
  if (!MAC_DINH[LOAI]) throw new Error('Cần chọn loại: sf0 hoặc su6');
  const [tu, den] = [ngays[0] || MAC_DINH[LOAI][0], ngays[1] || ngays[0] || MAC_DINH[LOAI][1]];
  const { rows: db } = await query('SELECT current_database() AS d, inet_server_addr()::text AS h');
  console.log(`[sql-server] Đọc DB ${db[0].d} @ ${db[0].h || 'local'} (chỉ SELECT) · ${LOAI} ${tu} → ${den}`);
  const kq = LOAI === 'sf0' ? await sinhSf0(tu, den) : await sinhSu6(tu, den);
  fs.mkdirSync(RA, { recursive: true });
  const f = path.join(RA, kq.ten);
  fs.writeFileSync(f, `﻿${kq.noiDung}`, 'utf8'); // BOM ⇒ SSMS đọc đúng tiếng Việt
  console.log(`[sql-server] ✓ ${kq.so} EXEC · bỏ qua ${kq.boQua} ⇒ ${f}`);
}

main()
  .catch((e) => { console.error(`[sql-server] ✗ ${e.message}`); process.exitCode = 1; })
  .finally(() => pool.end().catch(() => {}));
