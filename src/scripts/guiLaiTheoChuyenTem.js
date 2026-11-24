'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// GỬI LẠI ERP CÁC LƯỢT MANG SAI CHUYỀN (`banin`) SAU KHI CHỐT CHUYỀN TEM LÚC IN (23/11/2026).
//
// Bối cảnh: trước bản chốt chuyền lúc in (`utils/temChuyen.js chotChuyenTemTx`), tem đọc chuyền HIỆN TẠI của phiếu ⇒ "Đổi
//   chuyền" phiếu sau khi in làm các lượt gửi ERP về sau (Sh6 kiểm phẩm, SK6 sửa đạt, QO6 OQC, SF0 gửi lại) mang chuyền MỚI.
//   Chạy `database/scripts/chot_chuyen_tem_luc_in_2311.sql` xong, tem đã về đúng chuyền lúc in ⇒ script này tìm lượt gửi
//   THÀNH CÔNG mới nhất của mỗi bản ghi (4 kênh) mà `gui.banin` ≠ chuyền hiện tại của tem, rồi gửi lại bằng CHÍNH nút
//   "Gửi lại ERP" (`caidatapi/guiLai` — cùng IDMES ⇒ ERP ghi đè phiếu cũ, thân dựng từ dữ liệu MES hiện tại).
//   Lượt mới nhất đang LỖI ⇒ bỏ (hàng đợi tự gửi lại đã dựng theo dữ liệu hiện tại).
//
// CÁCH CHẠY (MÁY CHỦ production, thư mục backend — SAU khi deploy BE + chạy script SQL chốt chuyền):
//     node src/scripts/guiLaiTheoChuyenTem.js                 ← XEM THỬ (45 ngày gần nhất), không gửi gì
//     node src/scripts/guiLaiTheoChuyenTem.js --ngay=60        ← xét 60 ngày
//     node src/scripts/guiLaiTheoChuyenTem.js --gui            ← GỬI THẬT (tuần tự)
// ⚠ Người gửi ghi vào lịch sử = `admin` (đổi bằng `--nguoi=<tên đăng nhập>`). Chạy lại vô hại (cùng IDMES ⇒ ghi đè).
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const { query, pool } = require('../config/db');
const { chuyenTemSql } = require('../utils/temChuyen');
const { guiLai } = require('../modules/caidatapi/guiLai');

const args = process.argv.slice(2);
const GUI = args.includes('--gui');
const SO_NGAY = Math.max(1, Number((args.find((a) => a.startsWith('--ngay=')) || '--ngay=45').slice(7)) || 45);
const NGUOI = (args.find((a) => a.startsWith('--nguoi=')) || '--nguoi=admin').slice('--nguoi='.length);
const KENH = ['ERP_GHI_IN_TEM', 'ERP_GUI_KIEM_PHAM', 'ERP_GUI_SUA_DAT', 'ERP_GUI_OQC'];

async function main() {
  console.log(`[gui-lai-chuyen] ${SO_NGAY} ngày gần nhất · ${GUI ? 'GỬI THẬT' : 'XEM THỬ (thêm --gui để gửi)'}`);
  const cTem = await chuyenTemSql({ t: 't', ps: 'ps', ls: 'ls' });
  // Lượt MỚI NHẤT (thành công hoặc lỗi) của mỗi (kênh, bản ghi) ⇒ tem của bản ghi ⇒ chuyền hiện tại của tem.
  const sql = `
    WITH moi AS (
      SELECT DISTINCT ON (replace(a.hanh_dong, '_LOI', ''), a.ten_bang, a.id_ban_ghi)
             a.id, replace(a.hanh_dong, '_LOI', '') AS ma, a.hanh_dong, a.ten_bang, a.id_ban_ghi,
             a.gia_tri_moi->>'ma_tem' AS ma_tem, upper(trim(a.gia_tri_moi->'gui'->>'banin')) AS banin
        FROM audit_log a
       WHERE a.hanh_dong = ANY($1::text[]) AND a.thoi_gian > now() - make_interval(days => $2::int)
         AND a.id_ban_ghi ~ '^[0-9a-f-]{36}$'
       ORDER BY replace(a.hanh_dong, '_LOI', ''), a.ten_bang, a.id_ban_ghi, a.thoi_gian DESC)
    SELECT m.id AS audit_id, m.ma, m.ma_tem, m.banin, upper(c.ma_chuyen) AS chuyen_tem
      FROM moi m
      JOIN tem t ON t.id = (CASE
             WHEN m.ten_bang = 'tem' THEN m.id_ban_ghi::uuid
             WHEN m.ten_bang = 'kcs' THEN (SELECT k.tem_id FROM kcs k WHERE k.id = m.id_ban_ghi::uuid)
             WHEN m.ten_bang = 'sua' THEN (SELECT COALESCE(s.tem_con_id, s.tem_id) FROM sua s WHERE s.id = m.id_ban_ghi::uuid)
             WHEN m.ten_bang = 'oqc' THEN (SELECT o.tem_id FROM oqc o WHERE o.id = m.id_ban_ghi::uuid) END)
      JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
      JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
      JOIN chuyen_san_xuat c ON c.id = ${cTem}
     WHERE m.hanh_dong NOT LIKE '%\\_LOI' AND m.id_ban_ghi ~ '^[0-9a-f-]{36}$'
       AND COALESCE(m.banin, '') <> '' AND m.banin <> upper(c.ma_chuyen)
     ORDER BY m.ma, m.ma_tem`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [[...KENH, ...KENH.map((k) => `${k}_LOI`)], SO_NGAY]);
  if (!rows.length) { console.log('Không có lượt nào lệch chuyền.'); return; }

  const dem = rows.reduce((a, r) => ({ ...a, [r.ma]: (a[r.ma] || 0) + 1 }), {});
  console.log('\nKênh               Mã tem         Đã gửi  → Chuyền tem');
  rows.forEach((r) => console.log(`${r.ma.padEnd(18)} ${String(r.ma_tem || '').padEnd(14)} ${String(r.banin).padEnd(7)} → ${r.chuyen_tem}`));
  console.log(`\nTổng ${rows.length} lượt: ${Object.entries(dem).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  if (!GUI) { console.log('\nXEM THỬ — chưa gửi gì. Chạy lại với --gui để gửi.'); return; }

  const { rows: nd } = await query('SELECT id FROM nguoi_dung WHERE ten_dang_nhap = $1', [NGUOI]);
  if (!nd.length) throw new Error(`Không tìm thấy tài khoản ${NGUOI}`);
  let ok = 0; const loi = [];
  for (const r of rows) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await guiLai(r.ma, r.audit_id, nd[0].id);
      ok += 1;
      console.log(`  ✓ ${r.ma} ${r.ma_tem}`);
    } catch (e) {
      loi.push(r);
      console.log(`  ✗ ${r.ma} ${r.ma_tem}: ${e.message}`);
    }
  }
  console.log(`\nXong: gửi được ${ok}/${rows.length}${loi.length ? ` · lỗi ${loi.length} (gửi lại tay ở Cài đặt API › Lịch sử / hàng đợi tự gửi lại)` : ''}`);
}

if (require.main === module) {
  main()
    .catch((e) => { console.error(`[gui-lai-chuyen] ✗ ${e.message}`); process.exitCode = 1; })
    .finally(() => pool.end().catch(() => {}));
}
