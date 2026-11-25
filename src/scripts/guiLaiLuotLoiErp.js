'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// GỬI LẠI MỌI LƯỢT ERP ĐANG LỖI CỦA 1 KÊNH (25/11/2026 — sự cố 23/11: proc Sh6 thêm `@pBarcode17`, mọi lượt kiểm phẩm lỗi,
//   hàng đợi tự gửi lại đã hết 5 lần). Lượt "đang lỗi" = (kênh, bản ghi) mà lần gửi MỚI NHẤT là `<MÃ>_LOI`, từ ngày `--tu`.
//   Gửi bằng CHÍNH nút "Gửi lại ERP" (`caidatapi/guiLai` — cùng IDMES, thân dựng từ dữ liệu MES hiện tại); lượt đã HỦY xác
//   nhận / đã báo hủy ⇒ guiLai trả 409, script ghi "bỏ qua".
//
// CÁCH CHẠY (MÁY CHỦ production, thư mục backend — SAU khi deploy BE + ERP đã sửa router):
//     node src/scripts/guiLaiLuotLoiErp.js                                  ← XEM THỬ kênh Sh6 từ 2026-11-23
//     node src/scripts/guiLaiLuotLoiErp.js --ma=ERP_GUI_KIEM_PHAM --tu=2026-11-23 --gui     ← GỬI THẬT
//     (--ma: ERP_GHI_IN_TEM · ERP_GUI_KIEM_PHAM · ERP_GUI_SUA_DAT · ERP_GUI_OQC · ERP_GUI_PHAN_LOAI_LOI · ERP_GUI_TEM_GIA_CONG)
// ⚠ Người gửi ghi vào lịch sử = `admin` (`--nguoi=<tên đăng nhập>`). Chạy lại vô hại (cùng IDMES ⇒ ERP ghi đè).
//
// `--tem17` (CHỈ kênh Sh6, 25/11/2026): thay vì lượt lỗi, chọn lượt KCS GIAO TRƯỚC (có tem 17 sống `kcs_tach_id`) mà lần
//   gửi Sh6 mới nhất (thành công hay lỗi) CHƯA mang `Barcode17` = tem 17 đó — thân luật cũ `BarcodeIn` tem 15 không có tem 17
//   (≤ 19/11) hoặc `BarcodeIn` = tem 17 (20/11–25/11) ⇒ gửi lại cùng IDMES theo thân mới (`BarcodeIn` tem 15 + `Barcode17`).
//   Đo 25/11: 48 lượt (14–19/11, BarcodeIn 15) + 33 lượt (20/11, BarcodeIn 17).
//     node src/scripts/guiLaiLuotLoiErp.js --ma=ERP_GUI_KIEM_PHAM --tu=2026-11-01 --tem17          ← XEM THỬ
//     node src/scripts/guiLaiLuotLoiErp.js --ma=ERP_GUI_KIEM_PHAM --tu=2026-11-01 --tem17 --gui    ← GỬI THẬT
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const { query, pool } = require('../config/db');
const { guiLai } = require('../modules/caidatapi/guiLai');

const args = process.argv.slice(2);
const lay = (k, md) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : md; };
const MA = lay('ma', 'ERP_GUI_KIEM_PHAM');
const TU = lay('tu', '2026-11-23');
const NGUOI = lay('nguoi', 'admin');
const GUI = args.includes('--gui');
const TEM17 = args.includes('--tem17');

async function main() {
  if (!/^ERP_[A-Z0-9_]+$/.test(MA) || !/^\d{4}-\d{2}-\d{2}$/.test(TU)) throw new Error('Sai --ma / --tu');
  if (TEM17 && MA !== 'ERP_GUI_KIEM_PHAM') throw new Error('--tem17 chỉ dùng cho --ma=ERP_GUI_KIEM_PHAM');
  console.log(`[gui-lai-loi] Kênh ${MA} từ ${TU}${TEM17 ? ' · lượt Sh6 còn BarcodeIn = tem 17' : ''} · ${GUI ? 'GỬI THẬT' : 'XEM THỬ (thêm --gui để gửi)'}`);
  const cot = `a.id AS audit_id, a.hanh_dong, a.ten_bang, a.id_ban_ghi,
            a.gia_tri_moi->>'ma_tem' AS ma_tem, left(a.gia_tri_moi->>'loi', 120) AS loi,
            a.gia_tri_moi->'gui'->>'BarcodeIn' AS barcode_in, a.gia_tri_moi->'gui'->>'Barcode17' AS barcode_17,
            to_char(a.thoi_gian AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM HH24:MI') AS tg`;
  const { rows } = TEM17
    ? await query(
      `WITH tc AS (SELECT DISTINCT ON (kcs_tach_id) kcs_tach_id::text AS kcs_id, ma_tem FROM tem
                    WHERE kcs_tach_id IS NOT NULL AND trang_thai <> 'HUY' ORDER BY kcs_tach_id, created_date DESC)
       SELECT DISTINCT ON (a.id_ban_ghi) ${cot}, tc.ma_tem AS tem_17
         FROM tc JOIN audit_log a ON a.ten_bang = 'kcs' AND a.id_ban_ghi = tc.kcs_id
        WHERE a.hanh_dong IN ($1::text, $1::text || '_LOI') AND a.thoi_gian >= ($2::date AT TIME ZONE 'Asia/Ho_Chi_Minh')
        ORDER BY a.id_ban_ghi, a.thoi_gian DESC`.replace(/\s+/g, ' '), [MA, TU])
    : await query(
      `SELECT DISTINCT ON (a.ten_bang, a.id_ban_ghi) ${cot}
         FROM audit_log a
        WHERE a.hanh_dong IN ($1::text, $1::text || '_LOI') AND a.thoi_gian >= ($2::date AT TIME ZONE 'Asia/Ho_Chi_Minh')
          AND a.id_ban_ghi IS NOT NULL AND a.id_ban_ghi <> '-'
        ORDER BY a.ten_bang, a.id_ban_ghi, a.thoi_gian DESC`.replace(/\s+/g, ' '), [MA, TU]);
  const loi = TEM17
    ? rows.filter((r) => String(r.barcode_17 || '') !== r.tem_17)
    : rows.filter((r) => r.hanh_dong.endsWith('_LOI'));
  if (!loi.length) { console.log(TEM17 ? 'Không có lượt giao trước nào thiếu Barcode17.' : 'Không có lượt nào đang lỗi.'); return; }
  loi.forEach((r) => console.log(TEM17
    ? `  ${String(r.ma_tem || '').padEnd(14)} ${r.tg}  BarcodeIn ${r.barcode_in} → tem 15 · Barcode17 ${r.tem_17}${r.hanh_dong.endsWith('_LOI') ? ' (đang lỗi)' : ''}`
    : `  ${String(r.ma_tem || '').padEnd(14)} ${r.tg}  ${r.loi || ''}`));
  console.log(`\nTổng ${loi.length} lượt ${TEM17 ? 'giao trước cần gửi lại theo thân mới' : 'đang lỗi'}.`);
  if (!GUI) { console.log('XEM THỬ — chưa gửi gì. Chạy lại với --gui để gửi.'); return; }

  const { rows: nd } = await query('SELECT id FROM nguoi_dung WHERE ten_dang_nhap = $1', [NGUOI]);
  if (!nd.length) throw new Error(`Không tìm thấy tài khoản ${NGUOI}`);
  let ok = 0; let boQua = 0; let hong = 0;
  for (const r of loi) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await guiLai(MA, r.audit_id, nd[0].id);
      ok += 1; console.log(`  ✓ ${r.ma_tem}`);
    } catch (e) {
      if ((e.status || e.statusCode) === 409 || (e.status || e.statusCode) === 404) { boQua += 1; console.log(`  – ${r.ma_tem}: bỏ qua (${e.message})`); } else { hong += 1; console.log(`  ✗ ${r.ma_tem}: ${e.message}`); }
    }
  }
  console.log(`\nXong: thành công ${ok} · bỏ qua ${boQua} (đã hủy / không còn dữ liệu) · còn lỗi ${hong}`);
}

if (require.main === module) {
  main()
    .catch((e) => { console.error(`[gui-lai-loi] ✗ ${e.message}`); process.exitCode = 1; })
    .finally(() => pool.end().catch(() => {}));
}
