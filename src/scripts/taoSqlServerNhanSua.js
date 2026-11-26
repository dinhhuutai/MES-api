'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SINH SCRIPT SQL SERVER GHI PHIẾU NHẬN SỬA (proc `MES_spr_MES2JH0`) cho các lượt nhận ĐÃ CÓ ở MES — 26/11/2026.
//   Dùng khi router ERP `/gui-erp-nhan-sua` chưa có / lượt nhận xảy ra trước khi MES biết gọi JH0.
//   Mỗi lượt nhận sửa (loại NHAN, chưa hủy) của tem = 1 `EXEC` với ĐÚNG thân MES sẽ gửi (`quality/nhanSuaErp.dungThan`):
//   SL nhận · nhãn 16 · mốc nhận · chuyền / tổ / ca trưởng / chuyền trưởng / thợ in theo phiếu IN TEM SF0.
//
// IDMES: lượt đã gửi JH0 thành công qua API ⇒ dùng lại IDMES đó (ghi đè). Chưa gửi ⇒ `YMMDD` của NGÀY NHẬN + (9000 + thứ tự
//   của lượt trong mọi lượt nhận cùng ngày) — dãy 9xxx bộ đếm MES (`erp_idmes_counter`, tối đa từng có ~1.230/ngày) không
//   bao giờ cấp tới, và cùng lượt chạy lại ra CÙNG số ⇒ chạy file 2 lần không đẻ phiếu mới NẾU proc xóa theo Soctcu.
//   Script chặn khi bộ đếm của ngày đó ≥ 9000.
// ⚠ Ghi thẳng bên ERP ⇒ MES KHÔNG có dòng Lịch sử API cho các lượt này: hủy lượt nhận ở MES sau này sẽ KHÔNG tự báo ERP hủy.
// ⚠ CHỈ ĐỌC DB MES (SELECT) — không ghi gì, không gọi ERP. In `current_database()` ra đầu tiên.
//
// CÁCH CHẠY (thư mục backend):
//     node src/scripts/taoSqlServerNhanSua.js                              ← 8 tem người dùng gửi 26/11/2026
//     node src/scripts/taoSqlServerNhanSua.js --tem=152608086549,62608086548   ← mã tem 15 / nhãn 16 / 10 số cuối đều được
//   ⇒ file ở `database/scripts/sqlserver/` — mở bằng SSMS trên DB ERP, đọc đầu file, đặt @chay_that = 1 rồi F5.
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { query, pool } = require('../config/db');
const { tChuoi, tSo, tNgay, khoiExec, cuoiFile } = require('./taoSqlServerGuiLai');
const nhanSuaErp = require('../modules/quality/nhanSuaErp');

const MAC_DINH = ['62608086549', '62608086548', '62608086281', '62608084712', '62608085440', '62608086312', '62608085286', '62608086410'];
const thamTem = (process.argv.find((a) => a.startsWith('--tem=')) || '').slice(6);
const DS = (thamTem ? thamTem.split(/[,;\s]+/) : MAC_DINH).map((s) => s.trim()).filter(Boolean);
const RA = path.resolve(__dirname, '../../../database/scripts/sqlserver');
const rong = (v) => (v == null || String(v) === '' ? null : v);

// Tham số JH0 — y hệt router `docs/erp-router/gui-erp-nhan-sua.js` (chuỗi rỗng ⇒ NULL như `|| null`).
const thamSoJh0 = (b) => [
  ['pIDMES', tSo(b.IDMES)], ['pNgayct', tNgay(b.Ngayct)], ['pNgayca', tChuoi(rong(b.Ngayca))],
  ['pTugio', tNgay(b.Tugio)], ['pDengio', tNgay(b.Dengio)],
  ['pChuyentruong', tChuoi(rong(b.Chuyentruong))], ['pCatruong', tChuoi(rong(b.Catruong))],
  ['pdsthoin', tChuoi(rong(b.dsthoin))], ['pToin', tChuoi(rong(b.Toin))], ['pbanin', tChuoi(rong(b.banin))],
  ['pIDDotNhanvai', tChuoi(rong(b.IDDotNhanvai))], ['pDDHID', tChuoi(rong(b.DDHID))], ['pDDHsubID', tSo(b.DDHsubID)],
  ['pBarcodeSua16', tChuoi(rong(b.BarcodeSua16))], ['pBarcodeSua17', tChuoi(rong(b.BarcodeSua17))],
  ['pinbosung', tSo(b.inbosung)], ['pLenhbosung', tChuoi(rong(b.Lenhbosung))], ['pSoluong', tSo(b.Soluong)],
];

async function main() {
  const { rows: db } = await query('SELECT current_database() AS d, inet_server_addr()::text AS h');
  console.log(`[sql-server] Đọc DB ${db[0].d} @ ${db[0].h || 'local'} (chỉ SELECT) · ${DS.length} mã tem`);
  const duoi = [...new Set(DS.map((m) => m.replace(/\D/g, '').slice(-10)).filter((m) => m.length === 10))];
  // Lượt nhận của tem gốc khớp 10 số cuối + thứ tự trong ngày nhận (mọi lượt NHAN cùng ngày) + IDMES JH0 đã gửi (nếu có).
  const { rows } = await query(`
    WITH ngay AS (
      SELECT n.id, n.tem_id, n.so_luong, n.loai, n.da_huy, n.created_date,
             (n.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS ngay,
             row_number() OVER (PARTITION BY (n.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
                                ORDER BY n.created_date, n.id) AS stt
        FROM nhan_sua n WHERE n.loai = 'NHAN')
    SELECT x.id, x.tem_id, x.so_luong, x.loai, x.da_huy, t.ma_tem, x.stt, to_char(x.ngay, 'YMMDD') AS ymd, x.ngay,
           to_char(x.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY/MM/DD HH24:MI:SS') AS moc,
           (SELECT c.so_thu_tu FROM erp_idmes_counter c WHERE c.ngay = x.ngay) AS dem_ngay,
           (SELECT a.gia_tri_moi->>'id_mes' FROM audit_log a WHERE a.ten_bang = 'nhan_sua' AND a.id_ban_ghi = x.id::text
               AND a.hanh_dong = 'ERP_GUI_NHAN_SUA' ORDER BY a.thoi_gian DESC LIMIT 1) AS id_mes_api
      FROM ngay x JOIN tem t ON t.id = x.tem_id
     WHERE t.tem_goc_id IS NULL AND right(t.ma_tem, 10) = ANY($1::text[])
     ORDER BY t.ma_tem, x.created_date`.replace(/\s+/g, ' '), [duoi]);

  const boQua = []; const khoi = [];
  const thay = new Set(rows.map((r) => r.ma_tem.slice(-10)));
  duoi.filter((d) => !thay.has(d)).forEach((d) => boQua.push(`…${d} — không có lượt nhận sửa nào`));
  for (const r of rows) {
    if (r.da_huy) { boQua.push(`${r.ma_tem} — lượt nhận ${r.so_luong} đã HỦY`); continue; }
    const stt = 9000 + Number(r.stt);
    if (Number(r.dem_ngay) >= 9000 || stt > 9999) throw new Error(`Ngày ${r.ymd}: bộ đếm IDMES ${r.dem_ngay} / thứ tự ${stt} chạm dãy 9xxx — dừng`);
    const idMes = r.id_mes_api ? Number(r.id_mes_api) : Number(`${r.ymd}${stt}`);
    // eslint-disable-next-line no-await-in-loop
    const b = await nhanSuaErp.dungThan(r, idMes);
    if (!b) { boQua.push(`${r.ma_tem} — không đọc được dữ liệu tem`); continue; }
    khoi.push(`-- ${b.BarcodeSua16} (tem ${r.ma_tem}) · nhận ${b.Soluong} lúc ${r.moc} · chuyền ${b.banin || '—'} · tổ ${b.Toin || '—'}`
      + ` · CT ${b.Catruong || '—'} · CTr ${b.Chuyentruong || '—'} · thợ ${b.dsthoin || '—'}${r.id_mes_api ? ' · IDMES đã gửi qua API' : ''}\n`
      + khoiExec('MES_spr_MES2JH0', `${b.BarcodeSua16} (IDMES ${b.IDMES})`, thamSoJh0(b)));
  }
  const tong = khoi.length;
  const bq = boQua.length ? boQua.map((x) => `--   · ${x}`).join('\n') : '--   (không có)';
  const noiDung = `-- =============================================================================
-- GHI PHIẾU NHẬN SỬA (MES_spr_MES2JH0) — ${tong} lượt nhận của ${thay.size} tem
-- Sinh lúc ${new Date().toISOString()} từ DB MES bằng backend/src/scripts/taoSqlServerNhanSua.js — CHẠY TRÊN DB ERP (SQL Server).
-- -----------------------------------------------------------------------------
-- Mỗi khối = 1 EXEC dbo.MES_spr_MES2JH0 với đúng thân MES gửi qua API: @pBarcodeSua16 = nhãn 16 · @pBarcodeSua17 NULL (chưa có
--   tem 17 lúc nhận) · @pSoluong = SL nhận · ngày CT / ngày ca / từ giờ / đến giờ = lúc nhận · chuyền (@pbanin) · tổ (@pToin) ·
--   ca trưởng · chuyền trưởng · thợ in (mã số nhân viên) = theo phiếu IN TEM SF0 của tem.
-- IDMES = YMMDD ngày nhận + 9xxx (dãy MES không cấp) — chạy lại file ra CÙNG IDMES. Proc chưa xóa phiếu cùng Soctcu thì
--   ĐỪNG chạy thật 2 lần.
-- Ghi thẳng bên ERP ⇒ MES không có dòng Lịch sử API cho các lượt này (hủy lượt nhận ở MES sẽ không tự báo ERP hủy).
--
-- CÁCH CHẠY (SSMS, đúng DB ERP):
--   1. Để nguyên @chay_that = 0 → F5: chỉ ĐẾM (bảng kết quả cuối: se_chay = ${tong}).
--   2. Đổi @chay_that = 1 → F5: chạy thật. Tab Messages liệt kê dòng lỗi / cảnh báo; bảng cuối: ok · canh_bao · loi.
--   Dòng lỗi không làm dừng file (mỗi EXEC bọc TRY/CATCH). Gửi tab Messages cho bên MES nếu loi > 0.
--
-- BỎ QUA:
${bq}
-- =============================================================================
SET NOCOUNT ON;
DECLARE @chay_that bit = 0;   -- ← ĐỔI THÀNH 1 ĐỂ CHẠY THẬT
DECLARE @rv int, @ok int = 0, @canh_bao int = 0, @loi int = 0, @dem int = 0;
`;
  fs.mkdirSync(RA, { recursive: true });
  const f = path.join(RA, `jh0_nhan_sua_${new Date(Date.now() + 7 * 3600e3).toISOString().slice(5, 10).replace('-', '')}.sql`);
  fs.writeFileSync(f, `﻿${noiDung}${khoi.join('\n')}${cuoiFile(tong)}`, 'utf8'); // BOM ⇒ SSMS đọc đúng tiếng Việt
  console.log(`[sql-server] ✓ ${tong} EXEC · bỏ qua ${boQua.length} ⇒ ${f}`);
}

main()
  .catch((e) => { console.error(`[sql-server] ✗ ${e.message}`); process.exitCode = 1; })
  .finally(() => pool.end().catch(() => {}));
