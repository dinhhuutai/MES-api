'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// GỬI LẠI PHIẾU IN TEM (ERP SF0) CHO HÀNG BỔ SUNG — để ERP nhận 2 tham số mới `@pSLBSCty` · `@pSLBSKhachHang`
// (proc `MES_spr_MES2SF0` ALTER 12/11/2026). Gửi lại = CHÍNH nút "Gửi lại" ở Cài đặt API (`caidatapi/guiLai`): GIỮ IDMES +
// Ngày CT của lần gửi trước ⇒ proc ghi đè đúng phiếu cũ, không đẻ phiếu mới; số lượng in / vải hủy / thiếu như lần trước.
//
// PHẠM VI: tem 15 còn sống của các LỆNH có đợt vải BỔ SUNG, in trong khoảng ngày (giờ VN, mặc định CẢ THÁNG 11/2026),
//   + TEM ĐẦU của chính các lệnh đó nếu tem đầu in TRƯỚC khoảng ngày — vì luật mới chỉ tem đầu mang số bổ sung (tem sau
//   gửi 0), không gửi lại tem đầu thì số của đợt không bao giờ sang ERP.
//   Tem chưa từng gửi SF0 (không có dòng lịch sử) ⇒ bỏ qua, liệt kê ra cho biết.
//
// CÁCH CHẠY (trên MÁY CHỦ production, thư mục backend — SAU KHI deploy BE bản có 2 tham số này VÀ ERP đã thay router
// `/ghi-in-tem` theo `docs/erp-router/ghi-in-tem.js`):
//     node src/scripts/guiLaiSf0BoSung.js                          ← XEM THỬ (mặc định 2026-11-01 → 2026-11-30), không gửi gì
//     node src/scripts/guiLaiSf0BoSung.js 2026-11-11 2026-11-12    ← xem thử khoảng ngày khác
//     node src/scripts/guiLaiSf0BoSung.js --gui                    ← GỬI THẬT (tuần tự, từng tem 1)
//
// ⚠ Người gửi ghi vào lịch sử = tài khoản `admin` (đổi bằng `--nguoi=<tên đăng nhập>`).
// ⚠ Chạy lại lần 2 vô hại: cùng IDMES ⇒ ERP ghi đè phiếu.
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const { query, pool } = require('../config/db');
const prodRepo = require('../modules/production/production.repository');
const { taoPayload } = require('../utils/erpGhiInTem');
const { guiLai } = require('../modules/caidatapi/guiLai');

const args = process.argv.slice(2);
const ngays = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const TU = ngays[0] || '2026-11-01';
const DEN = ngays[1] || ngays[0] || '2026-11-30';
const GUI = args.includes('--gui');
const NGUOI = (args.find((a) => a.startsWith('--nguoi=')) || '--nguoi=admin').slice('--nguoi='.length);

// Tem 15 sống của lệnh có đợt BO_SUNG, in trong khoảng + tem đầu (sớm nhất) của các lệnh đó. Kèm dòng SF0 mới nhất.
const SQL = `
  WITH lenh_bs AS (
    SELECT DISTINCT ls.id
      FROM lenh_san_xuat ls
      JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
      JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
      JOIN loai_dot_vai ldv ON ldv.id = dv.loai_dot_vai_id AND ldv.ma_loai = 'BO_SUNG'
  ),
  tem_song AS (
    SELECT t.id, t.ma_tem, t.created_date, ps.lenh_san_xuat_id, ls.ma_lenh_san_xuat,
           (t.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS ngay_in,
           row_number() OVER (PARTITION BY ps.lenh_san_xuat_id ORDER BY t.created_date, t.id) AS thu_tu
      FROM tem t
      JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
      JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
     WHERE ps.lenh_san_xuat_id IN (SELECT id FROM lenh_bs)
       AND t.tem_goc_id IS NULL AND t.trang_thai <> 'HUY' AND t.ma_tem ~ '^15[0-9]{10}$'
  ),
  chon AS (
    SELECT * FROM tem_song ts
     WHERE ts.ngay_in BETWEEN $1::date AND $2::date
        OR (ts.thu_tu = 1 AND EXISTS (SELECT 1 FROM tem_song x WHERE x.lenh_san_xuat_id = ts.lenh_san_xuat_id
                                       AND x.ngay_in BETWEEN $1::date AND $2::date))
  )
  SELECT c.id AS tem_id, c.ma_tem, c.ma_lenh_san_xuat, to_char(c.ngay_in, 'YYYY-MM-DD') AS ngay_in, c.thu_tu,
         (SELECT a.id FROM audit_log a
           WHERE a.ten_bang = 'tem' AND a.id_ban_ghi = c.id::text AND a.hanh_dong IN ('ERP_GHI_IN_TEM', 'ERP_GHI_IN_TEM_LOI')
           ORDER BY a.thoi_gian DESC LIMIT 1) AS audit_id
    FROM chon c
   ORDER BY c.ma_lenh_san_xuat, c.thu_tu`;

async function main() {
  console.log(`[sf0-bo-sung] Khoảng ngày in tem ${TU} → ${DEN} · ${GUI ? 'GỬI THẬT' : 'XEM THỬ (thêm --gui để gửi)'}`);
  const { rows } = await query(SQL.replace(/\s+/g, ' '), [TU, DEN]);
  if (!rows.length) { console.log('Không có tem bổ sung nào trong khoảng.'); return; }

  // Số sẽ gửi — dựng đúng như lúc gửi thật (lệnh 1 phần in xét mức lệnh, `guiLai` không truyền đợt).
  const du = await prodRepo.duLieuGhiInTem(rows.map((r) => ({ temId: r.tem_id })));
  const theoTem = new Map(du.map((x) => [x.tem_id, x]));
  const coGui = []; const chuaGui = [];
  for (const r of rows) {
    const x = theoTem.get(r.tem_id) || {};
    const p = taoPayload(x, { idMes: 0 });
    const dong = { ...r, cty: p.SLBSCty, khach: p.SLBSKhachHang, tem_dau: !!x.la_tem_dau_dot };
    (r.audit_id ? coGui : chuaGui).push(dong);
  }
  console.log('\nMã tem        Lệnh        Ngày in     Tem đầu  SLBSCty  SLBSKhachHang');
  for (const d of coGui) {
    console.log(`${d.ma_tem}  ${String(d.ma_lenh_san_xuat).padEnd(10)}  ${d.ngay_in}  ${d.tem_dau ? 'có     ' : '       '}  ${String(d.cty).padStart(7)}  ${String(d.khach).padStart(13)}`);
  }
  console.log(`\nTổng ${coGui.length} tem sẽ gửi lại · ${coGui.filter((d) => d.tem_dau).length} tem đầu mang số bổ sung`
    + ` · Σ cty ${coGui.reduce((a, d) => a + d.cty, 0)} · Σ khách ${coGui.reduce((a, d) => a + d.khach, 0)}`);
  if (chuaGui.length) {
    console.log(`Bỏ qua ${chuaGui.length} tem CHƯA từng gửi SF0 (không có lịch sử): ${chuaGui.map((d) => d.ma_tem).join(', ')}`);
  }
  if (!GUI) { console.log('\nXEM THỬ — chưa gửi gì. Chạy lại với --gui để gửi.'); return; }

  const { rows: nd } = await query('SELECT id FROM nguoi_dung WHERE ten_dang_nhap = $1', [NGUOI]);
  if (!nd.length) throw new Error(`Không tìm thấy tài khoản ${NGUOI}`);
  let ok = 0; const loi = [];
  for (const d of coGui) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await guiLai('ERP_GHI_IN_TEM', d.audit_id, nd[0].id);
      ok += 1;
      console.log(`  ✓ ${d.ma_tem}`);
    } catch (e) {
      loi.push(`${d.ma_tem}: ${e.message}`);
      console.log(`  ✗ ${d.ma_tem}: ${e.message}`);
    }
  }
  console.log(`\nXong: gửi được ${ok}/${coGui.length}${loi.length ? ` · lỗi ${loi.length} (xem trên — gửi lại tay ở Cài đặt API › Lịch sử)` : ''}`);
}

main()
  .catch((e) => { console.error(`[sf0-bo-sung] ✗ ${e.message}`); process.exitCode = 1; })
  .finally(() => pool.end().catch(() => {}));
